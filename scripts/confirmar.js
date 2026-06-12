#!/usr/bin/env node
/**
 * WinMetrics V3 — Confirmar Resultados
 * ─────────────────────────────────────────────────────────────────
 * Equivalente ao confirmar.py do V1.
 * Busca resultados reais na API-Football e atualiza result_status
 * ('green' ou 'red') em prediction_snapshots no Supabase.
 *
 * Fluxo:
 *   1. Busca prediction_snapshots do dia sem result_status
 *   2. Para cada fixture, busca resultado real na API (/fixtures status=FT)
 *   3. Busca estatísticas (/fixtures/statistics) → cantos e cartões
 *   4. Calcula se o mercado acertou (green) ou errou (red)
 *   5. Atualiza prediction_snapshots SET result_status, confirmed_at
 *   6. Atualiza fixtures SET goals_home, goals_away
 *
 * Uso:
 *   node scripts/confirmar.js
 *   node scripts/confirmar.js --date=2026-06-10
 *   node scripts/confirmar.js --date=2026-06-10 --force   (re-confirma mesmo já confirmados)
 *   node scripts/confirmar.js --days=3                    (confirma últimos 3 dias)
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL          — URL do projeto Supabase
 *   SUPABASE_SERVICE_KEY  — service_role key (bypass RLS)
 *   API_FOOTBALL_KEY      — chave da API-Football v3
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL         || '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';
const API_KEY       = process.env.API_FOOTBALL_KEY     || '';
const API_BASE      = 'https://v3.football.api-sports.io';

const args     = process.argv.slice(2);
const dateArg  = args.find(a => a.startsWith('--date='))?.split('=')[1];
const daysArg  = args.find(a => a.startsWith('--days='))?.split('=')[1];
const FORCE    = args.includes('--force');
const DAYS     = parseInt(daysArg || '1', 10);

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
// MAPEAMENTO MERCADO → CAMPO RESULTADO (idêntico ao V1 confirmar.py)
// ─────────────────────────────────────────────────────────────────

const MKT_RESULTADO = {
  'Over 1.5':      'over15_ok',
  'Over 1.5 gols': 'over15_ok',
  'Over 2.5':      'over25_ok',
  'Over 2.5 gols': 'over25_ok',
  'BTTS':        'btts',
  'Over 0.5 HT': 'over05_ht_ok',
  'Under 4.5':      'under45_ok',
  'Under 4.5 gols': 'under45_ok',
  'Under 3.5':      'under35_ok',
  'Under 3.5 gols': 'under35_ok',
  'Esc 7.5':          'esc75_ok',
  'Over 7.5 cantos':  'esc75_ok',
  'Esc 8.5':          'esc85_ok',
  'Over 8.5 cantos':  'esc85_ok',
  'Cart 2.5':          'cart25_ok',
  'Over 2.5 cartão':   'cart25_ok',
  'Cart 3.5':          'cart35_ok',
  'Over 3.5 cartão':   'cart35_ok',
  'Cart 5.5':          'cart55_ok',
  'Over 5.5 cartão':   'cart55_ok',
};

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

const delay = ms => new Promise(r => setTimeout(r, ms));

function todayBRT() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Normaliza nome de time para matching (igual ao V1)
function normalizar(nome) {
  if (!nome) return '';
  return nome
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // remove acentos
    .replace(/\s+(fc|cf|sc|ac|fk|if|bk|sk)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────
// API-FOOTBALL — chamada com retry
// ─────────────────────────────────────────────────────────────────

async function apiFetch(endpoint, params = {}, retries = 3) {
  const url = new URL(API_BASE + endpoint);
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

      if (res.status === 429) {
        const wait = Math.pow(2, attempt) * 2000;
        LOG.warn(`Rate limit em ${endpoint} — aguardando ${wait}ms...`);
        await delay(wait);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const json = await res.json();
      const apiErrors = Array.isArray(json?.errors)
        ? json.errors
        : Object.values(json?.errors || {});
      const quotaError = apiErrors.some(e =>
        typeof e === 'string' && /daily.*(limit|quota|exceeded)|quota.*exceeded|requests.*limit.*exceeded|upgrade.*plan/i.test(e)
      );
      if (quotaError) {
        LOG.error('Quota da API esgotada. Encerrando confirmar.');
        process.exit(2);
      }

      return json;

    } catch (err) {
      lastErr = err;
      if (attempt < retries) await delay(1000 * attempt);
    }
  }

  LOG.error(`apiFetch falhou: ${endpoint}`, lastErr?.message);
  return { response: [] };
}

// ─────────────────────────────────────────────────────────────────
// BUSCAR RESULTADO REAL DE UM FIXTURE
// ─────────────────────────────────────────────────────────────────

async function buscarResultado(fixtureId) {
  const data = await apiFetch('/fixtures', { id: fixtureId });
  const fx   = data?.response?.[0];
  if (!fx) return null;

  const status = fx.fixture?.status?.short;
  const FINAIS = new Set(['FT', 'AET', 'PEN', 'FT_PEN', 'AWD', 'WO']);
  if (!FINAIS.has(status)) return null;   // jogo ainda não terminou

  const ft = fx.score?.fulltime  || {};
  const ht = fx.score?.halftime  || {};
  const gh_ft = ft.home ?? 0;
  const ga_ft = ft.away ?? 0;
  const gh_ht = ht.home ?? 0;
  const ga_ht = ht.away ?? 0;

  // Buscar estatísticas (cantos e cartões)
  await delay(300);
  const statData = await apiFetch('/fixtures/statistics', { fixture: fixtureId });
  let cornersTotal = null, cardsTotal = null;

  if (statData?.response?.length) {
    cornersTotal = 0;
    cardsTotal   = 0;
    for (const teamStat of statData.response) {
      for (const item of (teamStat.statistics || [])) {
        const t = item.type || '';
        const v = parseInt(item.value) || 0;
        if (t === 'Corner Kicks')                  cornersTotal += v;
        if (t === 'Yellow Cards' || t === 'Red Cards') cardsTotal += v;
      }
    }
  }

  return {
    status,
    goals_home:   gh_ft,
    goals_away:   ga_ft,
    gols_total:   gh_ft + ga_ft,
    gols_ht:      gh_ht + ga_ht,
    // Campos de resultado por mercado (idêntico ao V1)
    over15_ok:    (gh_ft + ga_ft) >= 2,
    over25_ok:    (gh_ft + ga_ft) >= 3,
    under35_ok:   (gh_ft + ga_ft) <= 3,
    under45_ok:   (gh_ft + ga_ft) <= 4,
    btts:         gh_ft > 0 && ga_ft > 0,
    over05_ht_ok: (gh_ht + ga_ht) >= 1,
    esc75_ok:     cornersTotal !== null ? cornersTotal > 7.5  : null,
    esc85_ok:     cornersTotal !== null ? cornersTotal > 8.5  : null,
    cart25_ok:    cardsTotal   !== null ? cardsTotal   > 2.5  : null,
    cart35_ok:    cardsTotal   !== null ? cardsTotal   > 3.5  : null,
    cart55_ok:    cardsTotal   !== null ? cardsTotal   > 5.5  : null,
    corners_total: cornersTotal,
    cards_total:   cardsTotal,
  };
}

// ─────────────────────────────────────────────────────────────────
// CALCULAR result_status
// ─────────────────────────────────────────────────────────────────

function calcResultStatus(market, resultado) {
  if (String(market || '').startsWith('Resultado Final (1X2)')) {
    const gh = resultado.goals_home;
    const ga = resultado.goals_away;
    if (gh === null || gh === undefined || ga === null || ga === undefined) return null;
    const homeWin = gh > ga;
    const awayWin = ga > gh;
    const draw = gh === ga;
    const isHome = market.includes('Casa');
    const isAway = market.includes('Visitante');

    if (market.includes('Vitória')) {
      return ((isHome && homeWin) || (isAway && awayWin)) ? 'green' : 'red';
    }
    if (market.includes('DNB')) {
      if (draw) return null;
      return ((isHome && homeWin) || (isAway && awayWin)) ? 'green' : 'red';
    }
    if (market.includes('Dupla Chance')) {
      const lost = (isHome && awayWin) || (isAway && homeWin);
      return lost ? 'red' : 'green';
    }
  }

  const campo = MKT_RESULTADO[market];
  if (!campo) return null;
  const acertou = resultado[campo];
  if (acertou === true)  return 'green';
  if (acertou === false) return 'red';
  return null;   // sem dados suficientes (ex: cantos não coletados)
}

// ─────────────────────────────────────────────────────────────────
// BUSCAR SNAPSHOTS DO DIA SEM RESULTADO
// ─────────────────────────────────────────────────────────────────

async function fetchSnapshotsPendentes(dateStr) {
  // Converte YYYY-MM-DD BRT para range UTC
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0)).toISOString();
  const end   = new Date(Date.UTC(y, m - 1, d, 23, 59, 59)).toISOString();

  let q = supabase
    .from('prediction_snapshots')
    .select('id, fixture_id, market, result_status, match_name, match_date')
    .gte('match_date', start)
    .lte('match_date', end)
    .order('fixture_id');

  if (!FORCE) {
    q = q.is('result_status', null);
  }

  const { data, error } = await q;
  if (error) {
    LOG.error('Erro ao buscar snapshots:', error.message);
    return [];
  }
  return data || [];
}

// ─────────────────────────────────────────────────────────────────
// ATUALIZAR SNAPSHOT NO SUPABASE
// ─────────────────────────────────────────────────────────────────

async function atualizarSnapshot(id, resultStatus, resultado) {
  const { error } = await supabase
    .from('prediction_snapshots')
    .update({
      result_status: resultStatus,
      confirmed_at:  new Date().toISOString(),
    })
    .eq('id', id);

  if (error) {
    LOG.error(`Erro ao atualizar snapshot ${id}:`, error.message);
    return false;
  }
  return true;
}

async function atualizarFixture(fixtureId, resultado) {
  const { error } = await supabase
    .from('fixtures')
    .update({
      goals_home: resultado.goals_home,
      goals_away: resultado.goals_away,
      status:     resultado.status,
    })
    .eq('fixture_id', fixtureId);

  if (error) {
    LOG.warn(`Erro ao atualizar fixture ${fixtureId}:`, error.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// PROCESSAR UM DIA
// ─────────────────────────────────────────────────────────────────

async function processarDia(dateStr) {
  LOG.info(`Confirmando resultados para ${dateStr}...`);

  const snapshots = await fetchSnapshotsPendentes(dateStr);
  if (!snapshots.length) {
    LOG.dim(`  Nenhum snapshot pendente em ${dateStr}`);
    return { green: 0, red: 0, sem_dados: 0, nao_finalizado: 0 };
  }

  LOG.info(`  ${snapshots.length} snapshot(s) para confirmar`);

  // Agrupa por fixture_id para buscar API uma vez por jogo
  const byFixture = {};
  for (const snap of snapshots) {
    if (!byFixture[snap.fixture_id]) byFixture[snap.fixture_id] = [];
    byFixture[snap.fixture_id].push(snap);
  }

  const stats = { green: 0, red: 0, sem_dados: 0, nao_finalizado: 0 };

  for (const [fixtureId, snaps] of Object.entries(byFixture)) {
    const matchName = snaps[0].match_name || fixtureId;

    await delay(500);   // evita rate limit
    const resultado = await buscarResultado(Number(fixtureId));

    if (!resultado) {
      LOG.dim(`  ⏳ ${matchName} — ainda não finalizado`);
      stats.nao_finalizado += snaps.length;
      continue;
    }

    // Atualiza fixture com placar real
    await atualizarFixture(Number(fixtureId), resultado);

    const placar = `${resultado.goals_home}-${resultado.goals_away}`;

    for (const snap of snaps) {
      const resultStatus = calcResultStatus(snap.market, resultado);

      if (resultStatus === null) {
        LOG.warn(`  ? ${matchName} ${placar} | ${snap.market} — sem dados suficientes`);
        stats.sem_dados++;
        continue;
      }

      const ok = await atualizarSnapshot(snap.id, resultStatus, resultado);
      if (ok) {
        const emoji = resultStatus === 'green' ? '✓' : '✗';
        const cor   = resultStatus === 'green' ? '\x1b[32m' : '\x1b[31m';
        LOG.ok(`  ${cor}${emoji}\x1b[0m ${matchName} ${placar} | ${snap.market} → ${resultStatus.toUpperCase()}`);
        stats[resultStatus]++;
      }
    }
  }

  return stats;
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n' + '═'.repeat(64));
  console.log(' WinMetrics V3 — Confirmar Resultados');
  console.log('═'.repeat(64) + '\n');

  if (!API_KEY) {
    LOG.error('API_FOOTBALL_KEY não configurada. Abortando.');
    process.exit(1);
  }
  if (!supabase) {
    LOG.error('SUPABASE_URL ou SUPABASE_SERVICE_KEY não configurados. Abortando.');
    process.exit(1);
  }

  // Determina datas a processar
  const baseDate = dateArg || addDays(todayBRT(), -1);  // default: ontem
  const dates = [];
  for (let i = 0; i < DAYS; i++) {
    dates.push(addDays(baseDate, -i));
  }

  LOG.info(`Datas: ${dates.join(', ')} | force: ${FORCE}`);

  const totais = { green: 0, red: 0, sem_dados: 0, nao_finalizado: 0 };

  for (const dateStr of dates) {
    const stats = await processarDia(dateStr);
    totais.green         += stats.green;
    totais.red           += stats.red;
    totais.sem_dados     += stats.sem_dados;
    totais.nao_finalizado += stats.nao_finalizado;
  }

  // Relatório final
  console.log('\n' + '─'.repeat(64));
  console.log(' Resultado');
  console.log('─'.repeat(64));
  console.log(` \x1b[32m✓ Greens:\x1b[0m       ${totais.green}`);
  console.log(` \x1b[31m✗ Reds:\x1b[0m         ${totais.red}`);
  console.log(` ? Sem dados:      ${totais.sem_dados}`);
  console.log(` ⏳ Não finalizado: ${totais.nao_finalizado}`);
  console.log('═'.repeat(64) + '\n');
}

run().catch(err => {
  LOG.error('Erro fatal:', err.message);
  process.exit(1);
});
