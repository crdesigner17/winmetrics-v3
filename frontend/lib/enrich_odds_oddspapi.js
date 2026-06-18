/**
 * WinMetrics V3 — enrich_odds_oddspapi.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fallback de odds via OddsPapi para ligas não cobertas pela The Odds API
 * (ex: Brasileirão Série B, Série C, Division 2 - Södra Götaland).
 *
 * Fluxo:
 *   1. Busca o tournamentId da liga via /v4/tournaments
 *   2. Busca fixtures + odds do dia via /v4/odds-by-tournaments
 *   3. Faz match fuzzy pelo nome dos times
 *   4. Extrai odds dos mercados: gols, escanteios, cartões
 *
 * Prioridade de bookmaker: betano.bet.br → bet365 → pinnacle → qualquer
 *
 * Integração no generate_predictions.js (já existente):
 *   // Após enrichOddsExternas (The Odds API) — só atua se odds ainda null
 *   raw = await enrichOddsOddspapi(raw, LOG);
 *
 * Campos preenchidos (apenas se null):
 *   odd_o15, odd_o25, odd_u35, odd_u45
 *   odd_btts
 *   odd_esc75, odd_esc85
 *   odd_c25, odd_c35
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const ODDSPAPI_KEY  = process.env.ODDSPAPI_KEY || '';
const ODDSPAPI_BASE = 'https://api.oddspapi.io/v4';

// Delay entre chamadas para respeitar rate limit do free tier (~0.88s)
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Caches por execução ────────────────────────────────────────────────────
const _tournamentsCache = new Map(); // sportId → array de torneios
const _fixturesCache    = new Map(); // tournamentId → array de fixtures com odds
const _marketsCache     = new Map(); // sportId → mapa marketId → { name, handicap }

// ── Mapeamento: league_id API-Football → slug/nome parcial para busca ───────
// Adicionar novas ligas conforme necessário
// Liga IDs → termo de busca no OddsPapi
// Inclui todas as ligas de segunda/terceira divisão e regionais
// onde The Odds API tem cobertura limitada de escanteios/cartões.
const LEAGUE_SEARCH = {
  // ── Brasil ─────────────────────────────────────────────────────────────
  72:  'série b',              // Brasileirão Série B
  73:  'série c',              // Brasileirão Série C
  475: 'copa do nordeste',     // Copa do Nordeste
  474: 'carioca',              // Carioca Série A
  477: 'paulista',             // Paulista A1
  478: 'mineiro',              // Mineiro

  // ── Argentina ──────────────────────────────────────────────────────────
  129: 'primera nacional',     // Primera B Nacional (Segunda divisão Argentina)

  // ── Itália ─────────────────────────────────────────────────────────────
  136: 'serie b',              // Serie B (Itália)

  // ── Inglaterra ─────────────────────────────────────────────────────────
  40:  'championship',         // Championship

  // ── Alemanha ───────────────────────────────────────────────────────────
  79:  'bundesliga 2',         // 2. Bundesliga

  // ── França ─────────────────────────────────────────────────────────────
  62:  'ligue 2',              // Ligue 2

  // ── Holanda ────────────────────────────────────────────────────────────
  119: 'eerste divisie',       // Eerste Divisie

  // ── Portugal ───────────────────────────────────────────────────────────
  94:  'liga portugal',        // Liga Portugal (cobertura parcial)

  // ── Turquia ────────────────────────────────────────────────────────────
  203: 'super lig',            // Süper Lig (cobertura parcial)

  // ── Noruega ────────────────────────────────────────────────────────────
  103: 'eliteserien',          // Eliteserien

  // ── Finlândia ──────────────────────────────────────────────────────────
  244: 'veikkausliiga',        // Veikkausliiga

  // ── Suécia ─────────────────────────────────────────────────────────────
  597: 'södra götaland',       // Division 2 - Södra Götaland

  // ── Outros regionais ───────────────────────────────────────────────────
  207: 'super league',         // Super League (Grécia/Suíça)
  283: 'superliga',            // Superliga (Dinamarca)
  197: 'hnl',                  // 1. HNL (Croácia)
  307: 'pro league',           // Pro League (Bélgica - cobertura parcial)
};

// Bookmakers em ordem de prioridade (betano BR primeiro)
const BOOKMAKER_PRIORITY = ['betano.bet.br', 'bet365', 'pinnacle', 'unibet', 'bwin'];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _normTeam(nome) {
  if (!nome) return '';
  return nome.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function _normLeague(nome) {
  if (!nome) return '';
  return nome.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function _apiFetch(endpoint, params = {}, log) {
  const url = new URL(ODDSPAPI_BASE + endpoint);
  url.searchParams.set('apiKey', ODDSPAPI_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      log.warn(`[OddsPapi] HTTP ${res.status} — ${endpoint}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    log.warn(`[OddsPapi] Erro em ${endpoint}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. BUSCAR CATÁLOGO DE MERCADOS (para mapear IDs numéricos)
// ─────────────────────────────────────────────────────────────────────────────

async function _getMarketsMap(sportId, log) {
  const key = String(sportId);
  if (_marketsCache.has(key)) return _marketsCache.get(key);

  const data = await _apiFetch('/markets', { sportId }, log);
  if (!Array.isArray(data)) {
    _marketsCache.set(key, {});
    return {};
  }

  // { marketId: { name, handicap } }
  const map = {};
  data.forEach(m => {
    if (m.marketId) {
      map[String(m.marketId)] = {
        name:     (m.marketName || '').toLowerCase(),
        handicap: m.handicap ?? null,
      };
    }
  });

  _marketsCache.set(key, map);
  log.dim(`[OddsPapi] Catálogo: ${Object.keys(map).length} mercados para sportId=${sportId}`);
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. BUSCAR TORNEIO POR NOME PARCIAL
// ─────────────────────────────────────────────────────────────────────────────

async function _findTournamentId(leagueSearchTerm, log) {
  const cacheKey = 'soccer';
  let tournaments = _tournamentsCache.get(cacheKey);

  if (!tournaments) {
    tournaments = await _apiFetch('/tournaments', { sportId: 10 }, log);
    if (!Array.isArray(tournaments)) tournaments = [];
    _tournamentsCache.set(cacheKey, tournaments);
    log.dim(`[OddsPapi] Torneios carregados: ${tournaments.length}`);
  }

  const term = _normLeague(leagueSearchTerm);
  const match = tournaments.find(t =>
    _normLeague(t.tournamentName || '').includes(term) ||
    _normLeague(t.tournamentSlug || '').includes(term)
  );

  return match?.tournamentId ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. BUSCAR FIXTURES + ODDS DO TORNEIO
// ─────────────────────────────────────────────────────────────────────────────

async function _getFixtures(tournamentId, log) {
  const key = String(tournamentId);
  if (_fixturesCache.has(key)) return _fixturesCache.get(key);

  // Busca usando betano.bet.br como bookmaker principal
  // Fallback automático: a API retorna qualquer bookmaker disponível
  const data = await _apiFetch('/odds-by-tournaments', {
    bookmaker:     'betano.bet.br',
    tournamentIds: tournamentId,
    oddsFormat:    'decimal',
  }, log);

  const fixtures = Array.isArray(data) ? data : [];
  _fixturesCache.set(key, fixtures);
  log.dim(`[OddsPapi] Fixtures tournamentId=${tournamentId}: ${fixtures.length} encontrados`);
  return fixtures;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ENCONTRAR FIXTURE PELO NOME DOS TIMES (fuzzy match)
// ─────────────────────────────────────────────────────────────────────────────

function _findFixture(fixtures, homeTeam, awayTeam) {
  const homeNorm = _normTeam(homeTeam);
  const awayNorm = _normTeam(awayTeam);

  return fixtures.find(fx => {
    const p1 = _normTeam(fx.participant1Name || '');
    const p2 = _normTeam(fx.participant2Name || '');

    const exactMatch = (p1 === homeNorm && p2 === awayNorm);
    if (exactMatch) return true;

    const partialH = p1.includes(homeNorm) || homeNorm.includes(p1);
    const partialA = p2.includes(awayNorm) || awayNorm.includes(p2);
    return partialH && partialA;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. EXTRAIR ODDS DO FIXTURE
// ─────────────────────────────────────────────────────────────────────────────

function _extractPrice(markets, marketId) {
  try {
    const market = markets[String(marketId)];
    if (!market) return null;
    // Outcomes: para Over/Under o over é geralmente o primeiro outcome
    const outcomes = market.outcomes || {};
    const outcomeIds = Object.keys(outcomes);
    if (!outcomeIds.length) return null;

    // Para mercados com 2 outcomes (Over/Under), retorna o 'over' (menor ID = over geralmente)
    // mas validamos pelo bookmakerOutcomeId
    for (const oid of outcomeIds) {
      const players = outcomes[oid]?.players?.['0'];
      if (players?.active && players?.price) {
        const label = (players.bookmakerOutcomeId || '').toLowerCase();
        if (label === 'over' || label === 'yes' || label === 'home') {
          return parseFloat(players.price);
        }
      }
    }
    // Fallback: primeiro outcome ativo
    for (const oid of outcomeIds) {
      const players = outcomes[oid]?.players?.['0'];
      if (players?.active && players?.price) return parseFloat(players.price);
    }
    return null;
  } catch {
    return null;
  }
}

function _extractUnderPrice(markets, marketId) {
  try {
    const market = markets[String(marketId)];
    if (!market) return null;
    const outcomes = market.outcomes || {};

    for (const oid of Object.keys(outcomes)) {
      const players = outcomes[oid]?.players?.['0'];
      if (players?.active && players?.price) {
        const label = (players.bookmakerOutcomeId || '').toLowerCase();
        if (label === 'under' || label === 'no' || label === 'away') {
          return parseFloat(players.price);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Encontra o bookmaker com maior prioridade disponível no fixture
 */
