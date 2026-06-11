#!/usr/bin/env node
/**
 * WinMetrics Analytics — Generate Predictions
 * ─────────────────────────────────────────────
 * Pipeline de geração de previsões reais.
 * Implementação fiel ao coletar.py do PackBall v3.0 (seções 2–7).
 *
 * Fluxo:
 *   1. Buscar fixtures do dia nas ligas suportadas
 *   2. Coletar dados da API-Football (5 chamadas paralelas por jogo)
 *   3. Mapear → PackBallMapper.mapFixtureToPackBall()
 *   4. Calcular → PredictionEngine.processFixture()
 *   5. Salvar → fixtures, match_metrics, odds, predictions, prediction_snapshots
 *   6. Log detalhado por fixture
 *
 * Uso:
 *   node generate_predictions.js [--date YYYY-MM-DD] [--days N] [--dry-run] [--force] [--only-new] [--limit N]
 *
 * Exemplos econômicos:
 *   node generate_predictions.js --days=3 --only-new --dry-run
 *   node generate_predictions.js --days=3 --only-new
 *   node generate_predictions.js --date=2026-06-10 --force
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL          — URL do projeto Supabase
 *   SUPABASE_SERVICE_KEY  — service_role key (bypass RLS)
 *   API_FOOTBALL_KEY      — chave da API-Football v3
 *
 * Dependências (package.json):
 *   @supabase/supabase-js ^2
 *   node-fetch ^3   (ou Node 18+ nativo)
 */

'use strict';

// ─────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────

const path  = require('path');
const { createClient } = require('@supabase/supabase-js');

// Carrega os módulos locais relativos a este arquivo
const PredictionEngine       = require('../lib/prediction_engine_v1.js');
const PackBallMapper         = require('../lib/packball_mapper.js');
const AltLineResolver        = require('../lib/alternative_line_resolver.js');


// ─────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────────

const SUPABASE_URL  = process.env.SUPABASE_URL         || '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';
const API_KEY       = process.env.API_FOOTBALL_KEY     || '';
const API_BASE      = 'https://v3.football.api-sports.io';

// Flags de execução
const args      = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const FORCE     = args.includes('--force');
const ONLY_NEW  = args.includes('--only-new');
const MOCK_TO_SUPABASE = args.includes('--mock-to-supabase');
const dateArg   = args.find(a => a.startsWith('--date='))?.split('=')[1];
const daysArg   = args.find(a => a.startsWith('--days='))?.split('=')[1];
const limitArg  = args.find(a => a.startsWith('--limit='))?.split('=')[1];
const TODAY     = dateArg || new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
const DAYS      = Math.max(1, Math.min(14, parseInt(daysArg || '1', 10) || 1));
const LIMIT     = limitArg ? Math.max(1, parseInt(limitArg, 10) || 1) : null;

// Ligas suportadas (§2.2)
const LIGAS = [
  // ── Tier elite ────────────────────────────────────────────────
  { id: 2,   season: 2025, name: 'Champions League',          tier: 'elite'  },
  { id: 3,   season: 2025, name: 'UEFA Europa League',        tier: 'elite'  },
  { id: 39,  season: 2025, name: 'Premier League',            tier: 'elite'  },
  { id: 140, season: 2025, name: 'La Liga',                   tier: 'elite'  },
  { id: 135, season: 2025, name: 'Serie A',                   tier: 'elite'  },
  { id: 78,  season: 2025, name: 'Bundesliga',                tier: 'elite'  },
  { id: 61,  season: 2025, name: 'Ligue 1',                   tier: 'elite'  },
  { id: 13,  season: 2026, name: 'Copa Libertadores',         tier: 'elite'  },
  { id: 1,   season: 2026, name: 'FIFA World Cup',            tier: 'elite'  },
  { id: 15,  season: 2025, name: 'FIFA Club World Cup',       tier: 'elite'  },
  // ── Tier normal — Europa ──────────────────────────────────────
  { id: 848, season: 2025, name: 'UEFA Europa Conference League', tier: 'normal' },
  { id: 40,  season: 2025, name: 'Championship',              tier: 'normal' },
  { id: 141, season: 2025, name: 'La Liga 2',                 tier: 'normal' },
  { id: 79,  season: 2025, name: '2. Bundesliga',             tier: 'normal' },
  { id: 62,  season: 2025, name: 'Ligue 2',                   tier: 'normal' },
  { id: 88,  season: 2025, name: 'Eredivisie',                tier: 'normal' },
  { id: 119, season: 2025, name: 'Eerste Divisie',            tier: 'normal' },
  { id: 94,  season: 2025, name: 'Liga Portugal',             tier: 'normal' },
  { id: 207, season: 2025, name: 'Super League',              tier: 'normal' },
  { id: 203, season: 2025, name: 'Super Lig',                 tier: 'normal' },
  { id: 283, season: 2025, name: 'Superliga',                 tier: 'normal' },
  { id: 197, season: 2025, name: '1. HNL',                    tier: 'normal' },
  { id: 103, season: 2026, name: 'Eliteserien',               tier: 'normal' },
  { id: 307, season: 2025, name: 'Pro League',                tier: 'normal' },
  { id: 323, season: 2024, name: 'Euro Qualification',        tier: 'normal' },
  // ── Tier normal — Américas ────────────────────────────────────
  { id: 11,  season: 2026, name: 'Copa Sudamericana',         tier: 'normal' },
  { id: 9,   season: 2024, name: 'Copa America',              tier: 'normal' },
  { id: 71,  season: 2026, name: 'Brasileirão Série A',       tier: 'normal' },
  { id: 72,  season: 2026, name: 'Brasileirão Série B',       tier: 'normal' },
  { id: 75,  season: 2026, name: 'Copa do Brasil',            tier: 'normal' },
  { id: 73,  season: 2026, name: 'Brasileirão Série C',       tier: 'normal' },
  { id: 475, season: 2026, name: 'Copa do Nordeste',          tier: 'normal' },
  { id: 474, season: 2026, name: 'Carioca Serie A',           tier: 'normal' },
  { id: 477, season: 2026, name: 'Paulista A1',               tier: 'normal' },
  { id: 478, season: 2026, name: 'Mineiro 1',                 tier: 'normal' },
  { id: 128, season: 2026, name: 'Liga Profesional de Fútbol', tier: 'normal' },
  { id: 136, season: 2025, name: 'Serie B',                   tier: 'normal' },
  // ── Tier normal — Mundial / Amistosos ─────────────────────────
  { id: 10,  season: 2026, name: 'Friendlies',                tier: 'normal' },
  { id: 960, season: 2025, name: 'UEFA Nations League',       tier: 'normal' },
];

// Status de jogo aceitos §2.3
const VALID_STATUS = new Set(['NS','1H','HT','2H','ET','P','LIVE','FT','AET','PEN']);

// Termos que bloqueiam jogos sub-20/21 §2.3
const BLOCKED_TERMS = [
  'women','womens','feminino','feminina','femenino','femenina',
  'ladies','frauenliga','wpsl','nwsl',
  'u17','u18','u19','u20','u21','u23',
  'u-17','u-18','u-19','u-20','u-21','u-23',
  'under 17','under 18','under 19','under 20','under 21','under 23',
  'under-17','under-18','under-19','under-20','under-21','under-23',
  'youth','academy','reserve','reserves','reserva','amateur',
];

// Grades que geram snapshot (§7.1)
const GRADES_OFICIAIS = new Set(['A+', 'A']);

// Bilhete do dia: grade A+ E score >= 90 (§7.2)
const TICKET_DIA_MIN_SCORE = 90;


// ─────────────────────────────────────────────────────────────────
// CLIENTES
// ─────────────────────────────────────────────────────────────────

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    })
  : null;


// ─────────────────────────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────────────────────────

const LOG = {
  _ts:   () => new Date().toISOString().replace('T', ' ').slice(0, 19),
  info:  (...a) => console.log (`\x1b[36m[INFO]\x1b[0m  ${LOG._ts()} `, ...a),
  ok:    (...a) => console.log (`\x1b[32m[ OK ]\x1b[0m  ${LOG._ts()} `, ...a),
  warn:  (...a) => console.warn(`\x1b[33m[WARN]\x1b[0m  ${LOG._ts()} `, ...a),
  error: (...a) => console.error(`\x1b[31m[ERR ]\x1b[0m  ${LOG._ts()} `, ...a),
  dim:   (...a) => console.log (`\x1b[90m[    ]\x1b[0m  ${LOG._ts()} `, ...a),
};


// ─────────────────────────────────────────────────────────────────
// API-FOOTBALL — chamada base com retry
// ─────────────────────────────────────────────────────────────────

/**
 * apiFetch(endpoint, params, retries)
 * Chamada à API-Football com headers corretos e retry em rate limit.
 *
 * @param {string} endpoint  — ex: '/fixtures'
 * @param {object} params    — query params
 * @param {number} retries   — tentativas restantes
 * @returns {object}         — { response: [...], errors: [...] }
 */
// Erro especial para quota esgotada — capturado pelo run() para exit limpo
class QuotaExceededError extends Error {
  constructor() { super('QUOTA_EXCEEDED'); this.code = 'QUOTA_EXCEEDED'; }
}

async function apiFetch(endpoint, params = {}, retries = 3) {
  const url  = new URL(API_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: {
          'x-rapidapi-key':  API_KEY,
          'x-rapidapi-host': 'v3.football.api-sports.io',
        },
      });

      // Rate limit: aguarda e tenta de novo
      if (res.status === 429) {
        const wait = Math.pow(2, attempt) * 1000;
        LOG.warn(`Rate limit em ${endpoint} — aguardando ${wait}ms...`);
        await delay(wait);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const json = await res.json();

      // Quota diária esgotada — API retorna errors com "requests" ou status 499
      // Header x-ratelimit-requests-remaining = 0 também indica quota zero
      const remaining = res.headers?.get?.('x-ratelimit-requests-remaining');
      const apiErrors = Array.isArray(json?.errors)
        ? json.errors
        : Object.values(json?.errors || {});
      const quotaError = apiErrors.some(e =>
        typeof e === 'string' && /limit|quota|exceeded|subscribe|upgrade/i.test(e)
      );
      if (quotaError || remaining === '0') {
        LOG.error(`Quota da API esgotada em ${endpoint}. Encerrando pipeline.`);
        throw new QuotaExceededError();
      }

      return json;

    } catch (err) {
      if (err instanceof QuotaExceededError) throw err;  // propaga imediatamente
      lastErr = err;
      if (attempt < retries) {
        await delay(1000 * attempt);
      }
    }
  }

  LOG.error(`apiFetch falhou após ${retries} tentativas: ${endpoint}`, lastErr?.message);
  return { response: [], errors: [lastErr?.message] };
}

