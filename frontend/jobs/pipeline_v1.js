#!/usr/bin/env node
/**
 * WinMetrics V3 — Pipeline PackBall v3.0
 * ─────────────────────────────────────────────────────────────────
 * Replica exatamente a lógica do V1 coletar.py + processar.py.
 * Coleta dados da API-Football, calcula scores e salva no Supabase.
 *
 * Endpoints utilizados (idêntico ao V1):
 *   /fixtures              → fixtures do dia por liga
 *   /fixtures/headtohead   → H2H últimos 10 jogos
 *   /teams/statistics      → médias sazonais (PPG, gols, BTTS)
 *   /fixtures/statistics   → corners, cards, shots (jogos recentes)
 *   /odds                  → odds 1X2, over/under
 *   /predictions           → over15_pct, over25_pct, under_over
 *
 * Uso:
 *   node frontend/jobs/pipeline_v1.js --date=2026-06-11
 *   node frontend/jobs/pipeline_v1.js --date=today
 *   node frontend/jobs/pipeline_v1.js --date=today --force
 *   node frontend/jobs/pipeline_v1.js --date=today --dry-run
 *
 * Variáveis de ambiente:
 *   API_FOOTBALL_KEY     — chave da API-Football
 *   SUPABASE_URL         — URL do projeto Supabase
 *   SUPABASE_SERVICE_KEY — service_role key
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────

const API_KEY      = process.env.API_FOOTBALL_KEY     || '';
const SUPABASE_URL = process.env.SUPABASE_URL         || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const API_BASE     = 'https://v3.football.api-sports.io';

const args    = process.argv.slice(2);
const dateArg = args.find(a => a.startsWith('--date='))?.split('=')[1] || 'today';
const FORCE   = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');

// ─────────────────────────────────────────────────────────────────
// LIGAS — idêntico ao V1 coletar.py
// ─────────────────────────────────────────────────────────────────

const LIGAS = [
  // Europa (season=2025)
  { id: 2,   nome: 'Champions League',          tier: 'elite',  season: 2025 },
  { id: 3,   nome: 'UEFA Europa League',         tier: 'elite',  season: 2025 },
  { id: 848, nome: 'UEFA Europa Conference League', tier: 'normal', season: 2025 },
  { id: 39,  nome: 'Premier League',             tier: 'elite',  season: 2025 },
  { id: 135, nome: 'Serie A',                    tier: 'elite',  season: 2025 },
  { id: 140, nome: 'La Liga',                    tier: 'elite',  season: 2025 },
  { id: 78,  nome: 'Bundesliga',                 tier: 'elite',  season: 2025 },
  { id: 61,  nome: 'Ligue 1',                    tier: 'elite',  season: 2025 },
  { id: 88,  nome: 'Eredivisie',                 tier: 'normal', season: 2025 },
  { id: 94,  nome: 'Liga Portugal',              tier: 'normal', season: 2025 },
  { id: 283, nome: 'Superliga',                  tier: 'normal', season: 2025 },
  { id: 203, nome: 'Super Lig',                  tier: 'normal', season: 2025 },
  { id: 40,  nome: 'Championship',               tier: 'normal', season: 2025 },
  { id: 87,  nome: 'La Liga 2',                  tier: 'normal', season: 2025 },
  { id: 79,  nome: '2. Bundesliga',              tier: 'normal', season: 2025 },
  { id: 62,  nome: 'Ligue 2',                    tier: 'normal', season: 2025 },
  { id: 89,  nome: 'Eerste Divisie',             tier: 'normal', season: 2025 },
  { id: 119, nome: 'Super League',               tier: 'normal', season: 2025 },
  { id: 271, nome: 'Pro League',                 tier: 'normal', season: 2025 },
  { id: 218, nome: '1. HNL',                     tier: 'normal', season: 2025 },
  { id: 103, nome: 'Eliteserien',                tier: 'normal', season: 2025 },
  // América do Sul (season=2026)
  { id: 13,  nome: 'Copa Libertadores',          tier: 'elite',  season: 2026 },
  { id: 11,  nome: 'Copa Sudamericana',          tier: 'normal', season: 2026 },
  { id: 1,   nome: 'FIFA World Cup',             tier: 'elite',  season: 2026 },
  { id: 9,   nome: 'FIFA Club World Cup',        tier: 'elite',  season: 2025 },
  { id: 6,   nome: 'Copa America',               tier: 'elite',  season: 2024 },
  { id: 71,  nome: 'Brasileirão Série A',        tier: 'normal', season: 2026 },
  { id: 72,  nome: 'Brasileirão Série B',        tier: 'normal', season: 2026 },
  { id: 73,  nome: 'Brasileirão Série C',        tier: 'normal', season: 2026 },
  { id: 75,  nome: 'Copa do Brasil',             tier: 'normal', season: 2026 },
  { id: 74,  nome: 'Copa do Nordeste',           tier: 'normal', season: 2026 },
  { id: 475, nome: 'Carioca Serie A',            tier: 'normal', season: 2026 },
  { id: 476, nome: 'Paulista A1',                tier: 'normal', season: 2026 },
  { id: 484, nome: 'Mineiro 1',                  tier: 'normal', season: 2026 },
  { id: 128, nome: 'Liga Profesional de Fútbol', tier: 'normal', season: 2026 },
  { id: 136, nome: 'Serie B',                    tier: 'normal', season: 2026 },
  // Internacionais
  { id: 10,  nome: 'Friendlies',                 tier: 'normal', season: 2026 },
  { id: 960, nome: 'UEFA Nations League',        tier: 'normal', season: 2024 },
  { id: 34,  nome: 'Euro Qualification',         tier: 'normal', season: 2024 },
];

const ELITE_IDS = new Set(LIGAS.filter(l => l.tier === 'elite').map(l => l.id));

// Termos bloqueados (feminino, sub, reservas)
const BLOCKED_TERMS = [
  /\bwomen\b/i, /\bfeminin/i, /\bmulher/i, /\bfemenin/i, /\bdames\b/i,
  /\bu\d{2}\b/i, /\bunder.?\d{2}\b/i, /\bsub.?\d{2}\b/i,
  /\breserve/i, /\breserva/i, /\bjunior/i, /\byouth/i,
];

function isBlocked(nome) {
  return BLOCKED_TERMS.some(r => r.test(nome));
}

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
// CLIENTES
// ─────────────────────────────────────────────────────────────────

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

// ─────────────────────────────────────────────────────────────────
// HELPERS MATEMÁTICOS — idênticos ao V1
// ─────────────────────────────────────────────────────────────────

const s = v => { try { const f = parseFloat(v); return isNaN(f) ? null : f; } catch { return null; } };

const n = (v, mn, mx) => {
  const f = s(v);
  if (f === null) return null;
  return Math.max(0, Math.min(100, (f - mn) / (mx - mn) * 100));
};

const ws = pairs => {
  const vv = [], ww = [];
  for (const [v, w] of pairs) {
    const f = s(v);
    if (f !== null) { vv.push(f); ww.push(w); }
  }
  if (!ww.length) return 0;
  return vv.reduce((acc, x, i) => acc + x * ww[i], 0) / ww.reduce((a, b) => a + b, 0);
};

const avgNn = (...vals) => {
  const vv = vals.filter(v => v !== null && v !== undefined);
  return vv.length ? vv.reduce((a, b) => a + b, 0) / vv.length : null;
};

// Grade — idêntico ao processar.py (A+≥88, A≥80, B≥70, C≥60)
const grade = score => {
  if (score >= 88) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  return 'D';
};

const risk = score => {
  if (score >= 88) return 'Confiança Alta';
  if (score >= 80) return 'Confiança Média';
  if (score >= 65) return 'Moderado';
  if (score >= 50) return 'Arriscado';
  return 'Evitar';
};

const oddJusta = prob => (prob && prob > 0) ? Math.round(100 / prob * 100) / 100 : null;

const probPoisson = (lam, kMin) => {
  if (!lam || lam <= 0) return null;
  let prob = 0, fac = 1;
  for (let k = 0; k < kMin; k++) {
    if (k > 0) fac *= k;
    prob += (Math.pow(lam, k) * Math.exp(-lam)) / fac;
  }
  return Math.max(0, Math.min(100, (1 - prob) * 100));
};

const pctToFloat = v => {
  try { return parseFloat(String(v).replace('%', '').trim()) || null; }
  catch { return null; }
};

// ─────────────────────────────────────────────────────────────────
// API-FOOTBALL — helper com retry
// ─────────────────────────────────────────────────────────────────

const delay = ms => new Promise(r => setTimeout(r, ms));

async function apiFetch(endpoint, params = {}, retries = 3) {
  const url = new URL(API_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await delay(500); // 500ms entre chamadas = ~120/min
      const res = await fetch(url.toString(), {
        headers: {
          'x-apisports-key':  API_KEY,
          'x-apisports-host': 'v3.football.api-sports.io',
        },
      });

      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') || '60') * 1000;
        LOG.warn(`Rate limit — aguardando ${wait / 1000}s...`);
        await delay(wait);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      const errors = Array.isArray(json?.errors)
        ? json.errors
        : Object.values(json?.errors || {});

      const quotaError = errors.some(e =>
        typeof e === 'string' && /daily.*(limit|quota|exceeded)|quota.*exceeded|requests.*limit.*exceeded/i.test(e)
      );
      if (quotaError) {
        LOG.error('Quota da API esgotada.');
        process.exit(2);
      }

      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await delay(1000 * attempt);
    }
  }
  LOG.warn(`apiFetch falhou: ${endpoint} — ${lastErr?.message}`);
  return { response: [] };
}

// ─────────────────────────────────────────────────────────────────
// COLETA — Team Statistics (idêntico ao V1 get_team_stats)
// ─────────────────────────────────────────────────────────────────

async function getTeamStats(teamId, leagueId, season) {
  const data = await apiFetch('/teams/statistics', { team: teamId, league: leagueId, season });
  const r = data?.response;
  if (!r) return {};

  const goals   = r.goals || {};
  const fixtures = r.fixtures || {};
  const played  = (fixtures.played?.home || 0) + (fixtures.played?.away || 0);
  const wins    = (fixtures.wins?.home || 0) + (fixtures.wins?.away || 0);
  const draws   = (fixtures.draws?.home || 0) + (fixtures.draws?.away || 0);
  const ppg     = played > 0 ? Math.round((wins * 3 + draws) / played * 100) / 100 : null;

  const scoredAvg    = s(goals.for?.average?.total);
  const concededAvg  = s(goals.against?.average?.total);

  const clean    = r.clean_sheet || {};
  const csTotal  = (clean.home || 0) + (clean.away || 0);
  const bttsPct  = played > 0 ? Math.round((1 - csTotal / played) * 1000) / 10 : null;

  const form5 = (r.form || '').slice(-5);

  return { ppg, avg_scored: scoredAvg, avg_conceded: concededAvg, btts_pct: bttsPct, form5, played };
}

// ─────────────────────────────────────────────────────────────────
// COLETA — Recent Fixture Stats (corners, cards, shots)
// idêntico ao V1 get_recent_fixture_stats
// ─────────────────────────────────────────────────────────────────

async function getRecentFixtureStats(teamId, leagueId, season, nGames = 10) {
  const data = await apiFetch('/fixtures', {
    team: teamId, league: leagueId, season, last: nGames, status: 'FT'
  });

  const fixtures = data?.response || [];
  if (!fixtures.length) return {};

  const cornersList = [], cardsList = [], shotsList = [], sotList = [];
  const goalsHtList = [], over05htList = [], over15htList = [];

  for (const fix of fixtures.slice(0, nGames)) {
    const fid = fix.fixture?.id;
    const statData = await apiFetch('/fixtures/statistics', { fixture: fid });
    if (!statData?.response?.length) continue;

    let ch = null, ca = null;
    let yh = 0, rh = 0, ya = 0, ra = 0;
    let sh = null, sa = null, soth = null, sota = null;

    for (const teamStat of statData.response) {
      const stats = {};
      for (const item of (teamStat.statistics || [])) {
        stats[item.type] = item.value;
      }
      const isHome = teamStat.team?.id === teamId;

      if (isHome) {
        ch = s(stats['Corner Kicks']);
        sh = s(stats['Total Shots']);
        soth = s(stats['Shots on Goal']);
        yh = s(stats['Yellow Cards']) || 0;
        rh = s(stats['Red Cards']) || 0;
      } else {
        ca = s(stats['Corner Kicks']);
        sa = s(stats['Total Shots']);
        sota = s(stats['Shots on Goal']);
        ya = s(stats['Yellow Cards']) || 0;
        ra = s(stats['Red Cards']) || 0;
      }
    }

    if (ch !== null && ca !== null) cornersList.push(ch + ca);
    cardsList.push(yh + rh + ya + ra);
    if (sh !== null && sa !== null) shotsList.push(sh + sa);
    if (soth !== null && sota !== null) sotList.push(soth + sota);

    const ht = fix.score?.halftime || {};
    const ghHt = (ht.home || 0) + (ht.away || 0);
    goalsHtList.push(ghHt);
    over05htList.push(ghHt >= 1 ? 1 : 0);
    over15htList.push(ghHt >= 2 ? 1 : 0);
  }

  const safeMean = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100 : null;
  const safePct  = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 1000) / 10 : null;

  const result = {
    avg_corners: safeMean(cornersList),
    avg_cards:   safeMean(cardsList),
    avg_shots:   safeMean(shotsList),
    avg_sot:     safeMean(sotList),
    over05_ht:   safePct(over05htList),
    over15_ht:   safePct(over15htList),
  };

  // Over corners
  for (const [thr, key] of [[6.5,'over65_c'],[7.5,'over75_c'],[8.5,'over85_c'],[9.5,'over95_c'],[10.5,'over105_c']]) {
    result[key] = cornersList.length
      ? Math.round(cornersList.filter(x => x > thr).length / cornersList.length * 1000) / 10
      : null;
  }

  // Over cards
  for (const [thr, key] of [[2.5,'over25_cards'],[3.5,'over35_cards'],[4.5,'over45_cards']]) {
    result[key] = cardsList.length
      ? Math.round(cardsList.filter(x => x > thr).length / cardsList.length * 1000) / 10
      : null;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────
// COLETA — H2H (idêntico ao V1 get_h2h)
// ─────────────────────────────────────────────────────────────────

async function getH2H(homeId, awayId) {
  const data = await apiFetch('/fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: 10 });
  const jogos = data?.response || [];
  if (!jogos.length) return {};

  let golsTotal = 0, o15 = 0, o25 = 0, btts = 0;
  for (const jogo of jogos) {
    const ft = jogo.score?.fulltime || {};
    const gh = ft.home || 0, ga = ft.away || 0;
    const total = gh + ga;
    golsTotal += total;
    if (total >= 2) o15++;
    if (total >= 3) o25++;
    if (gh > 0 && ga > 0) btts++;
  }

  const nJ = jogos.length;
  return {
    h2h_goals:  Math.round(golsTotal / nJ * 100) / 100,
    h2h_over15: Math.round(o15 / nJ * 1000) / 10,
    h2h_over25: Math.round(o25 / nJ * 1000) / 10,
    h2h_btts:   Math.round(btts / nJ * 1000) / 10,
    h2h_n:      nJ,
  };
}

// ─────────────────────────────────────────────────────────────────
// COLETA — Predictions (idêntico ao V1 get_predictions)
// ─────────────────────────────────────────────────────────────────

async function getPredictions(fixtureId) {
  const data = await apiFetch('/predictions', { fixture: fixtureId });
  const r = data?.response?.[0];
  if (!r) return {};

  const pred    = r.predictions || {};
  const percent = pred.percent   || {};
  const comp    = r.comparison   || {};
  const uo      = pred.under_over || {};

  // under_over pode ser { "over": {"1.5": "78%"}, "under": {...} }
  const uoOver = typeof uo.over === 'object' ? uo.over : {};
  const over15Pct = pctToFloat(uoOver['1.5'] ?? uo['1.5'] ?? null);
  const over25Pct = pctToFloat(uoOver['2.5'] ?? uo['2.5'] ?? null);

  const goalsPred = pred.goals || {};
  const bttsPct   = pctToFloat(typeof goalsPred === 'object' ? goalsPred.both : null);

  return {
    pred_winner: pred.winner?.name || null,
    pred_advice: pred.advice || null,
    win_home:    pctToFloat(percent.home),
    win_draw:    pctToFloat(percent.draws),
    win_away:    pctToFloat(percent.away),
    over15_pct:  over15Pct,
    over25_pct:  over25Pct,
    btts_pct:    bttsPct,
    att_h:       pctToFloat(comp.att?.home),
    att_a:       pctToFloat(comp.att?.away),
  };
}

// ─────────────────────────────────────────────────────────────────
// SCORE ENGINE — idêntico ao V1 calcular_scores (coletar.py)
// Thresholds: A+≥88, A≥80, B≥70, C≥60 (processar.py)
// ─────────────────────────────────────────────────────────────────

function calcularScores(jogo) {
  const o15g    = jogo.over15_g,   o25g = jogo.over25_g;
  const o15h    = jogo.over15_h,   o15a = jogo.over15_a;
  const o25h    = jogo.over25_h,   o25a = jogo.over25_a;
  const ppgH    = jogo.ppg_h,      ppgA = jogo.ppg_a;
  const xgH     = jogo.exg_h,      xgA  = jogo.exg_a;
  const h2hG    = jogo.h2h_goals;
  const avgScH  = jogo.avg_sc_h,   avgScA = jogo.avg_sc_a;
  const bttsH   = jogo.btts_h,     bttsA  = jogo.btts_a;
  const avgC    = jogo.avg_corners;
  const o65c    = jogo.over65_c,   o75c = jogo.over75_c,   o85c = jogo.over85_c;
  const o95c    = jogo.over95_c,   o105c = jogo.over105_c;
  const avgShots = jogo.avg_shots, avgCards = jogo.avg_cards;
  const o25cards = jogo.over25_cards, o35cards = jogo.over35_cards;
  const o05ht   = jogo.over05_ht,  o15ht = jogo.over15_ht;
  const u25h    = jogo.under25_h,  u25a  = jogo.under25_a;
  const avgSot  = jogo.avg_sot;

  // Derivados
  const xgTot   = (xgH !== null && xgA !== null) ? xgH + xgA : null;
  const ppgVals = [ppgH, ppgA].filter(x => x !== null);
  const ppgAvg  = ppgVals.length ? ppgVals.reduce((a, b) => a + b, 0) / ppgVals.length : null;
  const ppgMin  = ppgVals.length ? Math.min(...ppgVals) : 0;
  const o15cf   = avgNn(o15h, o15a);
  const o25cf   = avgNn(o25h, o25a);
  const afAvg   = avgNn(avgScH, avgScA);
  const bttsCf  = avgNn(bttsH, bttsA);
  const u25cf   = avgNn(u25h, u25a);
  const sotN    = avgSot !== null ? n(avgSot, 0, 20) : null;

  const probO15 = probPoisson(xgTot, 2);
  const probO25 = probPoisson(xgTot, 3);
  const probU45 = probO15 !== null ? (100 - probPoisson(xgTot, 5)) : null;
  const probU35 = probO15 !== null ? (100 - probPoisson(xgTot, 4)) : null;

  // Normalizações
  const h2hNv  = n(h2hG, 0, 5);
  const ppgN   = n(ppgAvg, 0, 3);
  const afN    = n(afAvg, 0, 4);
  const xgN    = n(xgTot, 0, 5);
  const cantN  = n(avgC, 0, 15);
  const shotsN = n(avgShots, 0, 40);
  const cardsN = n(avgCards, 0, 8);

  // ── Over 1.5 — Modo API (idêntico ao V1 coletar.py)
  // score = over15_pct direto se disponível
  const s15 = o15g !== null ? o15g : ws([[ppgN, 50], [afN, 30], [xgN ?? 50, 20]]);

  // Filtros Via (idêntico ao V1)
  const via1 = xgTot !== null && xgTot >= 4.5;
  const via2 = xgTot !== null && xgTot >= 2.0 && ppgMin >= 0.7;
  const via3 = xgTot === null && (o15g || 0) >= 90 && (ppgAvg || 0) >= 1.5;
  const via4 = (o15g || 0) >= 85;  // predictions alta = qualidade garantida pela API
  const passou = via1 || via2 || via3 || via4;
  const viaStr = via1 ? 'Via 1' : via2 ? 'Via 2' : via3 ? 'Via 3' : via4 ? 'Via 4' : 'Reprovado';

  // ── Over 2.5
  const s25 = xgN !== null
    ? ws([[o25g, 28], [o25cf, 18], [h2hNv, 12], [ppgN, 12], [afN, 8], [xgN, 17], [probO25 ?? 50, 5]])
    : ws([[o25g, 35], [o25cf, 22], [h2hNv, 15], [ppgN, 15], [afN, 13]]);

  // ── BTTS
  const sBtts = ws([[bttsCf, 40], [h2hNv, 15], [ppgN, 15], [afN, 15], [o15g, 10], [xgN ?? 50, 5]]);

  // ── Over 0.5 HT
  const s05ht = o05ht !== null
    ? ws([[o05ht, 45], [o15ht ?? 50, 15], [ppgN, 15], [afN, 15], [sotN ?? 50, 10]])
    : ws([[ppgN, 40], [afN, 30], [o15g ?? 50, 20], [sotN ?? 50, 10]]);

  // ── Under 4.5
  const sU45 = probU45 !== null
    ? ws([[probU45, 35], [u25cf ?? 50, 25], [100 - (xgN ?? 50), 20], [50, 20]])
    : ws([[u25cf ?? 50, 40], [100 - (ppgN ?? 50), 30], [50, 30]]);

  // ── Under 3.5
  const sU35 = probU35 !== null
    ? ws([[probU35, 45], [u25cf ?? 50, 20], [100 - (xgN ?? 50), 25], [50, 10]])
    : ws([[u25cf ?? 50, 50], [100 - (ppgN ?? 50), 30], [50, 20]]);

  const under35ModelOk  = probU35 !== null && xgTot !== null && probU35 >= 78 && xgTot <= 2.5;
  const under35NoXgOk   = probU35 === null && xgTot === null && (u25cf || 0) >= 65 && (ppgAvg === null || ppgAvg <= 1.6);
  const under35BlocksOk = (o25g === null || o25g <= 55) && (h2hG === null || h2hG <= 3.0) && (bttsCf === null || bttsCf <= 75);
  const under35Passou   = sU35 >= 75 && under35BlocksOk && (under35ModelOk || under35NoXgOk);

  // ── Escanteios
  const sEsc75 = ws([[cantN, 40], [o75c, 30], [shotsN, 15], [o65c ?? 50, 10], [ppgN, 5]]);
  const sEsc85 = ws([[cantN, 38], [o85c, 32], [shotsN, 15], [o75c, 10], [ppgN, 5]]);

  // ── Cartões
  const sCards25 = ws([[o25cards, 45], [cardsN, 35], [ppgN, 10], [50, 10]]);
  const sCards35 = ws([[o35cards, 50], [cardsN, 30], [ppgN, 10], [50, 10]]);

  // ── Best market
  const candidatos = [
    ['Over 1.5',    s15,      passou],
    ['Over 2.5',    s25,      true],
    ['BTTS',        sBtts,    true],
    ['Over 0.5 HT', s05ht,    true],
    ['Under 4.5',   sU45,     true],
    ['Under 3.5',   sU35,     under35Passou],
    ['Esc 7.5',     sEsc75,   true],
    ['Cart 2.5',    sCards25, true],
  ];
  const best = candidatos.reduce((a, b) => (b[2] && b[1] > (a[2] ? a[1] : 0)) ? b : a);

  // Justificativas
  const justif15Parts = [];
  if (o15g)   justif15Parts.push(`O1.5 ${Math.round(o15g)}%`);
  if (xgTot)  justif15Parts.push(`xG ${Math.round(xgTot * 10) / 10}`);
  if (ppgAvg) justif15Parts.push(`PPG ${Math.round(ppgAvg * 10) / 10}`);
  if (h2hG)   justif15Parts.push(`H2H ${Math.round(h2hG * 10) / 10} gols`);
  if (viaStr !== 'Reprovado') justif15Parts.push(`${viaStr} ✓`);

  const r = (v) => v !== null ? Math.round(v * 10) / 10 : null;

  return {
    exg_tot:      r(xgTot),
    ppg_avg:      r(ppgAvg),
    ppg_min:      r(ppgMin),
    btts_cf:      r(bttsCf),
    poisson_o15:  r(probO15),
    poisson_o25:  r(probO25),
    poisson_u45:  r(probU45),
    poisson_u35:  r(probU35),

    score_15:     r(s15),
    score_25:     r(s25),
    score_btts:   r(sBtts),
    score_05ht:   r(s05ht),
    score_u45:    r(sU45),
    score_u35:    r(sU35),
    score_esc75:  r(sEsc75),
    score_esc85:  r(sEsc85),
    score_cards25: r(sCards25),
    score_cards35: r(sCards35),

    passou_filtro:  passou,
    via:            viaStr,
    under35_filter: under35Passou,

    grade_15:    passed => grade(s15),
    grade_25:    grade(s25),
    grade_btts:  grade(sBtts),
    grade_05ht:  grade(s05ht),
    grade_u45:   grade(sU45),
    grade_u35:   under35Passou ? grade(sU35) : 'D',
    grade_esc85: grade(sEsc85),
    grade_esc75: grade(sEsc75),
    grade_cart25: grade(sCards25),

    odd_justa_15:    oddJusta(o15g),
    odd_justa_25:    oddJusta(o25g),
    odd_justa_btts:  oddJusta(bttsCf),
    odd_justa_05ht:  oddJusta(o05ht),
    odd_justa_esc85: oddJusta(o85c),
    odd_justa_cart25: oddJusta(o25cards),

    best_mkt:   best[0],
    best_score: r(best[1]),
    best_grade: grade(best[1]),
    best_risk:  risk(best[1]),

    justif_15:   justif15Parts.join(' · ') || 'Dados insuficientes',
    justif_esc:  `Média ${avgC ?? '—'} cant · O8.5: ${o85c ?? '—'}% · O7.5: ${o75c ?? '—'}%`,
    justif_cards: `Média ${avgCards ?? '—'} cart · O2.5: ${o25cards ?? '—'}% · O3.5: ${o35cards ?? '—'}%`,
  };
}

// ─────────────────────────────────────────────────────────────────
// PROCESSAR UM FIXTURE
// ─────────────────────────────────────────────────────────────────

async function processarFixture(fix, liga, teamCache, fixtureCache) {
  const fid    = fix.fixture?.id;
  const homeId = fix.teams?.home?.id;
  const awayId = fix.teams?.away?.id;
  const homeNm = fix.teams?.home?.name;
  const awayNm = fix.teams?.away?.name;
  const hora   = fix.fixture?.date?.slice(11, 16) || '00:00';
  const homeLogo = fix.teams?.home?.logo || null;
  const awayLogo = fix.teams?.away?.logo || null;
  const isElite  = ELITE_IDS.has(liga.id);

  LOG.dim(`    ⚽ ${homeNm} x ${awayNm} [${fid}]`);

  // Team stats com cache
  const tsH = await (async () => {
    const key = `${homeId}_${liga.id}`;
    if (!teamCache[key]) teamCache[key] = await getTeamStats(homeId, liga.id, liga.season);
    return teamCache[key];
  })();

  const tsA = await (async () => {
    const key = `${awayId}_${liga.id}`;
    if (!teamCache[key]) teamCache[key] = await getTeamStats(awayId, liga.id, liga.season);
    return teamCache[key];
  })();

  // Recent fixture stats (corners/cards/shots) com cache
  const rsH = await (async () => {
    const key = `fx_${homeId}_${liga.id}`;
    if (!fixtureCache[key]) fixtureCache[key] = await getRecentFixtureStats(homeId, liga.id, liga.season);
    return fixtureCache[key];
  })();

  const rsA = await (async () => {
    const key = `fx_${awayId}_${liga.id}`;
    if (!fixtureCache[key]) fixtureCache[key] = await getRecentFixtureStats(awayId, liga.id, liga.season);
    return fixtureCache[key];
  })();

  // H2H
  const h2h = await getH2H(homeId, awayId);

  // Predictions
  const preds = await getPredictions(fid);

  // Médias mescladas
  const avgCornersH = rsH.avg_corners, avgCornersA = rsA.avg_corners;
  const avgCorners  = avgNn(avgCornersH, avgCornersA);
  const avgCardsH   = rsH.avg_cards,   avgCardsA   = rsA.avg_cards;
  const avgCards    = avgNn(avgCardsH, avgCardsA);
  const avgShots    = avgNn(rsH.avg_shots, rsA.avg_shots);
  const avgSot      = avgNn(rsH.avg_sot, rsA.avg_sot);
  const avgOver     = key => avgNn(rsH[key], rsA[key]);

  // Over 1.5 / 2.5 — usar predictions direto (idêntico ao V1)
  let o15g = preds.over15_pct ?? null;
  let o25g = preds.over25_pct ?? null;
  let bttsG = preds.btts_pct ?? null;

  // Fallback H2H se predictions sem dados
  if (o15g === null && h2h.h2h_over15 !== undefined) o15g = h2h.h2h_over15;
  if (o25g === null && h2h.h2h_over25 !== undefined) o25g = h2h.h2h_over25;
  if (bttsG === null) bttsG = avgNn(tsH.btts_pct, tsA.btts_pct);

  // xG — proxy via avg_scored (idêntico ao V1)
  const xgH = tsH.avg_scored ?? null;
  const xgA = tsA.avg_scored ?? null;

  const jogo = {
    jogo:      `${homeNm} x ${awayNm}`,
    liga:      liga.nome,
    hora,
    home:      homeNm,
    away:      awayNm,
    fixture_id: fid,
    home_id:   homeId,
    away_id:   awayId,
    is_elite:  isElite,
    home_team_logo: homeLogo,
    away_team_logo: awayLogo,

    odds_h:    null, odds_d: null, odds_a: null,

    over15_g:  o15g,
    over25_g:  o25g,
    over15_h:  null, over15_a: null,
    over25_h:  null, over25_a: null,

    exg_h: xgH, exg_a: xgA,
    ppg_h: tsH.ppg ?? null, ppg_a: tsA.ppg ?? null,

    h2h_goals: h2h.h2h_goals ?? null,
    h2h_n:     h2h.h2h_n     ?? null,

    avg_sc_h: tsH.avg_scored ?? null,
    avg_sc_a: tsA.avg_scored ?? null,
    avg_co_h: tsH.avg_conceded ?? null,
    avg_co_a: tsA.avg_conceded ?? null,

    btts_h: tsH.btts_pct ?? null,
    btts_a: tsA.btts_pct ?? null,

    over05_ht: avgNn(rsH.over05_ht, rsA.over05_ht),
    over15_ht: avgNn(rsH.over15_ht, rsA.over15_ht),

    avg_shots_h: rsH.avg_shots ?? null, avg_shots_a: rsA.avg_shots ?? null,
    avg_sot_h:   rsH.avg_sot   ?? null, avg_sot_a:   rsA.avg_sot   ?? null,
    avg_sot,
    avg_shots:   avgShots,

    avg_corners,
    avg_corners_h: avgCornersH ?? null,
    avg_corners_a: avgCornersA ?? null,
    over65_c:  avgOver('over65_c'),
    over75_c:  avgOver('over75_c'),
    over85_c:  avgOver('over85_c'),
    over95_c:  avgOver('over95_c'),
    over105_c: avgOver('over105_c'),

    avg_cards,
    avg_cards_h: avgCardsH ?? null,
    avg_cards_a: avgCardsA ?? null,
    over25_cards: avgOver('over25_cards'),
    over35_cards: avgOver('over35_cards'),
    over45_cards: avgOver('over45_cards'),

    pred_winner: preds.pred_winner ?? null,
    pred_advice: preds.pred_advice ?? null,
    win_home:    preds.win_home    ?? null,
    win_away:    preds.win_away    ?? null,

    form_h: tsH.form5 ?? null,
    form_a: tsA.form5 ?? null,

    under25_h: null, under25_a: null,
  };

  // Calcular scores
  const scores = calcularScores(jogo);
  Object.assign(jogo, scores);
  jogo.exg_tot = scores.exg_tot;
  jogo.ppg_avg = scores.ppg_avg;
  jogo.ppg_min = scores.ppg_min;
  jogo.btts_cf = scores.btts_cf;

  LOG.dim(`      → score=${jogo.best_score} (${jogo.best_grade}) ${jogo.best_mkt}`);
  return jogo;
}

// ─────────────────────────────────────────────────────────────────
// SALVAR NO SUPABASE
// ─────────────────────────────────────────────────────────────────

const MKT_RESULTADO = {
  'Over 1.5':    'over15_ok',
  'Over 2.5':    'over25_ok',
  'BTTS':        'btts',
  'Over 0.5 HT': 'over05_ht_ok',
  'Under 4.5':   'under45_ok',
  'Under 3.5':   'under35_ok',
  'Esc 7.5':     'esc75_ok',
  'Esc 8.5':     'esc85_ok',
  'Cart 2.5':    'cart25_ok',
  'Cart 3.5':    'cart35_ok',
};

async function salvarNoSupabase(jogo, matchDateISO) {
  // Upsert fixture
  await supabase.from('fixtures').upsert({
    fixture_id:     jogo.fixture_id,
    home_team:      jogo.home,
    away_team:      jogo.away,
    league_name:    jogo.liga,
    match_date:     matchDateISO,
    status:         'NS',
    home_team_logo: jogo.home_team_logo,
    away_team_logo: jogo.away_team_logo,
    source:         'pipeline_v1',
    updated_at:     new Date().toISOString(),
  }, { onConflict: 'fixture_id' });

  // Só salva snapshots com grade A ou A+
  if (!['A+', 'A'].includes(jogo.best_grade)) return false;
  if (!jogo.passou_filtro) return false;

  const { error } = await supabase.from('prediction_snapshots').upsert({
    fixture_id:   jogo.fixture_id,
    match_name:   jogo.jogo,
    match_date:   matchDateISO,
    league:       jogo.liga,
    market:       jogo.best_mkt,
    grade:        jogo.best_grade,
    score:        jogo.best_score,
    odd_value:    jogo.odds_h ?? null,
    result_status: null,

    score_over15: jogo.score_15,
    score_over25: jogo.score_25,
    score_btts:   jogo.score_btts,
    score_esc75:  jogo.score_esc75,
    score_esc85:  jogo.score_esc85,
    score_cart25: jogo.score_cards25,

    over15_g:   jogo.over15_g,
    over25_g:   jogo.over25_g,
    exg_home:   jogo.exg_h,
    exg_away:   jogo.exg_a,
    ppg_home:   jogo.ppg_h,
    ppg_away:   jogo.ppg_a,
    h2h_goals:  jogo.h2h_goals,
    avg_corners: jogo.avg_corners,
    avg_cards:  jogo.avg_cards,
    btts_cf:    jogo.btts_cf,
    via:        jogo.via,

    justif_15:    jogo.justif_15,
    justif_esc:   jogo.justif_esc,
    justif_cards: jogo.justif_cards,

    home_team_logo: jogo.home_team_logo,
    away_team_logo: jogo.away_team_logo,
    source:         'pipeline_v1',
    created_at:     new Date().toISOString(),
  }, { onConflict: 'fixture_id,market' });

  if (error) { LOG.error(`Snapshot error: ${error.message}`); return false; }
  return true;
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n' + '═'.repeat(64));
  console.log(' WinMetrics V3 — Pipeline PackBall v3.0');
  console.log('═'.repeat(64) + '\n');

  if (!API_KEY) { LOG.error('API_FOOTBALL_KEY não configurada.'); process.exit(1); }
  if (!supabase && !DRY_RUN) { LOG.error('Supabase não configurado.'); process.exit(1); }

  // Data
  let dateStr;
  if (dateArg === 'today') {
    dateStr = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  } else {
    dateStr = dateArg.trim();
  }

  // match_date em UTC: converte data BRT para 03:00 UTC
  const [y, m, d] = dateStr.split('-').map(Number);
  const matchDateISO = new Date(Date.UTC(y, m - 1, d, 3, 0, 0)).toISOString();

  LOG.info(`Data: ${dateStr} (${matchDateISO}) | force: ${FORCE} | dry-run: ${DRY_RUN}`);

  const teamCache = {}, fixtureCache = {};
  const stats = { total: 0, snapshots: 0, aPlus: 0, a: 0 };

  for (const liga of LIGAS) {
    LOG.info(`🏆 ${liga.nome}...`);

    const data = await apiFetch('/fixtures', {
      date: dateStr, league: liga.id, season: liga.season,
      timezone: 'America/Sao_Paulo',
    });

    const fixtures = (data?.response || []).filter(fix => {
      const status = fix.fixture?.status?.short;
      const STATUS_OK = new Set(['NS', '1H', 'HT', '2H', 'ET', 'P', 'LIVE', 'FT', 'AET', 'PEN']);
      if (!STATUS_OK.has(status)) return false;
      const nome = `${fix.league?.name} ${fix.teams?.home?.name} ${fix.teams?.away?.name}`;
      return !isBlocked(nome);
    });

    if (!fixtures.length) continue;
    LOG.dim(`  → ${fixtures.length} fixture(s)`);

    for (const fix of fixtures) {
      try {
        const jogo = await processarFixture(fix, liga, teamCache, fixtureCache);
        stats.total++;

        if (jogo.best_grade === 'A+') stats.aPlus++;
        if (jogo.best_grade === 'A') stats.a++;

        if (!DRY_RUN && supabase) {
          const saved = await salvarNoSupabase(jogo, matchDateISO);
          if (saved) {
            stats.snapshots++;
            LOG.ok(`  ✓ ${jogo.jogo} | ${jogo.best_mkt} | ${jogo.best_grade} | score=${jogo.best_score}`);
          }
        } else if (['A+', 'A'].includes(jogo.best_grade) && jogo.passou_filtro) {
          LOG.ok(`  [DRY] ${jogo.jogo} | ${jogo.best_mkt} | ${jogo.best_grade} | score=${jogo.best_score}`);
          stats.snapshots++;
        }
      } catch (err) {
        LOG.error(`  Erro em ${fix.teams?.home?.name} x ${fix.teams?.away?.name}:`, err.message);
      }
    }
  }

  console.log('\n' + '─'.repeat(64));
  console.log(` Fixtures processados: ${stats.total}`);
  console.log(` Snapshots (A+/A):     ${stats.snapshots} (${stats.aPlus} A+ · ${stats.a} A)`);
  console.log('═'.repeat(64) + '\n');
}

run().catch(err => {
  LOG.error('Erro fatal:', err.message);
  process.exit(1);
});
