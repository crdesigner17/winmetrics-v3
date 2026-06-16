/**
 * WinMetrics V3 — enrich_odds.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Enriquece o objeto `raw` do PackBallMapper com odds externas (The Odds API).
 * Segue exatamente o mesmo padrão do enrichFromWorldCup.js:
 *   - Só preenche campos que estiverem null — nunca sobrescreve dados da API-Football
 *   - Recalcula scores e graus usando fusão PackBall (60%) + mercado externo (40%)
 *   - Fallback silencioso se API falhar ou jogo não for encontrado
 *
 * Campos preenchidos no raw (se null):
 *   odd_o15, odd_o25, odd_u35, odd_u45  → odds externas de gols
 *   odd_btts                             → odd BTTS externa
 *   odd_esc75, odd_esc85                 → odds cantos externas
 *   odd_c25, odd_c35                     → odds cartões externas
 *
 * Campos adicionais no result (após PredictionEngine):
 *   score_*_enriquecido, grau_*_enriquecido → scores/graus com fusão de mercado
 *   odds_fonte                               → 'externa' | 'packball'
 *
 * Uso no generate_predictions.js (após enrichFromWorldCup, antes do engine):
 *   const raw = await enrichOddsExternas(raw, LOG);
 *   const result = PredictionEngine.processFixture(raw);
 *   // Opcional: enriquecer os scores depois do engine:
 *   enrichResultScores(result, raw);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const ODDS_API_KEY  = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// ── Peso da fusão ─────────────────────────────────────────────────
const PESO_PACKBALL = 0.6;
const PESO_MERCADO  = 0.4;

// ── Mapeamento: league_id da API-Football → sport key da Odds API ─
// Adicionar novas competições aqui conforme necessário
const LEAGUE_TO_SPORT_KEY = {
  // ── Confirmados disponíveis no free tier ─────────────────────
  1:   'soccer_fifa_world_cup',                 // FIFA World Cup ✅
  13:  'soccer_conmebol_copa_libertadores',      // Copa Libertadores ✅
  11:  'soccer_conmebol_copa_sudamericana',      // Copa Sudamericana ✅
  72:  'soccer_brazil_serie_b',                 // Brasileirão Série B ✅
  79:  'soccer_germany_dfb_pokal',              // DFB-Pokal (Copa da Alemanha) ✅
  141: 'soccer_spain_segunda_division',         // La Liga 2 ✅
  103: 'soccer_norway_eliteserien',             // Eliteserien ✅
  // ── Outros mapeamentos (podem não estar no free tier) ────────
  2:   'soccer_uefa_champions_league',          // Champions League
  3:   'soccer_uefa_europa_league',             // Europa League
  848: 'soccer_uefa_europa_conference_league',  // Conference League
  39:  'soccer_epl',                            // Premier League
  78:  'soccer_germany_bundesliga',             // Bundesliga
  135: 'soccer_italy_serie_a',                  // Serie A
  140: 'soccer_spain_la_liga',                  // La Liga
  61:  'soccer_france_ligue_one',               // Ligue 1
  94:  'soccer_portugal_primeira_liga',         // Liga Portugal
  88:  'soccer_netherlands_eredivisie',         // Eredivisie
  203: 'soccer_turkey_super_league',            // Super Lig
  960: 'soccer_uefa_nations_league_a',          // UEFA Nations League
};

// Cache em memória por execução (evita chamadas duplicadas por liga)
const _eventosCache = new Map();

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

/**
 * Normaliza nome de time para comparação fuzzy
 * Ex: "Bayern München" → "bayernmunchen"
 */