const delay = ms => new Promise(r => setTimeout(r, ms));

function addDaysISO(dateISO, days) {
  const d = new Date(dateISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getTargetDates() {
  return Array.from({ length: DAYS }, (_, i) => addDaysISO(TODAY, i));
}

function hoursAgo(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 36e5;
}

/**
 * shouldSkipFixture(entry)
 * Estratégia de economia da API:
 * - roda apenas quando --only-new está ativo, existe Supabase e não está em --force
 * - se já existe snapshot e status não mudou, pula
 * - se já houve predictions nas últimas 6h, pula
 */
async function shouldSkipFixture(entry) {
  if (!ONLY_NEW || FORCE || !supabase) {
    return { skip: false, reason: null, savedCalls: 0 };
  }

  const fixtureId = entry.fixture?.fixture?.id;
  const currentStatus = entry.fixture?.fixture?.status?.short || 'NS';

  if (!fixtureId) return { skip: false, reason: null, savedCalls: 0 };

  const [{ data: fixtureRow }, { data: snapshots }, { data: lastPred }] = await Promise.all([
    supabase
      .from('fixtures')
      .select('fixture_id,status,updated_at')
      .eq('fixture_id', fixtureId)
      .maybeSingle(),
    supabase
      .from('prediction_snapshots')
      .select('id,result_status,created_at')
      .eq('fixture_id', fixtureId)
      .limit(1),
    supabase
      .from('predictions')
      .select('created_at')
      .eq('fixture_id', fixtureId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const hasSnapshot = Array.isArray(snapshots) && snapshots.length > 0;
  const statusUnchanged = fixtureRow?.status === currentStatus;

  if (hasSnapshot && statusUnchanged) {
    return {
      skip: true,
      reason: 'snapshot existente + status sem mudança',
      savedCalls: 7,
    };
  }

  if (lastPred?.created_at && hoursAgo(lastPred.created_at) < 6) {
    return {
      skip: true,
      reason: `predictions atualizadas há ${hoursAgo(lastPred.created_at).toFixed(1)}h`,
      savedCalls: 7,
    };
  }

  return { skip: false, reason: null, savedCalls: 0 };
}



// ─────────────────────────────────────────────────────────────────
// FASE 1 — BUSCAR FIXTURES DO DIA
// ─────────────────────────────────────────────────────────────────

/**
 * blockedName(name)
 * Retorna true se o nome do jogo contiver termos de sub-20/21 (§2.3).
 */
function blockedName(name) {
  if (!name) return false;
  const upper = name.toUpperCase();
  return BLOCKED_TERMS.some(t => upper.includes(t.toUpperCase()));
}

/**
 * fetchTodayFixtures()
 * Busca todos os fixtures do dia em todas as ligas suportadas.
 * Filtra por status e blocked_name.
 *
 * @returns {Array} lista de fixtures com metadados da liga
 */
async function fetchTodayFixtures() {
  const targetDates = getTargetDates();
  LOG.info(`Buscando fixtures para ${targetDates.join(', ')}...`);

  const allFixtures = [];

  // Busca por data e por liga. Lotes pequenos reduzem risco de rate limit.
  const BATCH = 5;

  for (const targetDate of targetDates) {
    LOG.info(`Data ${targetDate}: consultando ${LIGAS.length} ligas...`);

    for (let i = 0; i < LIGAS.length; i += BATCH) {
      const batch = LIGAS.slice(i, i + BATCH);

      const results = await Promise.all(
        batch.map(liga =>
          apiFetch('/fixtures', {
            league: liga.id,
            season: liga.season,
            date:   targetDate,
          }).then(data => ({ liga, data, targetDate }))
        )
      );

      for (const { liga, data, targetDate } of results) {
        const fixtures = data?.response || [];
        LOG.dim(`  ${targetDate} · ${liga.name}: ${fixtures.length} fixture(s)`);

        for (const fx of fixtures) {
          const homeName = fx?.teams?.home?.name || '';
          const awayName = fx?.teams?.away?.name || '';
          const matchName = `${homeName} vs ${awayName}`;
          const status   = fx?.fixture?.status?.short || '';

          // Filtros §2.3
          if (!VALID_STATUS.has(status))       continue;
          if (blockedName(matchName))          continue;
          if (blockedName(liga.name))          continue;

          allFixtures.push({
            fixture: fx,
            liga,
            targetDate,
          });
        }
      }

      // Pausa entre lotes
      if (i + BATCH < LIGAS.length) await delay(300);
    }
  }

  if (LIMIT && allFixtures.length > LIMIT) {
    LOG.warn(`Aplicando --limit=${LIMIT}: ${allFixtures.length} → ${LIMIT} fixtures.`);
    allFixtures.length = LIMIT;
  }

  LOG.info(`Total: ${allFixtures.length} fixtures válidas encontradas.`);
  return allFixtures;
}


// ─────────────────────────────────────────────────────────────────
// FASE 2 — COLETAR DADOS COMPLETOS POR FIXTURE
// ─────────────────────────────────────────────────────────────────

/**
 * fetchAllData(fixtureEntry)
 * Executa até 7 chamadas paralelas para um único fixture.
 * Retorna o objeto apiData esperado pelo PackBallMapper.
 *
 * @param {{ fixture, liga }} fixtureEntry
 * @returns {object} apiData
 */
async function enrichGamesWithStatistics(games, maxGames = 10) {
  const list = (games || []).slice(0, maxGames);
  const enriched = [];

  for (const game of list) {
    const fixtureId = game?.fixture?.id;

    if (!fixtureId) {
      enriched.push(game);
      continue;
    }

    const statsRaw = await apiFetch('/fixtures/statistics', {
      fixture: fixtureId,
    });

    enriched.push({
      ...game,
      statistics: statsRaw?.response || [],
    });

    // Pequena pausa para reduzir risco de rate limit ao enriquecer jogos históricos.
    await delay(120);
  }

  return enriched;
}

async function fetchAllData({ fixture, liga }) {
  const fixtureId = fixture?.fixture?.id;
  const homeId    = fixture?.teams?.home?.id;
  const awayId    = fixture?.teams?.away?.id;
  const leagueId  = liga.id;
  const season    = liga.season;

  const [
    homeStats,
    awayStats,
    homeGamesRaw,
    awayGamesRaw,
    h2hRaw,
    predictionsRaw,
  ] = await Promise.all([
    // /teams/statistics (home)
    apiFetch('/teams/statistics', { team: homeId, league: leagueId, season }),
    // /teams/statistics (away)
    apiFetch('/teams/statistics', { team: awayId, league: leagueId, season }),
    // /fixtures?team=home&last=10
    apiFetch('/fixtures', { team: homeId, last: 10, status: 'FT' }),
    // /fixtures?team=away&last=10
    apiFetch('/fixtures', { team: awayId, last: 10, status: 'FT' }),
    // /fixtures/headtohead
    apiFetch('/fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: 10 }),
    // /predictions
    apiFetch('/predictions', { fixture: fixtureId }),
  ]);

  // ── Odds com fallback real ────────────────────────────────
  // Tentativa 1: bookmaker=6 (Bet365)
  let oddsRaw = await apiFetch('/odds', { fixture: fixtureId, bookmaker: 6 });
  const hasOdds1 = Array.isArray(oddsRaw?.response) && oddsRaw.response.length > 0;

  if (!hasOdds1) {
    LOG.dim(`  Odds bookmaker=6 vazias para fixture ${fixtureId} — tentando sem filtro de bookmaker...`);
    // Tentativa 2: qualquer bookmaker
    oddsRaw = await apiFetch('/odds', { fixture: fixtureId });
    const hasOdds2 = Array.isArray(oddsRaw?.response) && oddsRaw.response.length > 0;

    if (!hasOdds2) {
      LOG.dim(`  Odds indisponíveis para este fixture — odd=null ev=null`);
      oddsRaw = { response: [] };  // garante estrutura válida, não quebra pipeline
    } else {
      const bms = oddsRaw.response.flatMap(i => i?.bookmakers || []);
      const names = [...new Set(bms.map(b => `${b.name}(${b.id})`))].join(', ');
      LOG.dim(`  Odds via fallback — bookmakers: ${names}`);
    }
  }

  // ── ODDS AUDIT ────────────────────────────────────────────
  (function auditOdds() {
    const resp = oddsRaw?.response;
    console.log('\n╔══════════════════════════════════════════════════════');
    console.log(`║ ODDS AUDIT — fixture ${fixtureId}`);
    console.log('╠══════════════════════════════════════════════════════');
    console.log(`║ URL chamada: GET /odds?fixture=${fixtureId}&bookmaker=6`);
    console.log(`║ oddsRaw keys: ${oddsRaw ? Object.keys(oddsRaw).join(', ') : 'null'}`);

    if (!resp) {
      console.log('║ response: AUSENTE (oddsRaw.response = undefined)');
      console.log('╚══════════════════════════════════════════════════════\n');
      return;
    }

    if (!Array.isArray(resp) || resp.length === 0) {
      console.log(`║ response.length: ${Array.isArray(resp) ? 0 : '(não é array) ' + typeof resp}`);
      console.log('║ ⚠  RESPONSE VAZIO — API não retornou odds para este fixture');
      console.log('╚══════════════════════════════════════════════════════\n');
      return;
    }

    console.log(`║ response.length: ${resp.length}`);

    resp.forEach((item, idx) => {
      const bms = item?.bookmakers || [];
      console.log(`║ response[${idx}].bookmakers.length: ${bms.length}`);

      if (bms.length === 0) {
        console.log(`║   ⚠  Nenhum bookmaker em response[${idx}]`);
        return;
      }

      bms.forEach(bm => {
        const bets = bm?.bets || [];
        console.log(`║   Bookmaker: ${bm.name} (id=${bm.id})  bets.length=${bets.length}`);

        bets.forEach(bet => {
          const vals = bet?.values || [];
          console.log(`║     Market: "${bet.name}"  values.length=${vals.length}`);
          vals.forEach(v => {
            console.log(`║       value="${v.value}"  odd=${v.odd}`);
          });
        });
      });
    });

    // ── Mostrar qual bookmaker seria selecionado e por quê ──
    const allBms = resp.flatMap(i => i?.bookmakers || []);
    const bm6 = allBms.find(b => Number(b.id) === 6);
    const chosen = bm6 || (allBms.length > 0
      ? allBms.reduce((best, bm) => (bm.bets?.length||0) > (best.bets?.length||0) ? bm : best, allBms[0])
      : null);

    console.log('╠══════════════════════════════════════════════════════');
    if (!chosen) {
      console.log('║ ⚠  Nenhum bookmaker válido encontrado → todas odds null');
    } else {
      console.log(`║ Bookmaker SELECIONADO: ${chosen.name} (id=${chosen.id})${bm6 ? ' [id=6 encontrado]' : ' [FALLBACK — id=6 ausente]'}`);
      const bets = chosen.bets || [];

      // ── Cross-reference: expected markets vs found ──
      const EXPECTED = [
        { label: 'Over 1.5',   marketHints: ['Goals Over/Under','Total Goals','Match Goals','Over/Under'], value: 'Over 1.5'  },
        { label: 'Over 2.5',   marketHints: ['Goals Over/Under','Total Goals','Match Goals','Over/Under'], value: 'Over 2.5'  },
        { label: 'Under 3.5',  marketHints: ['Goals Over/Under','Total Goals','Match Goals','Over/Under'], value: 'Under 3.5' },
        { label: 'Under 4.5',  marketHints: ['Goals Over/Under','Total Goals','Match Goals','Over/Under'], value: 'Under 4.5' },
        { label: 'BTTS',       marketHints: ['Both Teams Score','Both Teams To Score','BTTS'],              value: 'Yes'       },
        { label: 'Esc Over 7.5',marketHints: ['Asian Corners','Total Corners','Corners Over/Under','Corner Line'], value: 'Over 7.5' },
        { label: 'Esc Over 8.5',marketHints: ['Asian Corners','Total Corners','Corners Over/Under','Corner Line'], value: 'Over 8.5' },
        { label: 'Cart Over 2.5',marketHints: ['Total Cards','Booking Points','Cards Over/Under','Total Bookings'], value: 'Over 2.5' },
        { label: 'Cart Over 3.5',marketHints: ['Total Cards','Booking Points','Cards Over/Under','Total Bookings'], value: 'Over 3.5' },
      ];

      console.log('╠══════════════════════════════════════════════════════');
      console.log('║ CROSS-REFERENCE: esperado → encontrado');
      console.log('║');
      for (const exp of EXPECTED) {
        // Find matching bet
        const matchedBet = bets.find(b =>
          exp.marketHints.some(h => b.name?.toLowerCase().includes(h.toLowerCase()))
        );
        if (!matchedBet) {
          console.log(`║  ❌ Esperado market "${exp.label}"  → nenhum market encontrado`);
          console.log(`║     (buscou por: ${exp.marketHints.slice(0,2).join(', ')})`);
          continue;
        }

        const target = exp.value.toLowerCase().trim();
        const matchedVal = (matchedBet.values || []).find(v => {
          const val = String(v.value||'').toLowerCase().trim();
          const stripped = val.replace(/^goals\s+/,'').replace(/^total\s+/,'').replace(/^match\s+/,'');
          const numPart = target.replace(/[^0-9.]/g,'');
          const dir = target.startsWith('over') ? 'over' : target.startsWith('under') ? 'under' : null;
          return val === target || stripped === target || (dir && numPart && val.includes(numPart) && val.includes(dir));
        });

        if (matchedVal) {
          console.log(`║  ✅ Esperado: "${exp.label}" (value="${exp.value}")`);
          console.log(`║     Recebido: market="${matchedBet.name}"  value="${matchedVal.value}"  odd=${matchedVal.odd}`);
        } else {
          const availableVals = (matchedBet.values||[]).map(v=>v.value).join(', ');
          console.log(`║  ❌ Esperado: "${exp.label}" (value="${exp.value}")`);
          console.log(`║     Market encontrado: "${matchedBet.name}"  MAS value="${exp.value}" NÃO encontrado`);
          console.log(`║     Values disponíveis: ${availableVals}`);
        }
      }
    }
    console.log('╚══════════════════════════════════════════════════════\n');
  })();

  // /fixtures?team&last=10 não traz statistics embutido de forma confiável.
  // Para cantos, cartões, chutes e SOT, enriquecemos cada fixture histórico
  // com /fixtures/statistics?fixture=ID antes de enviar ao PackBallMapper.
  const homeGamesBase = homeGamesRaw?.response || [];
  const awayGamesBase = awayGamesRaw?.response || [];

  const homeGames = await enrichGamesWithStatistics(homeGamesBase, 10);
  const awayGames = await enrichGamesWithStatistics(awayGamesBase, 10);

  return {
    fixture,

    // Manter o wrapper completo porque o PackBallMapper espera homeStats.response
    // e awayStats.response. Antes era enviado apenas homeStats.response, causando
    // ppg_h/exg_h/avg_sc_h/btts_h/under25_h nulos.
    homeStats,
    awayStats,

    homeGames,
    awayGames,
    h2hGames:    h2hRaw?.response || [],

    // Manter resposta completa; o mapper já normaliza predictions.response[0].
    predictions: predictionsRaw,
    odds:        oddsRaw,
  };
}


// ─────────────────────────────────────────────────────────────────
// FASE 4 — SALVAR NO SUPABASE
// ─────────────────────────────────────────────────────────────────

const MKT_TO_LABEL = {
  over15:   'Over 1.5',
  over25:   'Over 2.5',
  btts:     'BTTS',
  over05ht: 'Over 0.5 HT',
  under45:  'Under 4.5',
  under35:  'Under 3.5',
  esc75:    'Esc 7.5',
  esc85:    'Esc 8.5',
  cards25:  'Cart 2.5',
  cards35:  'Cart 3.5',
};

// Labels alternativos de mercado (linha alternativa resolve em tempo de execução)
// Usado para exibição no log e no banco — gerado pelo AltLineResolver
const MKT_ALT_LABELS = {
  // Escanteios
  'Esc 9.5':  'esc75', 'Esc 10.5': 'esc75',
  'Esc 9.5_85': 'esc85', 'Esc 10.5_85': 'esc85',
  // Cartões
  'Cart 4.5': 'cards25', 'Cart 5.5': 'cards25',
  'Cart 4.5_35': 'cards35', 'Cart 5.5_35': 'cards35',
};

/**
 * upsertFixture(raw, liga)
 * Upsert na tabela fixtures.
 */
async function upsertFixture(raw, liga) {
  const row = {
    fixture_id:   raw.fixture_id,
    league_id:    raw.league_id,
    league_name:  raw.league_name,
    season:       raw.season,
    tier:         liga?.tier || 'normal',
    match_date:   raw.match_date,
    home_team:      raw.home_team,
    away_team:      raw.away_team,
    home_team_logo: raw.home_team_logo || null,
    away_team_logo: raw.away_team_logo || null,
    home_team_id:   null,
    away_team_id:   null,
    status:       raw.status || 'NS',
    updated_at:   new Date().toISOString(),
  };

  const { error } = await supabase
    .from('fixtures')
    .upsert(row, { onConflict: 'fixture_id' });

  if (error) throw new Error(`upsertFixture: ${error.message}`);
}

/**
 * upsertMetrics(raw, result)
 * Upsert na tabela match_metrics com variáveis brutas + derivadas.
 */
async function upsertMetrics(raw, result) {
  const d = result.derivadas;
  const n = result.normalizadas;

  const row = {
    fixture_id:    raw.fixture_id,
    // Brutas
    over15_g:      raw.over15_g,
    over25_g:      raw.over25_g,
    exg_h:         raw.exg_h,
    exg_a:         raw.exg_a,
    ppg_h:         raw.ppg_h,
    ppg_a:         raw.ppg_a,
    h2h_goals:     raw.h2h_goals,
    avg_sc_h:      raw.avg_sc_h,
    avg_sc_a:      raw.avg_sc_a,
    af_avg:        d.af_avg,
    btts_h:        raw.btts_h,
    btts_a:        raw.btts_a,
    btts_cf:       d.btts_cf,
    over05_ht:     raw.over05_ht,
    over15_ht:     raw.over15_ht,
    avg_corners:   raw.avg_corners,
    over65_c:      raw.over65_c,
    over75_c:      raw.over75_c,
    over85_c:      raw.over85_c,
    avg_cards:     raw.avg_cards,
    over25_cards:  raw.over25_cards,
    over35_cards:  raw.over35_cards,
    avg_shots:     raw.avg_shots,
    avg_sot:       raw.avg_sot,
    under25_h:     raw.under25_h,
    under25_a:     raw.under25_a,
    // Derivadas
    exg_tot:       d.exg_tot,
    ppg_avg:       d.ppg_avg,
    ppg_min:       d.ppg_min,
    u25cf:         d.u25cf,
    // Poisson
    prob_o15_poisson: result.poisson?.o15 ?? null,
    prob_o25_poisson: result.poisson?.o25 ?? null,
    prob_u35_poisson: result.poisson?.u35 ?? null,
    prob_u45_poisson: result.poisson?.u45 ?? null,
    // Normalizadas
    ppg_n:    n.ppg_n,
    af_n:     n.af_n,
    exg_n:    n.exg_n,
    h2h_nv:   n.h2h_nv,
    cant_n:   n.cant_n,
    shots_n:  n.shots_n,
    cards_n:  n.cards_n,
    sot_n:    n.sot_n,
    // Odds justas (null por enquanto — calculadas futuramente)
    odd_justa_15:     raw.odd_justa_15     ?? null,
    odd_justa_25:     raw.odd_justa_25     ?? null,
    odd_justa_btts:   raw.odd_justa_btts   ?? null,
    odd_justa_05ht:   raw.odd_justa_05ht   ?? null,
    odd_justa_esc85:  raw.odd_justa_esc85  ?? null,
    odd_justa_cart25: raw.odd_justa_cart25 ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('match_metrics')
    .upsert(row, { onConflict: 'fixture_id' });

  if (error) throw new Error(`upsertMetrics: ${error.message}`);
}

/**
 * upsertOdds(raw)
 * Substitui todas as odds do fixture (delete + insert).
 */
async function upsertOdds(raw) {
  const oddMap = {
    'Over 1.5':    raw.odd_o15,
    'Over 2.5':    raw.odd_o25,
    'BTTS':        raw.odd_btts,
    'Over 0.5 HT': raw.odd_05ht,
    'Under 3.5':   raw.odd_u35,
    'Under 4.5':   raw.odd_u45,
    'Esc 7.5':     raw.odd_esc75,
    'Esc 8.5':     raw.odd_esc85,
    'Cart 2.5':    raw.odd_c25,
    'Cart 3.5':    raw.odd_c35,
  };

  const rows = Object.entries(oddMap)
    .filter(([_, v]) => v !== null && v !== undefined)
    .map(([market, odd]) => ({
      fixture_id:    raw.fixture_id,
      market,
      value:        'Over',   // simplificado — refinado futuramente
      odd,
      bookmaker_id: 6,
      bookmaker_name: 'bet365',
      updated_at:   new Date().toISOString(),
    }));

  if (rows.length === 0) return;

  // Delete existentes + insert novos
  await supabase.from('odds').delete().eq('fixture_id', raw.fixture_id);

  const { error } = await supabase.from('odds').insert(rows);
  if (error) throw new Error(`upsertOdds: ${error.message}`);
}

/**
 * upsertPredictions(result)
 * Salva todos os 10 mercados na tabela predictions.
 * Marca is_best_market no mercado best_mkt.
 * Se houver linha alternativa, usa o label real (ex: Esc 9.5) e
 * salva os metadados original_market / final_market / is_alternative_line.
 */
async function upsertPredictions(result) {
  // Monta mapa de overrides de label a partir de altLines
  const altLabelByKey = {};
  for (const alt of (result.altLines || [])) {
    altLabelByKey[alt.mkt_key] = {
      final_market:    alt.final_market,
      original_market: alt.original_market,
      is_alternative_line: true,
    };
  }

  const rows = Object.entries(MKT_TO_LABEL).map(([key, marketDefault]) => {
    const score = result.scores[key];
    if (score === null || score === undefined) return null;

    const grade      = result.grades[key];
    const odd        = result.odds[key]  ?? null;
    const ev         = result.evs[key]   ?? null;

    // Aplica label alternativo se houver
    const altInfo    = altLabelByKey[key];
    const market     = altInfo ? altInfo.final_market : marketDefault;
    const isBest     = market === result.best_mkt || marketDefault === result.best_mkt;

    // Filtros específicos
    let passedFilter   = false;
    let under35Passed  = false;
    if (key === 'over15')  passedFilter  = result.filters.over15_passed;
    if (key === 'under35') under35Passed = result.filters.under35_passed;

    return {
      fixture_id:    result.fixture_id,
      market,
      score:         Math.round(score * 100) / 100,
      probability:   Math.round(score * 100) / 100,
      grade,
      confidence:    PredictionEngine.getConfidence(grade),
      passed_filter:   passedFilter,
      under35_passed:  under35Passed,
      is_best_market:  isBest,
      odd,
      odd_justa:     null,
      ev,
      // Metadados de linha alternativa
      original_market:      altInfo ? altInfo.original_market : null,
      is_alternative_line:  altInfo ? true : false,
      created_at:    new Date().toISOString(),
    };
  }).filter(Boolean);

  if (rows.length === 0) return;

  const { error } = await supabase
    .from('predictions')
    .upsert(rows, { onConflict: 'fixture_id,market' });

  if (error) throw new Error(`upsertPredictions: ${error.message}`);
}

/**
 * upsertSnapshot(result, raw)
 * Cria/atualiza registro em prediction_snapshots.
 * Apenas para grade A+ ou A (GRADES_OFICIAIS).
 *
 * O snapshot usa o best_mkt — mercado oficial congelado (§7.1).
 * Preserva resultado se jogo já confirmado (FORCE=false).
 *
 * @returns {boolean} true se snapshot foi salvo
 */
async function upsertSnapshot(result, raw) {
  if (!GRADES_OFICIAIS.has(result.best_grade)) return false;
  if (!result.best_mkt) return false;

  // §2.3: preserva resultado já confirmado se não FORCE
  if (!FORCE) {
    const { data: existing } = await supabase
      .from('prediction_snapshots')
      .select('id, result_status')
      .eq('fixture_id', result.fixture_id)
      .eq('market', result.best_mkt)
      .single();

    if (existing?.result_status && existing.result_status !== null) {
      LOG.dim(`    Snapshot ${result.fixture_id} já confirmado (${existing.result_status}) — preservado.`);
      return false;
    }
  }

  // Determina ticket_type (§7.2)
  let ticketType = null;
  if (result.best_grade === 'A+' && result.best_score >= TICKET_DIA_MIN_SCORE) {
    ticketType = 'b_dia';  // Bilhete do Dia
  } else if (result.best_grade === 'A+') {
    ticketType = 'b2';     // Elite
  } else {
    ticketType = 'b1';     // Premium 4X (Top 4 A+/A)
  }

  // Resolve metadados de linha alternativa para este best_mkt
  const altInfoSnap = (result.altLines || []).find(a => a.final_market === result.best_mkt);

  const row = {
    fixture_id:   result.fixture_id,
    match_name:        result.jogo,
    home_team:         result.home_team,
    away_team:         result.away_team,
    home_team_logo:    raw.home_team_logo || null,
    away_team_logo:    raw.away_team_logo || null,
    league_name:  result.league_name,
    match_date:   result.match_date,
    market:       result.best_mkt,
    score:        Math.round(result.best_score * 100) / 100,
    grade:        result.best_grade,
    confidence:   result.best_confidence,
    odd:          result.best_odd  ?? null,
    odd_justa:    null,
    ev:           result.best_ev   ?? null,
    result_status: null,
    confirmed_at: null,
    ticket_type:  ticketType,
    // Metadados de linha alternativa
    original_market:      altInfoSnap ? altInfoSnap.original_market : null,
    final_market:         altInfoSnap ? altInfoSnap.final_market    : null,
    original_line:        altInfoSnap ? altInfoSnap.original_line   : null,
    final_line:           altInfoSnap ? altInfoSnap.final_line      : null,
    is_alternative_line:  altInfoSnap ? true                        : false,
    created_at:   new Date().toISOString(),
  };

  const { error } = await supabase
    .from('prediction_snapshots')
    .upsert(row, { onConflict: 'fixture_id,market' });

  if (error) throw new Error(`upsertSnapshot: ${error.message}`);
  return true;
}


// ─────────────────────────────────────────────────────────────────
// FASE 5 — LOG DETALHADO POR FIXTURE
// ─────────────────────────────────────────────────────────────────

/**
 * printFixtureLog(raw, result, savedSnapshot, validation)
 * Imprime um log completo e estruturado para um fixture processado.
 */
function printFixtureLog(raw, result, savedSnapshot, validation) {
  const hr = '─'.repeat(64);

  console.log(`\n${hr}`);
  console.log(` ⚽  ${result.jogo}`);
  console.log(`     ${result.league_name}  •  ${result.match_date?.slice(0,10)}  •  ${result.hour}`);
  console.log(`     fixture_id: ${result.fixture_id}  |  status: ${raw.status}`);
  console.log(hr);

  // Variáveis-chave
  const d = result.derivadas;
  console.log(' 📊  Variáveis:');
  console.log(`     xG:  h=${d.exg_h?.toFixed(2)??'null'} a=${d.exg_a?.toFixed(2)??'null'} tot=${d.exg_tot?.toFixed(2)??'null (sem xG)'}`);
  console.log(`     PPG: h=${d.ppg_avg?.toFixed(2)??'null'} min=${d.ppg_min?.toFixed(2)??'null'}`);
  console.log(`     H2H gols: ${raw.h2h_goals?.toFixed(1)??'null'}`);
  console.log(`     BTTS cf: ${d.btts_cf?.toFixed(1)??'null'}%`);
  console.log(`     Cantos: avg=${raw.avg_corners?.toFixed(1)??'null'}  over7.5=${raw.over75_c?.toFixed(0)??'null'}%`);
  console.log(`     Cartões: avg=${raw.avg_cards?.toFixed(1)??'null'}  over2.5=${raw.over25_cards?.toFixed(0)??'null'}%`);
  if (result.poisson) {
    console.log(`     Poisson: o15=${result.poisson.o15.toFixed(1)}%  o25=${result.poisson.o25.toFixed(1)}%  u35=${result.poisson.u35.toFixed(1)}%`);
  }

  // Warnings de validação
  if (validation.warnings.length > 0) {
    console.log(` ⚠️   Avisos: ${validation.warnings.join(' | ')}`);
  }

  // Tabela de scores
  console.log('\n 🎯  Scores por mercado:');
  console.log(`     ${'Mercado'.padEnd(14)} ${'Score'.padStart(6)} ${'Grade'.padEnd(4)} ${'Odd'.padStart(6)} ${'EV'.padStart(8)}  Filtro`);
  console.log(`     ${'-'.repeat(56)}`);

  for (const [key, market] of Object.entries(MKT_TO_LABEL)) {
    const sc  = result.scores[key];
    if (sc === null || sc === undefined) continue;
    const gr  = result.grades[key];
    const odd = result.odds[key];
    const ev  = result.evs[key];
    const isBest = market === result.best_mkt;

    let filtro = '';
    if (key === 'over15')  filtro = result.filters.over15_passed  ? `✓ Via${result.filters.over15_via}` : '✗';
    if (key === 'under35') filtro = result.filters.under35_passed ? '✓' : '✗';

    const marker  = isBest ? ' ★' : '  ';
    const grColor = gr === 'A+' ? '\x1b[32m' : gr === 'A' ? '\x1b[36m' : '\x1b[90m';

    console.log(
      `  ${marker} ${market.padEnd(14)} ` +
      `${sc.toFixed(1).padStart(6)} ` +
      `${grColor}${gr.padEnd(4)}\x1b[0m ` +
      `${odd !== null ? odd.toFixed(2).padStart(6) : '   n/a'} ` +
      `${ev !== null ? ((ev >= 0 ? '+' : '') + ev.toFixed(1) + '%').padStart(8) : '     n/a'}  ` +
      `${filtro}`
    );
  }

  // Resultado best_mkt
  const grColor = result.best_grade === 'A+' ? '\x1b[32m' : result.best_grade === 'A' ? '\x1b[36m' : '\x1b[90m';
  console.log(`\n     BEST MKT: ${grColor}${result.best_mkt}\x1b[0m  score=${result.best_score?.toFixed(1)}  grade=${grColor}${result.best_grade}\x1b[0m  conf="${result.best_confidence}"`);
  if (result.best_odd) {
    console.log(`     Odd: ${result.best_odd.toFixed(2)}  EV: ${result.best_ev !== null ? (result.best_ev >= 0 ? '+' : '') + result.best_ev.toFixed(1) + '%' : 'n/a'}`);
  }

  // Linhas alternativas usadas
  if (result.altLines && result.altLines.length > 0) {
    console.log('\n \x1b[33m🔀  Linhas alternativas:\x1b[0m');
    for (const alt of result.altLines) {
      console.log(
        `     ${alt.original_market} → \x1b[33m${alt.final_market}\x1b[0m` +
        `  odd=${alt.odd_used}  score=${alt.score?.toFixed(1)}` +
        `  ev=${alt.ev !== null ? (alt.ev >= 0 ? '+' : '') + alt.ev + '%' : 'n/a'}` +
        `  [linha alternativa — gap=${alt.final_line - alt.original_line}]`
      );
    }
  }

  // Snapshot
  if (result.is_official) {
    const snap = savedSnapshot ? '\x1b[32m✓ snapshot salvo\x1b[0m' : '\x1b[33m⟳ snapshot preservado\x1b[0m';
    console.log(`     ${snap}  (grade ${result.best_grade} — palpite oficial)`);
  } else {
    console.log(`     \x1b[90mNão gera snapshot (grade ${result.best_grade} < A)\x1b[0m`);
  }

  console.log(hr);
}


// ─────────────────────────────────────────────────────────────────
// PIPELINE PRINCIPAL
// ─────────────────────────────────────────────────────────────────

/**
 * run()
 * Ponto de entrada do job. Executa o pipeline completo.
 */
async function run() {
  console.log('\n' + '═'.repeat(64));
  console.log(' WinMetrics Analytics — Generate Predictions');
  console.log(` Data inicial: ${TODAY}  |  days: ${DAYS}  |  dry-run: ${DRY_RUN}  |  force: ${FORCE}  |  only-new: ${ONLY_NEW}  |  limit: ${LIMIT || 'sem limite'}`);
  console.log('═'.repeat(64) + '\n');

  // Validação de ambiente
  if (!API_KEY) {
    LOG.error('API_FOOTBALL_KEY não configurada. Abortando.');
    process.exit(1);
  }
  if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
    LOG.error('SUPABASE_URL ou SUPABASE_SERVICE_KEY não configurados. Use --dry-run para testar sem banco.');
    process.exit(1);
  }
  if (DRY_RUN) {
    LOG.warn('Modo DRY-RUN: nenhuma escrita no Supabase será feita.');
  }

  // Estatísticas globais
  const stats = {
    fixtures_total: 0, fixtures_ok: 0, fixtures_error: 0,
    fixtures_skipped: 0,
    snapshots: 0, grades_ap: 0, grades_a: 0, grades_b: 0,
    markets_scored: 0, errors: [],
    api_fixture_calls: LIGAS.length * DAYS,
    api_detail_calls_estimated: 0,
    api_calls_saved: 0,
  };

  // ── FASE 1: Buscar fixtures ──────────────────────────────────
  const fixtureEntries = await fetchTodayFixtures();
  stats.fixtures_total = fixtureEntries.length;

  if (fixtureEntries.length === 0) {
    LOG.warn('Nenhuma fixture encontrada para hoje. Encerrando.');
    return;
  }

  // ── PROCESSAR CADA FIXTURE ───────────────────────────────────
  for (const entry of fixtureEntries) {
    const fixtureId = entry.fixture?.fixture?.id;

    try {
      // ── CACHE: pula detalhes se já processado recentemente ──
      const cacheDecision = await shouldSkipFixture(entry);
      if (cacheDecision.skip) {
        stats.fixtures_skipped++;
        stats.api_calls_saved += cacheDecision.savedCalls || 0;
        LOG.dim(`Pulando fixture ${fixtureId} — ${cacheDecision.reason} (${cacheDecision.savedCalls} chamadas economizadas)`);
        continue;
      }

      // ── FASE 2: Coletar dados ──────────────────────────────
      stats.api_detail_calls_estimated += 7;
      LOG.info(`Coletando fixture ${fixtureId} — ${entry.fixture?.teams?.home?.name} vs ${entry.fixture?.teams?.away?.name}`);
      const apiData = await fetchAllData(entry);

      // ── FASE 3: Mapear + validar + calcular ─────────────────
      const raw        = PackBallMapper.mapFixtureToPackBall(apiData);

      // ODDS PIPELINE TRACE — remove after debugging
      if (process.env.DEBUG_ODDS === '1') {
        const oddFields = ['odd_o15','odd_o25','odd_btts','odd_u35','odd_u45','odd_esc75','odd_esc85','odd_c25','odd_c35'];
        const rawOdds = oddFields.map(f => `${f}=${raw[f]}`).join(' | ');
        console.log(`[PIPELINE] raw após mapper — ${rawOdds}`);
      }

      const validation = PackBallMapper.validatePackBallInput(raw);

      if (!validation.valid) {
        LOG.warn(`  Fixture ${fixtureId} inválida:`, validation.critical.join(', '));
        stats.fixtures_error++;
        stats.errors.push({ fixtureId, errors: validation.critical });
        continue;
      }

      // ── LINHA ALTERNATIVA (Esc / Cartões) ──────────────────────
      // Resolve linhas alternativas ANTES do engine, mas APÓS o mapper.
      // Não altera scores nem fórmulas — apenas preenche raw.odd_* ausentes
      // com a odd de uma linha próxima, e registra metadados de auditoria.
      // Uma primeira passagem do engine (sem odds) gera os scores que
      // servem de critério de aceitação da linha alternativa.
      const _rawScoresForAlt = PredictionEngine.processFixture(raw).scores;
      const { raw: rawPatched, labelOverrides, altLines } = AltLineResolver.resolveAlternativeLines(
        raw,
        apiData.odds,
        _rawScoresForAlt
      );

      if (altLines.length > 0) {
        AltLineResolver.logAltLines(altLines, raw.fixture_id, LOG);
      }

      const _resultBase = PredictionEngine.processFixture(rawPatched);
      const result = AltLineResolver.applyLabelOverrides(_resultBase, labelOverrides, altLines);

      // ODDS PIPELINE TRACE — remove after debugging
      if (process.env.DEBUG_ODDS === '1') {
        const mktKeys = ['over15','over25','btts','over05ht','under45','under35','esc75','esc85','cards25','cards35'];
        const resultOdds = mktKeys.map(k => `${k}=${result.odds[k]}`).join(' | ');
        const resultEvs  = mktKeys.map(k => `${k}=${result.evs[k]}`).join(' | ');
        console.log(`[PIPELINE] result.odds  — ${resultOdds}`);
        console.log(`[PIPELINE] result.evs   — ${resultEvs}`);
        console.log(`[PIPELINE] best_odd=${result.best_odd}  best_ev=${result.best_ev}`);
      }

      // Contabiliza grades
      const g = result.best_grade;
      if (g === 'A+') stats.grades_ap++;
      else if (g === 'A') stats.grades_a++;
      else if (g === 'B') stats.grades_b++;

      const scoredMarkets = Object.values(result.scores).filter(s => s !== null).length;
      stats.markets_scored += scoredMarkets;

      // ── FASE 4: Salvar no Supabase ─────────────────────────
      let savedSnapshot = false;

      if (!DRY_RUN && supabase) {
        await upsertFixture(raw, entry.liga);
        await upsertMetrics(raw, result);
        await upsertOdds(raw);
        await upsertPredictions(result);
        savedSnapshot = await upsertSnapshot(result, raw);

        if (savedSnapshot) stats.snapshots++;
        LOG.ok(`  Salvo: fixture ${fixtureId}  ${scoredMarkets} mercados  ${savedSnapshot ? 'snapshot ✓' : ''}`);
      } else if (DRY_RUN) {
        // Em dry-run: simula o snapshot se elegível
        savedSnapshot = result.is_official;
        if (savedSnapshot) stats.snapshots++;
        LOG.ok(`  [DRY-RUN] ${fixtureId}  ${scoredMarkets} mercados  best=${result.best_mkt} grade=${result.best_grade}`);
      }

      // ── FASE 5: Log detalhado ──────────────────────────────
      printFixtureLog(raw, result, savedSnapshot, validation);

      stats.fixtures_ok++;

    } catch (err) {
      LOG.error(`  Erro no fixture ${fixtureId}:`, err.message);
      stats.fixtures_error++;
      stats.errors.push({ fixtureId, error: err.message });
    }

    // Pausa entre fixtures para respeitar rate limit
    await delay(200);
  }

  // ── FASE 6: Resumo final ─────────────────────────────────────
  printSummary(stats);
}

/**
 * printSummary(stats)
 */
function printSummary(stats) {
  const hr = '═'.repeat(64);
  console.log('\n' + hr);
  console.log(' RESUMO FINAL');
  console.log(hr);
  console.log(` Fixtures processadas: ${stats.fixtures_ok}/${stats.fixtures_total}  (${stats.fixtures_error} erros, ${stats.fixtures_skipped || 0} puladas por cache)`);
  console.log(` Mercados calculados:  ${stats.markets_scored}`);
  console.log(` Snapshots criados:    ${stats.snapshots}`);
  console.log(` Grades:  A+=${stats.grades_ap}  A=${stats.grades_a}  B=${stats.grades_b}`);
  console.log(` API — chamadas fixtures: ${stats.api_fixture_calls || 0}`);
  console.log(` API — chamadas detalhes estimadas: ${stats.api_detail_calls_estimated || 0}`);
  console.log(` API — chamadas economizadas: ${stats.api_calls_saved || 0}`);
  if (stats.errors.length > 0) {
    console.log('\n Erros:');
    stats.errors.forEach(e => console.log(`   fixture ${e.fixtureId}: ${e.errors || e.error}`));
  }
  console.log(hr + '\n');
}


// ─────────────────────────────────────────────────────────────────
// EXEMPLO COMPLETO — runExample()
// Executa com dados mockados para demonstração sem API real
// ─────────────────────────────────────────────────────────────────

/**
 * runExample()
 * Demonstra o pipeline completo com dados mockados.
 * Invocado automaticamente quando não há API_KEY configurada.
 */
async function runExample() {
  console.log('\n' + '═'.repeat(64));
  console.log(' MODO EXEMPLO — dados mockados (sem API real)');
  console.log('═'.repeat(64));

  // ── Entrada API-Football simulada ────────────────────────────
  const mockApiData = {
    fixture: {
      fixture: { id: 1049201, date: '2026-06-10T22:00:00+00:00', status: { short: 'NS', long: 'Not Started' } },
      league:  { id: 71, name: 'Brasileirão Série A', season: 2026 },
      teams:   { home: { id: 119, name: 'Flamengo' }, away: { id: 121, name: 'Palmeiras' } },
      goals:   { home: null, away: null },
      score:   { halftime: { home: null, away: null } },
    },
    homeStats: { response: {
      fixtures: { played: { total: 19 }, wins: { total: 12 }, draws: { total: 4 }, loses: { total: 3 } },
      goals: { for: { average: { total: '1.8' }, total: { total: 34 } }, against: { average: { total: '0.9' }, total: { total: 17 } } },
    }},
    awayStats: { response: {
      fixtures: { played: { total: 19 }, wins: { total: 11 }, draws: { total: 5 }, loses: { total: 3 } },
      goals: { for: { average: { total: '1.6' }, total: { total: 30 } }, against: { average: { total: '1.0' }, total: { total: 19 } } },
    }},
    homeGames: Array(10).fill(null).map((_, i) => ({
      score: { halftime: { home: i % 3 === 0 ? 1 : 0, away: i % 4 === 0 ? 1 : 0 } },
      statistics: [
        { team: { id: 119 }, statistics: [
          { type: 'Corner Kicks', value: 5 + (i % 4) }, { type: 'Yellow Cards', value: 2 },
          { type: 'Red Cards', value: 0 }, { type: 'Total Shots', value: 13 + i }, { type: 'Shots on Goal', value: 4 + (i % 2) },
        ]},
        { team: { id: 999 }, statistics: [
          { type: 'Corner Kicks', value: 4 + (i % 3) }, { type: 'Yellow Cards', value: 1 + (i % 2) },
          { type: 'Red Cards', value: 0 }, { type: 'Total Shots', value: 9 + i }, { type: 'Shots on Goal', value: 3 },
        ]},
      ],
    })),
    awayGames: Array(10).fill(null).map((_, i) => ({
      score: { halftime: { home: i % 4 === 0 ? 1 : 0, away: i % 5 === 0 ? 1 : 0 } },
      statistics: [
        { team: { id: 121 }, statistics: [
          { type: 'Corner Kicks', value: 5 + (i % 3) }, { type: 'Yellow Cards', value: 2 + (i % 2) },
          { type: 'Red Cards', value: i % 5 === 0 ? 1 : 0 }, { type: 'Total Shots', value: 12 + i }, { type: 'Shots on Goal', value: 4 },
        ]},
        { team: { id: 800 }, statistics: [
          { type: 'Corner Kicks', value: 3 }, { type: 'Yellow Cards', value: 2 },
          { type: 'Red Cards', value: 0 }, { type: 'Total Shots', value: 10 }, { type: 'Shots on Goal', value: 3 },
        ]},
      ],
    })),
    h2hGames: [
      { goals: { home: 2, away: 1 } }, { goals: { home: 0, away: 0 } }, { goals: { home: 3, away: 2 } },
      { goals: { home: 1, away: 1 } }, { goals: { home: 2, away: 0 } }, { goals: { home: 1, away: 2 } },
      { goals: { home: 0, away: 1 } }, { goals: { home: 2, away: 2 } }, { goals: { home: 1, away: 0 } },
      { goals: { home: 3, away: 1 } },
    ],
    predictions: { response: [{ predictions: {
      percent: { home: '55%', draw: '25%', away: '20%' },
    }, comparison: { goals: { home: '53%', away: '47%' } }}]},
    odds: { response: [{ bookmakers: [{ id: 6, name: 'Bet365', bets: [
      { id: 5, name: 'Goals Over/Under', values: [
        { value: 'Over 1.5', odd: '1.22' }, { value: 'Over 2.5', odd: '1.72' },
        { value: 'Under 3.5', odd: '1.44' }, { value: 'Under 4.5', odd: '1.12' },
      ]},
      { id: 8, name: 'Both Teams Score', values: [{ value: 'Yes', odd: '1.85' }]},
      { id: 45, name: 'Total Corners', values: [
        { value: 'Over 7.5', odd: '1.90' }, { value: 'Over 8.5', odd: '2.35' },
      ]},
      { id: 46, name: 'Total Cards', values: [
        { value: 'Over 2.5', odd: '1.75' }, { value: 'Over 3.5', odd: '2.90' },
      ]},
    ]}]}]},
  };

  console.log('\n📥  FASE 1 — Entrada API-Football (resumo):');
  console.log(`    fixture_id: ${mockApiData.fixture.fixture.id}`);
  console.log(`    jogo:       ${mockApiData.fixture.teams.home.name} vs ${mockApiData.fixture.teams.away.name}`);
  console.log(`    liga:       ${mockApiData.fixture.league.name}`);
  console.log(`    homeStats:  played=${mockApiData.homeStats.response.fixtures.played.total}  goals_for_avg=${mockApiData.homeStats.response.goals.for.average.total}`);
  console.log(`    h2h:        ${mockApiData.h2hGames.length} jogos`);
  console.log(`    odds:       ${mockApiData.odds.response[0].bookmakers[0].bets.reduce((a,b) => a + b.values.length, 0)} valores`);

  // ── FASE 2: Mapear ───────────────────────────────────────────
  const raw = PackBallMapper.mapFixtureToPackBall(mockApiData);
  console.log('\n📦  FASE 2 — Objeto RAW (packball_mapper.js):');
  console.log(JSON.stringify(raw, (k, v) => v !== null ? v : undefined, 2));

  // ── FASE 3: Validar ──────────────────────────────────────────
  const validation = PackBallMapper.validatePackBallInput(raw);
  console.log('\n🔍  FASE 3 — Validação:');
  console.log(`    valid: ${validation.valid}  critical: ${validation.critical.length}  warnings: ${validation.warnings.length}`);
  validation.info.forEach(i => console.log(`    → ${i}`));
  if (validation.warnings.length) validation.warnings.forEach(w => console.log(`    ⚠ ${w}`));

  // ── FASE 4: Motor (com resolver de linha alternativa) ────────
  const _scoresEx = PredictionEngine.processFixture(raw).scores;
  const { raw: rawPatchedEx, labelOverrides: loEx, altLines: altLinesEx } =
    AltLineResolver.resolveAlternativeLines(raw, mockApiData.odds, _scoresEx);
  if (altLinesEx.length > 0) {
    console.log('\n🔀  Linhas alternativas resolvidas:');
    AltLineResolver.logAltLines(altLinesEx, raw.fixture_id, { info: console.log });
  }
  const _baseEx = PredictionEngine.processFixture(rawPatchedEx);
  const result  = AltLineResolver.applyLabelOverrides(_baseEx, loEx, altLinesEx);
  console.log('\n🔢  FASE 4 — PredictionEngine.processFixture():');
  console.log(`    exg_tot=${result.derivadas.exg_tot?.toFixed(2)}  ppg_avg=${result.derivadas.ppg_avg?.toFixed(2)}`);
  if (result.poisson) {
    console.log(`    Poisson: o15=${result.poisson.o15.toFixed(1)}%  o25=${result.poisson.o25.toFixed(1)}%  u35=${result.poisson.u35.toFixed(1)}%`);
  }

  // ── FASE 5: Log completo ─────────────────────────────────────
  printFixtureLog(raw, result, result.is_official, validation);

  // ── FASE 6: Registro Supabase (simulado) ─────────────────────
  console.log('\n💾  FASE 5 — Registros que seriam salvos no Supabase:');

  console.log('\n  fixtures:');
  console.log(`    fixture_id=${raw.fixture_id}  league_id=${raw.league_id}  match_date=${raw.match_date?.slice(0,10)}`);
  console.log(`    home="${raw.home_team}"  away="${raw.away_team}"  status="${raw.status}"`);

  console.log('\n  match_metrics:');
  console.log(`    fixture_id=${raw.fixture_id}  over15_g=${raw.over15_g}  exg_h=${raw.exg_h}  exg_a=${raw.exg_a}`);
  console.log(`    ppg_h=${result.derivadas.ppg_avg?.toFixed(3)}  h2h_goals=${raw.h2h_goals}  avg_corners=${raw.avg_corners?.toFixed(1)}`);

  console.log('\n  odds (linhas inseridas):');
  const oddMap = {
    'Over 1.5': raw.odd_o15, 'Over 2.5': raw.odd_o25, 'BTTS': raw.odd_btts,
    'Esc 7.5': raw.odd_esc75, 'Esc 8.5': raw.odd_esc85, 'Cart 2.5': raw.odd_c25,
  };
  Object.entries(oddMap).filter(([,v])=>v).forEach(([m,o]) => console.log(`    ${m.padEnd(12)} odd=${o}`));

  console.log('\n  predictions (todos os 10 mercados):');
  Object.entries(MKT_TO_LABEL).forEach(([key, market]) => {
    const sc = result.scores[key];
    if (sc === null) return;
    const gr = result.grades[key];
    const isBest = market === result.best_mkt;
    console.log(`    ${(isBest ? '★ ' : '  ')}${market.padEnd(14)} score=${sc.toFixed(1).padStart(5)}  grade=${gr}  is_best=${isBest}`);
  });

  if (result.is_official) {
    console.log('\n  prediction_snapshots:');
    console.log(`    fixture_id=${result.fixture_id}  match_name="${result.jogo}"`);
    console.log(`    market="${result.best_mkt}"  score=${result.best_score?.toFixed(1)}  grade=${result.best_grade}`);
    console.log(`    confidence="${result.best_confidence}"  odd=${result.best_odd}  ev=${result.best_ev}`);
    console.log(`    result_status=null  (aguardando confirmar.js)`);
  } else {
    console.log(`\n  prediction_snapshots: não gerado (grade ${result.best_grade} < A)`);
  }

  console.log('\n' + '═'.repeat(64));
  console.log(' Exemplo concluído. Configure API_FOOTBALL_KEY para execução real.');
  console.log('═'.repeat(64) + '\n');
}


// ─────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────

if (!MOCK_TO_SUPABASE) {
  // ── Diagnóstico de variáveis de ambiente ─────────────────────
  console.log('--- ENV CHECK ---');
  console.log('API_FOOTBALL_KEY:    ', !!process.env.API_FOOTBALL_KEY, process.env.API_FOOTBALL_KEY ? '(set, length=' + process.env.API_FOOTBALL_KEY.length + ')' : '(EMPTY)');
  console.log('SUPABASE_URL:        ', !!process.env.SUPABASE_URL,      process.env.SUPABASE_URL      ? '(set)' : '(EMPTY)');
  console.log('SUPABASE_SERVICE_KEY:', !!process.env.SUPABASE_SERVICE_KEY, process.env.SUPABASE_SERVICE_KEY ? '(set)' : '(EMPTY)');
  console.log('API_KEY (const):     ', !!API_KEY, '→ entra em', !API_KEY ? 'runExample()' : 'run()');
  console.log('-----------------');

  if (!API_KEY) {
    // Sem chave configurada → executa o exemplo de demonstração
    runExample().catch(err => {
      LOG.error('Erro no exemplo:', err.message);
      process.exit(1);
    });
  } else {
    // Com chave configurada → executa o pipeline real
    run().catch(err => {
      if (err.code === 'QUOTA_EXCEEDED') {
        LOG.warn('Quota da API esgotada — pipeline encerrado com código 2.');
        process.exit(2);
      }
      LOG.error('Erro fatal:', err.message);
      process.exit(1);
    });
  }
}

module.exports = {
  run, runExample,
  fetchTodayFixtures, fetchAllData, shouldSkipFixture, getTargetDates,
  upsertFixture, upsertMetrics, upsertOdds, upsertPredictions, upsertSnapshot,
  blockedName, printFixtureLog, printSummary,
};


// ─────────────────────────────────────────────────────────────────
// MODO --mock-to-supabase
// Executa o pipeline completo com dados mockados (Flamengo x Palmeiras)
// e grava no Supabase real. Para validação antes de conectar API-Football.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node generate_predictions.js --mock-to-supabase
// ─────────────────────────────────────────────────────────────────

async function runMockToSupabase() {
  console.log('\n' + '═'.repeat(64));
  console.log(' WinMetrics — MOCK-TO-SUPABASE');
  console.log(' Pipeline completo com dados mockados → Supabase real');
  console.log('═'.repeat(64));

  // ── Validação de ambiente ──────────────────────────────────────
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    LOG.error('SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios neste modo.');
    LOG.error('Exemplo:');
    LOG.error('  SUPABASE_URL=https://xxx.supabase.co \\');
    LOG.error('  SUPABASE_SERVICE_KEY=eyJ... \\');
    LOG.error('  node generate_predictions.js --mock-to-supabase');
    process.exit(1);
  }

  if (!supabase) {
    LOG.error('Supabase client não inicializado. Verifique as variáveis de ambiente.');
    process.exit(1);
  }

  LOG.info('Supabase conectado: ' + SUPABASE_URL);

  // ── Dados mockados: Flamengo x Palmeiras ──────────────────────
  LOG.info('Construindo dados mockados (Flamengo x Palmeiras)...');

  const mockApiData = {
    fixture: {
      fixture: {
        id: 1049201,
        date: '2026-06-10T22:00:00+00:00',
        status: { short: 'NS', long: 'Not Started' },
      },
      league: { id: 71, name: 'Brasileirão Série A', season: 2026 },
      teams: {
        home: { id: 119, name: 'Flamengo' },
        away: { id: 121, name: 'Palmeiras' },
      },
      goals: { home: null, away: null },
      score: { halftime: { home: null, away: null } },
    },

    homeStats: { response: {
      fixtures: {
        played: { home: 10, away: 9, total: 19 },
        wins:   { total: 12 },
        draws:  { total: 4  },
        loses:  { total: 3  },
      },
      goals: {
        for:     { average: { total: '1.8' }, total: { total: 34 } },
        against: { average: { total: '0.9' }, total: { total: 17 } },
      },
    }},

    awayStats: { response: {
      fixtures: {
        played: { home: 10, away: 9, total: 19 },
        wins:   { total: 11 },
        draws:  { total: 5  },
        loses:  { total: 3  },
      },
      goals: {
        for:     { average: { total: '1.6' }, total: { total: 30 } },
        against: { average: { total: '1.0' }, total: { total: 19 } },
      },
    }},

    homeGames: Array(10).fill(null).map((_, i) => ({
      score: { halftime: { home: i % 3 === 0 ? 1 : 0, away: i % 4 === 0 ? 1 : 0 } },
      statistics: [
        { team: { id: 119 }, statistics: [
          { type: 'Corner Kicks',  value: 5 + (i % 4) },
          { type: 'Yellow Cards',  value: 2            },
          { type: 'Red Cards',     value: 0            },
          { type: 'Total Shots',   value: 13 + i       },
          { type: 'Shots on Goal', value: 4 + (i % 2)  },
        ]},
        { team: { id: 900 + i }, statistics: [
          { type: 'Corner Kicks',  value: 4 + (i % 3) },
          { type: 'Yellow Cards',  value: 1 + (i % 2) },
          { type: 'Red Cards',     value: 0            },
          { type: 'Total Shots',   value: 9 + i        },
          { type: 'Shots on Goal', value: 3            },
        ]},
      ],
    })),

    awayGames: Array(10).fill(null).map((_, i) => ({
      score: { halftime: { home: i % 4 === 0 ? 1 : 0, away: i % 5 === 0 ? 1 : 0 } },
      statistics: [
        { team: { id: 121 }, statistics: [
          { type: 'Corner Kicks',  value: 5 + (i % 3) },
          { type: 'Yellow Cards',  value: 2 + (i % 2) },
          { type: 'Red Cards',     value: i % 5 === 0 ? 1 : 0 },
          { type: 'Total Shots',   value: 12 + i       },
          { type: 'Shots on Goal', value: 4 + (i % 3)  },
        ]},
        { team: { id: 800 + i }, statistics: [
          { type: 'Corner Kicks',  value: 3 + (i % 3) },
          { type: 'Yellow Cards',  value: 2            },
          { type: 'Red Cards',     value: 0            },
          { type: 'Total Shots',   value: 10 + (i % 4) },
          { type: 'Shots on Goal', value: 3            },
        ]},
      ],
    })),

    h2hGames: [
      { goals: { home: 2, away: 1 } },
      { goals: { home: 0, away: 0 } },
      { goals: { home: 3, away: 2 } },
      { goals: { home: 1, away: 1 } },
      { goals: { home: 2, away: 0 } },
      { goals: { home: 1, away: 2 } },
      { goals: { home: 0, away: 1 } },
      { goals: { home: 2, away: 2 } },
      { goals: { home: 1, away: 0 } },
      { goals: { home: 3, away: 1 } },
    ],

    predictions: { response: [{ predictions: {
      percent: { home: '55%', draw: '25%', away: '20%' },
    }, comparison: { goals: { home: '53%', away: '47%' } } }] },

    odds: { response: [{ bookmakers: [{ id: 6, name: 'Bet365', bets: [
      { id: 5, name: 'Goals Over/Under', values: [
        { value: 'Over 1.5',  odd: '1.22' },
        { value: 'Over 2.5',  odd: '1.72' },
        { value: 'Under 3.5', odd: '1.44' },
        { value: 'Under 4.5', odd: '1.12' },
      ]},
      { id: 8,  name: 'Both Teams Score', values: [{ value: 'Yes', odd: '1.85' }] },
      { id: 45, name: 'Total Corners', values: [
        { value: 'Over 7.5', odd: '1.90' },
        { value: 'Over 8.5', odd: '2.35' },
      ]},
      { id: 46, name: 'Total Cards', values: [
        { value: 'Over 2.5', odd: '1.75' },
        { value: 'Over 3.5', odd: '2.90' },
      ]},
    ]}]}] },
  };

  const liga = { id: 71, season: 2026, name: 'Brasileirão Série A', tier: 'normal' };

  // ── Fase 1: Mapear ────────────────────────────────────────────
  LOG.info('Fase 1 — PackBallMapper.mapFixtureToPackBall()...');
  const raw = PackBallMapper.mapFixtureToPackBall(mockApiData);
  LOG.ok(`  fixture_id=${raw.fixture_id}  exg_tot=${((raw.exg_h||0)+(raw.exg_a||0)).toFixed(2)}  over15_g=${raw.over15_g}`);

  const validation = PackBallMapper.validatePackBallInput(raw);
  if (!validation.valid) {
    LOG.error('Validação falhou:', validation.critical.join(', '));
    process.exit(1);
  }
  LOG.ok('  Validação OK — ' + validation.info.join(' | '));

  // ── Fase 2: Motor ─────────────────────────────────────────────
  LOG.info('Fase 2 — PredictionEngine.processFixture() (com linha alternativa)...');
  const _scoresMock = PredictionEngine.processFixture(raw).scores;
  const { raw: rawPatchedMock, labelOverrides: loMock, altLines: altLinesMock } =
    AltLineResolver.resolveAlternativeLines(raw, mockApiData.odds, _scoresMock);
  if (altLinesMock.length > 0) AltLineResolver.logAltLines(altLinesMock, raw.fixture_id, LOG);
  const _baseMock = PredictionEngine.processFixture(rawPatchedMock);
  const result    = AltLineResolver.applyLabelOverrides(_baseMock, loMock, altLinesMock);
  LOG.ok(`  best_mkt="${result.best_mkt}"  score=${result.best_score?.toFixed(1)}  grade=${result.best_grade}  is_official=${result.is_official}`);

  // ── Fase 3: Gravar no Supabase — PARA NO PRIMEIRO ERRO ────────
  const inserted = {
    fixtures: 0, match_metrics: 0, odds: 0,
    predictions: 0, prediction_snapshots: 0,
    ids: { prediction_snapshots: null },
    errors: [],
  };

  // ── 3a. fixtures ──────────────────────────────────────────────
  LOG.info('Fase 3a — INSERT fixtures...');
  console.log('  Colunas:', [
    'fixture_id','league_id','league_name','season','tier',
    'match_date','home_team','away_team','home_team_id','away_team_id',
    'status','updated_at',
  ].join(', '));

  try {
    await upsertFixture(raw, liga);
    inserted.fixtures = 1;
    LOG.ok('  fixtures OK — fixture_id=' + raw.fixture_id);
  } catch (err) {
    inserted.errors.push({ table: 'fixtures', error: err.message });
    LOG.error('  ERRO em fixtures:', err.message);
    printMockSummary(inserted);
    process.exit(1);
  }

  // ── 3b. match_metrics ─────────────────────────────────────────
  LOG.info('Fase 3b — INSERT match_metrics...');
  console.log('  Colunas:', [
    'fixture_id','over15_g','over25_g','exg_h','exg_a','ppg_h','ppg_a',
    'h2h_goals','avg_sc_h','avg_sc_a','af_avg','btts_h','btts_a','btts_cf',
    'over05_ht','over15_ht','avg_corners','over65_c','over75_c','over85_c',
    'avg_cards','over25_cards','over35_cards','avg_shots','avg_sot',
    'under25_h','under25_a','exg_tot','ppg_avg','ppg_min','u25cf',
    'prob_o15_poisson','prob_o25_poisson','prob_u35_poisson','prob_u45_poisson',
    'ppg_n','af_n','exg_n','h2h_nv','cant_n','shots_n','cards_n','sot_n',
    'odd_justa_15','odd_justa_25','odd_justa_btts','odd_justa_05ht',
    'odd_justa_esc85','odd_justa_cart25','updated_at',
  ].join(', '));

  try {
    await upsertMetrics(raw, result);
    inserted.match_metrics = 1;
    LOG.ok('  match_metrics OK — exg_tot=' + result.derivadas.exg_tot?.toFixed(3));
  } catch (err) {
    inserted.errors.push({ table: 'match_metrics', error: err.message });
    LOG.error('  ERRO em match_metrics:', err.message);
    printMockSummary(inserted);
    process.exit(1);
  }

  // ── 3c. odds ──────────────────────────────────────────────────
  LOG.info('Fase 3c — DELETE + INSERT odds...');
  console.log('  Colunas: fixture_id, market, value, odd, bookmaker_id, bookmaker_name, updated_at');

  const oddMap = {
    'Over 1.5': raw.odd_o15, 'Over 2.5': raw.odd_o25, 'BTTS': raw.odd_btts,
    'Over 0.5 HT': raw.odd_05ht, 'Under 3.5': raw.odd_u35, 'Under 4.5': raw.odd_u45,
    'Esc 7.5': raw.odd_esc75, 'Esc 8.5': raw.odd_esc85,
    'Cart 2.5': raw.odd_c25, 'Cart 3.5': raw.odd_c35,
  };
  const oddsToInsert = Object.entries(oddMap).filter(([,v]) => v !== null && v !== undefined);
  console.log(`  Valores a inserir (${oddsToInsert.length} linhas):`);
  oddsToInsert.forEach(([m, o]) => console.log(`    market="${m}"  odd=${o}`));

  try {
    await upsertOdds(raw);
    inserted.odds = oddsToInsert.length;
    LOG.ok(`  odds OK — ${oddsToInsert.length} linhas inseridas`);
  } catch (err) {
    inserted.errors.push({ table: 'odds', error: err.message });
    LOG.error('  ERRO em odds:', err.message);
    printMockSummary(inserted);
    process.exit(1);
  }

  // ── 3d. predictions ───────────────────────────────────────────
  LOG.info('Fase 3d — UPSERT predictions (10 mercados)...');
  console.log('  Colunas: fixture_id, market, score, probability, grade, confidence,');
  console.log('           passed_filter, under35_passed, is_best_market, odd, odd_justa, ev, created_at');
  console.log('  Linhas a inserir:');
  const MKT_TO_LABEL_LOCAL = {
    over15:'Over 1.5', over25:'Over 2.5', btts:'BTTS', over05ht:'Over 0.5 HT',
    under45:'Under 4.5', under35:'Under 3.5', esc75:'Esc 7.5', esc85:'Esc 8.5',
    cards25:'Cart 2.5', cards35:'Cart 3.5',
  };
  Object.entries(MKT_TO_LABEL_LOCAL).forEach(([k, m]) => {
    const sc = result.scores[k];
    if (sc === null) return;
    const isBest = m === result.best_mkt;
    console.log(`    ${isBest?'★':' '} market="${m}"  score=${sc.toFixed(1)}  grade=${result.grades[k]}  is_best_market=${isBest}`);
  });

  try {
    await upsertPredictions(result);
    inserted.predictions = Object.values(result.scores).filter(v => v !== null).length;
    LOG.ok(`  predictions OK — ${inserted.predictions} linhas, best_mkt="${result.best_mkt}"`);
  } catch (err) {
    inserted.errors.push({ table: 'predictions', error: err.message });
    LOG.error('  ERRO em predictions:', err.message);
    printMockSummary(inserted);
    process.exit(1);
  }

  // ── 3e. prediction_snapshots ──────────────────────────────────
  if (result.is_official) {
    LOG.info('Fase 3e — UPSERT prediction_snapshots...');
    console.log('  Colunas: fixture_id, match_name, home_team, away_team, league_name,');
    console.log('           match_date, market, score, grade, confidence, odd, odd_justa,');
    console.log('           ev, result_status, confirmed_at, ticket_type, created_at');
    console.log(`  Valores:`);
    console.log(`    fixture_id=${result.fixture_id}  match_name="${result.jogo}"`);
    console.log(`    market="${result.best_mkt}"  score=${result.best_score?.toFixed(1)}  grade=${result.best_grade}`);
    console.log(`    odd=${result.best_odd}  ev=${result.best_ev}  result_status=null`);

    try {
      const saved = await upsertSnapshot(result, raw);
      if (saved) {
        inserted.prediction_snapshots = 1;
        LOG.ok(`  prediction_snapshots OK — snapshot criado`);

        // Busca o ID gerado para mostrar no resumo
        const { data: snap } = await supabase
          .from('prediction_snapshots')
          .select('id, created_at')
          .eq('fixture_id', result.fixture_id)
          .eq('market', result.best_mkt)
          .single();
        inserted.ids.prediction_snapshots = snap?.id || '(não recuperado)';
        LOG.ok(`  ID gerado: ${inserted.ids.prediction_snapshots}`);
      } else {
        LOG.warn('  Snapshot não criado (já existia com resultado confirmado)');
      }
    } catch (err) {
      inserted.errors.push({ table: 'prediction_snapshots', error: err.message });
      LOG.error('  ERRO em prediction_snapshots:', err.message);
      printMockSummary(inserted);
      process.exit(1);
    }
  } else {
    LOG.dim(`  prediction_snapshots: pulado (grade ${result.best_grade} não é A+/A)`);
  }

  // ── Verificação pós-gravação (SELECT de confirmação) ──────────
  LOG.info('Verificação — lendo registros gravados...');

  const checks = await Promise.allSettled([
    supabase.from('fixtures').select('fixture_id,home_team,away_team,status').eq('fixture_id', raw.fixture_id).single(),
    supabase.from('match_metrics').select('fixture_id,exg_h,exg_a,over15_g').eq('fixture_id', raw.fixture_id).single(),
    supabase.from('odds').select('market,odd').eq('fixture_id', raw.fixture_id),
    supabase.from('predictions').select('market,score,grade,is_best_market').eq('fixture_id', raw.fixture_id),
    supabase.from('prediction_snapshots').select('id,market,score,grade').eq('fixture_id', raw.fixture_id),
  ]);

  const [chkFix, chkMet, chkOdds, chkPred, chkSnap] = checks;

  console.log('\n  ┌─ fixtures:');
  if (chkFix.status === 'fulfilled' && chkFix.value.data) {
    const r = chkFix.value.data;
    console.log(`  │  fixture_id=${r.fixture_id}  "${r.home_team} vs ${r.away_team}"  status="${r.status}"`);
  } else {
    console.log(`  │  ERRO: ${chkFix.value?.error?.message || chkFix.reason}`);
  }

  console.log('  ├─ match_metrics:');
  if (chkMet.status === 'fulfilled' && chkMet.value.data) {
    const r = chkMet.value.data;
    console.log(`  │  fixture_id=${r.fixture_id}  exg_h=${r.exg_h}  exg_a=${r.exg_a}  over15_g=${r.over15_g}`);
  } else {
    console.log(`  │  ERRO: ${chkMet.value?.error?.message || chkMet.reason}`);
  }

  console.log('  ├─ odds:');
  if (chkOdds.status === 'fulfilled' && chkOdds.value.data) {
    chkOdds.value.data.forEach(o => console.log(`  │  market="${o.market}"  odd=${o.odd}`));
  } else {
    console.log(`  │  ERRO: ${chkOdds.value?.error?.message || chkOdds.reason}`);
  }

  console.log('  ├─ predictions:');
  if (chkPred.status === 'fulfilled' && chkPred.value.data) {
    chkPred.value.data.forEach(p =>
      console.log(`  │  ${p.is_best_market?'★':' '} market="${p.market}"  score=${p.score}  grade=${p.grade}`)
    );
  } else {
    console.log(`  │  ERRO: ${chkPred.value?.error?.message || chkPred.reason}`);
  }

  console.log('  └─ prediction_snapshots:');
  if (chkSnap.status === 'fulfilled' && chkSnap.value.data && chkSnap.value.data.length > 0) {
    chkSnap.value.data.forEach(s =>
      console.log(`     id=${s.id}  market="${s.market}"  score=${s.score}  grade=${s.grade}`)
    );
  } else {
    console.log(`     (nenhum — grade < A ou já confirmado)`);
  }

  printMockSummary(inserted);
}

function printMockSummary(inserted) {
  const hr = '═'.repeat(64);
  console.log('\n' + hr);
  console.log(' RESUMO — mock-to-supabase');
  console.log(hr);
  console.log(` fixtures inseridos:            ${inserted.fixtures}`);
  console.log(` match_metrics inseridos:       ${inserted.match_metrics}`);
  console.log(` odds inseridas:                ${inserted.odds}`);
  console.log(` predictions inseridas:         ${inserted.predictions}`);
  console.log(` prediction_snapshots inseridos:${inserted.prediction_snapshots}`);
  if (inserted.ids.prediction_snapshots) {
    console.log(` snapshot id:                   ${inserted.ids.prediction_snapshots}`);
  }
  if (inserted.errors.length > 0) {
    console.log('\n Erros encontrados:');
    inserted.errors.forEach(e => console.log(`   [${e.table}] ${e.error}`));
    console.log('\n Próximo passo recomendado:');
    const tbl = inserted.errors[0].table;
    console.log(`   1. Verificar se a tabela "${tbl}" existe no Supabase (SQL Editor)`);
    console.log(`   2. Confirmar que o SUPABASE_SERVICE_KEY tem role service_role`);
    console.log(`   3. Checar se RLS está bloqueando (policy "Service write ${tbl}" deve existir)`);
    console.log(`   4. Rodar: frontend/database/winmetrics_schema.sql no SQL Editor`);
  } else {
    console.log('\n Próximo passo recomendado:');
    console.log('   1. Conferir os registros no Supabase Dashboard → Table Editor');
    console.log('   2. Confirmar que prediction_snapshots.market = "Esc 7.5"');
    console.log('   3. Configurar API_FOOTBALL_KEY e rodar com --dry-run para validar o pipeline real');
    console.log('   4. Em seguida, rodar sem flags para gravar com dados reais da API');
  }
  console.log(hr + '\n');
}

// ── Adiciona --mock-to-supabase ao entry point existente ──────────
// (Este bloco substitui o if(!API_KEY) já existente via check adicional)
if (MOCK_TO_SUPABASE) {
  runMockToSupabase().catch(err => {
    LOG.error('Erro fatal no mock-to-supabase:', err.message);
    process.exit(1);
  });
}