function _getBestBookmaker(bookmakerOdds) {
  for (const slug of BOOKMAKER_PRIORITY) {
    if (bookmakerOdds[slug]?.markets) return bookmakerOdds[slug].markets;
  }
  // Fallback: qualquer bookmaker disponível
  const anySlug = Object.keys(bookmakerOdds)[0];
  return anySlug ? bookmakerOdds[anySlug]?.markets : null;
}

/**
 * Extrai todas as odds relevantes do fixture usando o catálogo de mercados.
 * Retorna objeto com campos no formato do raw do WinMetrics.
 */
function _extractOdds(fixture, marketsMap) {
  const result = {
    odd_o15: null, odd_o25: null,
    odd_u35: null, odd_u45: null,
    odd_btts: null,
    odd_esc75: null, odd_esc85: null,
    odd_c25:  null, odd_c35:  null,
  };

  const bookmakerOdds = fixture.bookmakerOdds || {};
  const markets = _getBestBookmaker(bookmakerOdds);
  if (!markets) return result;

  // Varre todos os market IDs disponíveis e mapeia pelo catálogo
  for (const [mid, market] of Object.entries(markets)) {
    const info = marketsMap[mid];
    if (!info) continue;

    const name = info.name;
    const hc   = info.handicap;

    // ── Gols Over ─────────────────────────────────────────────────────────
    if ((name.includes('over') || name.includes('total')) && name.includes('goal')) {
      if (hc === 1.5) result.odd_o15 = _extractPrice(markets, mid);
      if (hc === 2.5) result.odd_o25 = _extractPrice(markets, mid);
    }

    // ── Gols Under ────────────────────────────────────────────────────────
    if ((name.includes('under') || name.includes('total')) && name.includes('goal')) {
      if (hc === 3.5) result.odd_u35 = _extractUnderPrice(markets, mid);
      if (hc === 4.5) result.odd_u45 = _extractUnderPrice(markets, mid);
    }

    // ── BTTS ──────────────────────────────────────────────────────────────
    if (name.includes('both') && name.includes('score')) {
      result.odd_btts = _extractPrice(markets, mid);
    }

    // ── Escanteios ────────────────────────────────────────────────────────
    if (name.includes('corner')) {
      if (hc === 7.5) result.odd_esc75 = _extractPrice(markets, mid);
      if (hc === 8.5) result.odd_esc85 = _extractPrice(markets, mid);
    }

    // ── Cartões ───────────────────────────────────────────────────────────
    if (name.includes('card') || name.includes('booking')) {
      if (hc === 2.5) result.odd_c25 = _extractPrice(markets, mid);
      if (hc === 3.5) result.odd_c35 = _extractPrice(markets, mid);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL — enrichOddsOddspapi
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enriquece o raw com odds da OddsPapi como fallback.
 * Só preenche campos que ainda estão null após enrichOddsExternas.
 * Só atua em ligas configuradas em LEAGUE_SEARCH.
 *
 * @param {object} raw — objeto PackBall mapeado (mutado in-place)
 * @param {object} LOG — logger ({ info, dim, warn })
 * @returns {object} — raw enriquecido
 */
async function enrichOddsOddspapi(raw, LOG = {}) {
  const log = {
    info: LOG.info || (() => {}),
    dim:  LOG.dim  || (() => {}),
    warn: LOG.warn || (() => {}),
  };

  // Sem chave → silencioso
  if (!ODDSPAPI_KEY) {
    log.dim('[OddsPapi] ODDSPAPI_KEY não configurada — fallback ignorado.');
    return raw;
  }

  // Liga não mapeada → pula
  const leagueSearchTerm = LEAGUE_SEARCH[Number(raw.league_id)];
  if (!leagueSearchTerm) return raw;

  // Verifica se já tem odds suficientes (pelo menos 3 campos preenchidos)
  const oddFields = ['odd_o15','odd_o25','odd_u35','odd_u45','odd_btts','odd_esc75','odd_esc85','odd_c25','odd_c35'];
  const filledCount = oddFields.filter(f => raw[f] !== null && raw[f] !== undefined).length;
  if (filledCount >= 5) {
    log.dim(`[OddsPapi] ${raw.home_team} — já tem ${filledCount} odds, pulando fallback.`);
    return raw;
  }

  try {
    // 1. Busca catálogo de mercados
    const marketsMap = await _getMarketsMap(10, log);
    await delay(300);

    // 2. Encontra tournamentId
    const tournamentId = await _findTournamentId(leagueSearchTerm, log);
    if (!tournamentId) {
      log.dim(`[OddsPapi] Torneio não encontrado para: "${leagueSearchTerm}"`);
      return raw;
    }
    await delay(300);

    // 3. Busca fixtures
    const fixtures = await _getFixtures(tournamentId, log);
    if (!fixtures.length) {
      log.dim(`[OddsPapi] Nenhum fixture para tournamentId=${tournamentId}`);
      return raw;
    }

    // 4. Encontra o jogo
    const fixture = _findFixture(fixtures, raw.home_team, raw.away_team);
    if (!fixture) {
      log.dim(`[OddsPapi] Jogo não encontrado: "${raw.home_team}" vs "${raw.away_team}"`);
      return raw;
    }

    // 5. Extrai odds
    const odds = _extractOdds(fixture, marketsMap);

    // 6. Preenche apenas campos null
    const fill = (field, value) => {
      if ((raw[field] === null || raw[field] === undefined) && value !== null && value > 1) {
        raw[field] = value;
      }
    };

    fill('odd_o15',   odds.odd_o15);
    fill('odd_o25',   odds.odd_o25);
    fill('odd_u35',   odds.odd_u35);
    fill('odd_u45',   odds.odd_u45);
    fill('odd_btts',  odds.odd_btts);
    fill('odd_esc75', odds.odd_esc75);
    fill('odd_esc85', odds.odd_esc85);
    fill('odd_c25',   odds.odd_c25);
    fill('odd_c35',   odds.odd_c35);

    raw.odds_fonte = 'oddspapi';

    const preenchidos = oddFields
      .filter(f => raw[f] !== null && raw[f] !== undefined)
      .map(f => `${f}=${raw[f]}`);

    log.info(`[OddsPapi] ✅ ${raw.home_team} vs ${raw.away_team} — ${preenchidos.length} odds: ${preenchidos.join(' | ')}`);

  } catch (err) {
    log.warn(`[OddsPapi] Erro ao enriquecer ${raw.home_team}: ${err.message}`);
  }

  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIMPAR CACHES
// ─────────────────────────────────────────────────────────────────────────────
function clearOddspapiCache() {
  _tournamentsCache.clear();
  _fixturesCache.clear();
  _marketsCache.clear();
}

module.exports = {
  enrichOddsOddspapi,
  clearOddspapiCache,
  LEAGUE_SEARCH,
};