function _normTeam(nome) {
  if (!nome) return '';
  return nome
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Probabilidade implícita de uma odd decimal
 * Ex: 1.08 → 0.926
 */
function _prob(odd) {
  if (!odd || odd <= 1) return null;
  return parseFloat((1 / odd).toFixed(4));
}

/**
 * Fórmula de fusão: PackBall 60% + mercado externo 40%
 * Só aplica se ambos os valores existirem
 */
function _fusao(scorePackball, oddExterna) {
  const prob = _prob(oddExterna);
  if (prob === null || scorePackball === null || scorePackball === undefined) {
    return scorePackball ?? null;
  }
  return parseFloat(((scorePackball * PESO_PACKBALL) + (prob * PESO_MERCADO)).toFixed(4));
}

/**
 * Converte score (0-1) em grau — mantém thresholds do prediction_engine_v1.js
 * Nota: o engine usa escala 0-100 internamente, mas os scores são 0-100 no result.
 * Aqui usamos escala 0-1 para o score de fusão.
 */
function _grau(score) {
  if (score === null || score === undefined) return null;
  const s = score <= 1 ? score * 100 : score; // normaliza para 0-100
  if (s >= 85) return 'A+';
  if (s >= 70) return 'A';
  if (s >= 55) return 'B';
  if (s >= 40) return 'C';
  return 'D';
}

// ─────────────────────────────────────────────────────────────────
// BUSCA DE EVENTOS NA THE ODDS API
// ─────────────────────────────────────────────────────────────────

/**
 * Busca eventos de um sport key com cache por execução.
 * Retorna array de eventos da Odds API ou [] em caso de falha.
 */
async function _buscarEventos(sportKey, log) {
  if (_eventosCache.has(sportKey)) {
    return _eventosCache.get(sportKey);
  }

  try {
    const url = `${ODDS_API_BASE}/sports/${sportKey}/odds` +
      `?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals,btts&oddsFormat=decimal`;

    const res = await fetch(url);

    // Mostra quota restante
    const remaining = res.headers?.get?.('x-requests-remaining');
    if (remaining) log.dim(`[OddsAPI] ${sportKey} — quota restante: ${remaining}`);

    if (!res.ok) {
      log.warn(`[OddsAPI] Erro ${res.status} para ${sportKey}`);
      _eventosCache.set(sportKey, []);
      return [];
    }

    const data = await res.json();
    const eventos = Array.isArray(data) ? data : [];
    log.dim(`[OddsAPI] ${sportKey}: ${eventos.length} eventos encontrados`);
    _eventosCache.set(sportKey, eventos);
    return eventos;

  } catch (err) {
    log.warn(`[OddsAPI] Falha ao buscar ${sportKey}: ${err.message}`);
    _eventosCache.set(sportKey, []);
    return [];
  }
}

/**
 * Encontra o evento correspondente pelo nome dos times (fuzzy match)
 */
function _encontrarEvento(eventos, homeTeam, awayTeam) {
  const homeNorm = _normTeam(homeTeam);
  const awayNorm = _normTeam(awayTeam);

  return eventos.find(ev => {
    const evHome = _normTeam(ev.home_team);
    const evAway = _normTeam(ev.away_team);

    // Match exato
    if (evHome === homeNorm && evAway === awayNorm) return true;

    // Match parcial (resolve "Germany" vs "Alemanha", "Internazionale" vs "Inter")
    const hMatch = evHome.includes(homeNorm) || homeNorm.includes(evHome);
    const aMatch = evAway.includes(awayNorm) || awayNorm.includes(evAway);
    return hMatch && aMatch;
  });
}

/**
 * Extrai as odds de um evento da Odds API e retorna objeto com os campos
 * exatamente no formato esperado pelo raw do PackBallMapper:
 *   odd_o15, odd_o25, odd_u35, odd_u45
 *   odd_btts
 *   odd_esc75, odd_esc85
 *   odd_c25, odd_c35
 */
function _extrairOdds(evento) {
  const result = {
    odd_o15: null, odd_o25: null,
    odd_u35: null, odd_u45: null,
    odd_btts: null,
    odd_esc75: null, odd_esc85: null,
    odd_c25: null, odd_c35: null,
  };

  if (!evento?.bookmakers?.length) return result;

  // Prioriza bookmakers europeus (id=4 Bet365, id=3 Pinnacle, etc.)
  const bookie = evento.bookmakers.find(b => ['bet365','pinnacle','betway'].some(
    n => b.name?.toLowerCase().includes(n)
  )) || evento.bookmakers[0];

  for (const market of (bookie?.markets || [])) {
    const key = market.key;

    // Over/Under Gols (totals)
    if (key === 'totals') {
      for (const o of market.outcomes) {
        const dir   = o.name?.toLowerCase();
        const ponto = parseFloat(o.point);
        if (dir === 'over') {
          if (ponto === 1.5) result.odd_o15 = parseFloat(o.price);
          if (ponto === 2.5) result.odd_o25 = parseFloat(o.price);
        }
        if (dir === 'under') {
          if (ponto === 3.5) result.odd_u35 = parseFloat(o.price);
          if (ponto === 4.5) result.odd_u45 = parseFloat(o.price);
        }
      }
    }

    // BTTS
    if (key === 'btts') {
      const yes = market.outcomes.find(o => o.name?.toLowerCase() === 'yes');
      if (yes) result.odd_btts = parseFloat(yes.price);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL — enriquecer o raw ANTES do PredictionEngine
// ─────────────────────────────────────────────────────────────────

/**
 * enrichOddsExternas(raw, LOG)
 *
 * Enriquece o objeto `raw` com odds externas da The Odds API.
 * Só preenche campos null — nunca sobrescreve dados existentes da API-Football.
 * Idêntico ao padrão do enrichFromWorldCup.js.
 *
 * @param {object} raw  — objeto PackBall mapeado (mutado in-place)
 * @param {object} LOG  — logger ({ info, dim, warn })
 * @returns {object}    — raw enriquecido (mesma referência)
 */
async function enrichOddsExternas(raw, LOG = {}) {
  const log = {
    info: LOG.info || (() => {}),
    dim:  LOG.dim  || (() => {}),
    warn: LOG.warn || (() => {}),
  };

  // Sem chave → silencioso, retorna raw intacto
  if (!ODDS_API_KEY) {
    log.dim('[OddsAPI] ODDS_API_KEY não configurada — enriquecimento ignorado.');
    return raw;
  }

  const sportKey = LEAGUE_TO_SPORT_KEY[Number(raw.league_id)];
  if (!sportKey) {
    log.dim(`[OddsAPI] Liga ${raw.league_id} não mapeada — pulando enriquecimento.`);
    raw.odds_fonte = 'packball';
    return raw;
  }

  // Busca eventos (com cache)
  const eventos = await _buscarEventos(sportKey, log);
  const evento  = _encontrarEvento(eventos, raw.home_team, raw.away_team);

  if (!evento) {
    log.dim(`[OddsAPI] Jogo não encontrado: "${raw.home_team}" vs "${raw.away_team}" (${sportKey})`);
    raw.odds_fonte = 'packball';
    return raw;
  }

  // Extrai odds do evento encontrado
  const odds = _extrairOdds(evento);

  // Helper: preenche apenas se o campo estiver null (igual ao enrichFromWorldCup)
  const fill = (field, value) => {
    if ((raw[field] === null || raw[field] === undefined) && value !== null) {
      raw[field] = value;
    }
  };

  // Preenche odds no raw — só campos ausentes
  fill('odd_o15',  odds.odd_o15);
  fill('odd_o25',  odds.odd_o25);
  fill('odd_u35',  odds.odd_u35);
  fill('odd_u45',  odds.odd_u45);
  fill('odd_btts', odds.odd_btts);

  // Marca a fonte para log/debug
  raw.odds_fonte = 'externa';

  // Log do que foi preenchido
  const preenchidos = ['odd_o15','odd_o25','odd_u35','odd_u45','odd_btts']
    .filter(f => raw[f] !== null && raw[f] !== undefined)
    .map(f => `${f}=${raw[f]}`);

  log.info(`[OddsAPI] ✅ ${raw.home_team} vs ${raw.away_team} — ${preenchidos.length} odds preenchidas: ${preenchidos.join(' | ')}`);

  return raw;
}

// ─────────────────────────────────────────────────────────────────
// FUNÇÃO SECUNDÁRIA — enriquecer scores APÓS o PredictionEngine
// ─────────────────────────────────────────────────────────────────

/**
 * enrichResultScores(result, raw)
 *
 * Após rodar PredictionEngine.processFixture(raw), aplica a fórmula de fusão
 * aos scores dos mercados que têm odds externas.
 *
 * Adiciona ao result:
 *   result.scores_enriquecidos  → { over15, over25, btts, ... } com fusão aplicada
 *   result.graus_enriquecidos   → { over15, over25, ... } recalculados
 *   result.best_score_enriquecido
 *   result.best_grade_enriquecido
 *
 * NÃO modifica result.scores nem result.grades originais.
 *
 * @param {object} result  — resultado do PredictionEngine
 * @param {object} raw     — raw enriquecido (com odds_fonte)
 * @returns {object}       — result com campos extras (mesma referência)
 */
function enrichResultScores(result, raw) {
  if (raw.odds_fonte !== 'externa') {
    result.scores_enriquecidos = null;
    result.graus_enriquecidos  = null;
    return result;
  }

  // Mapeamento: chave do score no result → campo de odd no raw
  const MKT_ODD_MAP = {
    over15:  raw.odd_o15,
    over25:  raw.odd_o25,
    under35: raw.odd_u35,
    under45: raw.odd_u45,
    btts:    raw.odd_btts,
  };

  const scoresEnriq = {};
  const grausEnriq  = {};

  for (const [mkt, oddExterna] of Object.entries(MKT_ODD_MAP)) {
    const scoreOriginal = result.scores[mkt];
    if (scoreOriginal === null || scoreOriginal === undefined) continue;

    // scores do engine estão em escala 0-100, prob está em 0-1
    // Normaliza: score / 100 para fazer a fusão em 0-1, depois volta para 0-100
    const scoreNorm    = scoreOriginal / 100;
    const scoreFusao   = _fusao(scoreNorm, oddExterna);
    const scoreFinal   = scoreFusao !== null ? Math.round(scoreFusao * 1000) / 10 : scoreOriginal;

    scoresEnriq[mkt] = scoreFinal;
    grausEnriq[mkt]  = _grau(scoreFusao);
  }

  result.scores_enriquecidos = scoresEnriq;
  result.graus_enriquecidos  = grausEnriq;

  // Recalcula best se o mercado best_mkt tiver score enriquecido
  const mktKey = Object.entries({
    over15:'Over 1.5 gols', over25:'Over 2.5 gols',
    btts:'BTTS', under35:'Under 3.5 gols', under45:'Under 4.5 gols',
  }).find(([,v]) => v === result.best_mkt)?.[0];

  if (mktKey && scoresEnriq[mktKey] !== undefined) {
    result.best_score_enriquecido = scoresEnriq[mktKey];
    result.best_grade_enriquecido = grausEnriq[mktKey];
  } else {
    result.best_score_enriquecido = result.best_score;
    result.best_grade_enriquecido = result.best_grade;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────
// LIMPAR CACHE (útil em testes ou runs longos)
// ─────────────────────────────────────────────────────────────────
function clearOddsCache() {
  _eventosCache.clear();
}

module.exports = {
  enrichOddsExternas,
  enrichResultScores,
  clearOddsCache,
  // Exporta helpers para testes unitários
  _normTeam, _prob, _fusao, _grau,
};
