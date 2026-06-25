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
  // Gols
  'Over 1.5':          'over15_ok',
  'Over 1.5 gols':     'over15_ok',
  'Over 2.5':          'over25_ok',
  'Over 2.5 gols':     'over25_ok',
  'BTTS':              'btts',
  'Over 0.5 HT':       'over05_ht_ok',
  'Under 4.5':         'under45_ok',
  'Under 4.5 gols':    'under45_ok',
  'Under 3.5':         'under35_ok',
  'Under 3.5 gols':    'under35_ok',
  // Escanteios
  'Esc 6.5':           'esc65_ok',
  'Over 6.5 cantos':   'esc65_ok',
  'Esc 7.5':           'esc75_ok',
  'Over 7.5 cantos':   'esc75_ok',
  'Esc 8.5':           'esc85_ok',
  'Over 8.5 cantos':   'esc85_ok',
  // Escanteios Under
  'Under 11.5':        'under115_ok',
  'Under 11.5 cantos': 'under115_ok',
  'Under 12.5':        'under125_ok',
  'Under 12.5 cantos': 'under125_ok',
  'Under 13.5':        'under135_ok',
  'Under 13.5 cantos': 'under135_ok',
  // Cartões
  'Cart 2.5':          'cart25_ok',
  'Over 2.5 cartão':   'cart25_ok',
  'Cart 3.5':          'cart35_ok',
  'Over 3.5 cartão':   'cart35_ok',
  // Vencer (Resultado Final 1X2) — wc_resultado_final / club_resultado_final
  // Esses mercados dependem de home_team/away_team para saber quem ganhou.
  // calcResultStatus() usa lógica especial (ver abaixo) quando campo = 'vitoria_casa_ok' / 'vitoria_visitante_ok'.
  'Vitória da Casa':      'vitoria_casa_ok',
  'Vitória do Visitante': 'vitoria_visitante_ok',
  // Dupla Chance — wc_dupla_chance / club_dupla_chance
  // 1X = casa vence OU empata. X2 = fora vence OU empata.
  'Dupla Chance 1X':    'dupla_chance_1x_ok',
  'Dupla Chance X2':    'dupla_chance_x2_ok',
  // WC Gols — labels do wc_gols_engine.js (MARKET_LABELS)
  'BTTS Sim':              'btts',
  'BTTS Não':              'nobtts_ok',
  // WC Escanteios — labels do wc_escanteios_engine.js (MARKET_LABELS)
  'Over 7.5 Escanteios':   'esc75_ok',
  'Over 8.5 Escanteios':   'esc85_ok',
  'Over 9.5 Escanteios':   'esc95_ok',
  'Under 10.5 Escanteios': 'under105_ok',
  'Under 11.5 Escanteios': 'under115_ok',
  // WC Cartões — labels do wc_cartoes_engine.js (MARKET_LABELS)
  'Over 2.5 Cartões':  'cart25_ok',
  'Over 3.5 Cartões':  'cart35_ok',
  'Over 4.5 Cartões':  'cart45_ok',
  'Under 5.5 Cartões': 'under55_cart_ok',
  'Under 6.5 Cartões': 'under65_cart_ok',
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

  // Nomes dos times para resolver mercados Vencer/Dupla Chance
  const homeTeamApi = fx.teams?.home?.name ?? null;
  const awayTeamApi = fx.teams?.away?.name ?? null;

  // Quem ganhou?
  const homeWon  = gh_ft > ga_ft;
  const awayWon  = ga_ft > gh_ft;
  const draw     = gh_ft === ga_ft;

  return {
    status,
    goals_home:   gh_ft,
    goals_away:   ga_ft,
    gols_total:   gh_ft + ga_ft,
    gols_ht:      gh_ht + ga_ht,
    home_team_api: homeTeamApi,
    away_team_api: awayTeamApi,
    // Campos de resultado por mercado (idêntico ao V1)
    over15_ok:    (gh_ft + ga_ft) >= 2,
    over25_ok:    (gh_ft + ga_ft) >= 3,
    under35_ok:   (gh_ft + ga_ft) <= 3,
    under45_ok:   (gh_ft + ga_ft) <= 4,
    btts:         gh_ft > 0 && ga_ft > 0,
    over05_ht_ok: (gh_ht + ga_ht) >= 1,
    esc65_ok:     cornersTotal !== null ? cornersTotal > 6.5  : null,
    esc75_ok:     cornersTotal !== null ? cornersTotal > 7.5  : null,
    esc85_ok:     cornersTotal !== null ? cornersTotal > 8.5  : null,
    under115_ok:  cornersTotal !== null ? cornersTotal < 11.5 : null,
    under125_ok:  cornersTotal !== null ? cornersTotal < 12.5 : null,
    under135_ok:  cornersTotal !== null ? cornersTotal < 13.5 : null,
    under105_ok:  cornersTotal !== null ? cornersTotal < 10.5 : null,
    esc95_ok:     cornersTotal !== null ? cornersTotal > 9.5  : null,
    cart25_ok:    cardsTotal   !== null ? cardsTotal   > 2.5  : null,
    cart35_ok:    cardsTotal   !== null ? cardsTotal   > 3.5  : null,
    cart45_ok:    cardsTotal   !== null ? cardsTotal   > 4.5  : null,
    under55_cart_ok: cardsTotal !== null ? cardsTotal  < 5.5  : null,
    under65_cart_ok: cardsTotal !== null ? cardsTotal  < 6.5  : null,
    corners_total: cornersTotal,
    cards_total:   cardsTotal,
    // Vencer (Resultado Final 1X2)
    vitoria_casa_ok:       homeWon,
    vitoria_visitante_ok:  awayWon,
    // Dupla Chance: 1X = casa vence OU empata; X2 = fora vence OU empata
    dupla_chance_1x_ok:    homeWon || draw,
    dupla_chance_x2_ok:    awayWon || draw,
    // WC Gols: BTTS Não
    nobtts_ok:    !(gh_ft > 0 && ga_ft > 0),  // true quando pelo menos um time não marcou
  };
}

// ─────────────────────────────────────────────────────────────────
// CALCULAR result_status
// ─────────────────────────────────────────────────────────────────

function calcResultStatus(market, resultado) {
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
  // BRT = UTC-3, então um dia BRT vai de UTC-3h até UTC+21h do mesmo dia
  // Para cobrir jogos salvos em qualquer fuso, usamos UTC-3 como início e UTC+3 como fim
  const [y, m, d] = dateStr.split('-').map(Number);
  // 00:00 BRT = 03:00 UTC | 23:59 BRT = 02:59 UTC do dia seguinte
  const startDate = new Date(Date.UTC(y, m - 1, d, 3, 0, 0));
  const endDate   = new Date(Date.UTC(y, m - 1, d, 3, 0, 0));
  endDate.setUTCDate(endDate.getUTCDate() + 1); // avança 1 dia
  endDate.setUTCMinutes(endDate.getUTCMinutes() - 1); // 02:59 UTC do dia seguinte
  const start = startDate.toISOString();
  const end   = endDate.toISOString();

  let q = supabase
    .from('prediction_snapshots')
    .select('id, fixture_id, market, result_status, match_name, match_date, home_team, away_team')
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
  const update = {
    goals_home:    resultado.goals_home,
    goals_away:    resultado.goals_away,
    status:        resultado.status,
  };
  if (resultado.corners_total !== null && resultado.corners_total !== undefined) {
    update.corners_total = resultado.corners_total;
  }
  if (resultado.cards_total !== null && resultado.cards_total !== undefined) {
    update.cards_total = resultado.cards_total;
  }

  const { error } = await supabase
    .from('fixtures')
    .update(update)
    .eq('fixture_id', fixtureId);

  if (error) {
    LOG.warn(`Erro ao atualizar fixture ${fixtureId}:`, error.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// PROCESSAR UM DIA
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// MERCADOS VENCER / DUPLA CHANCE — buscar em predictions e confirmar
// ─────────────────────────────────────────────────────────────────

const VENCER_MARKETS      = ['Vitória da Casa', 'Vitória do Visitante'];
const DUPLA_CHANCE_MARKETS = ['Dupla Chance 1X', 'Dupla Chance X2'];
const VENCER_ALL_MARKETS  = [...VENCER_MARKETS, ...DUPLA_CHANCE_MARKETS];

/**
 * Busca previsões de Vencer/Dupla Chance na tabela `predictions` para fixtures
 * do dia que ainda não têm snapshot confirmado nesses mercados.
 */
async function fetchVencerPendentes(fixtureIds) {
  if (!fixtureIds.length) return [];

  // Busca predictions de Vencer/Dupla Chance
  const { data: preds, error } = await supabase
    .from('predictions')
    .select('fixture_id, market, score, grade, odd')
    .in('fixture_id', fixtureIds)
    .in('market', VENCER_ALL_MARKETS);

  if (error || !preds?.length) return [];

  // Verifica quais já foram confirmados em prediction_snapshots
  const { data: existing } = await supabase
    .from('prediction_snapshots')
    .select('fixture_id, market, result_status')
    .in('fixture_id', fixtureIds)
    .in('market', VENCER_ALL_MARKETS);

  const confirmedSet = new Set(
    (existing || [])
      .filter(s => s.result_status !== null)
      .map(s => `${s.fixture_id}__${s.market}`)
  );

  // Retorna apenas os ainda pendentes (ou todos se FORCE)
  return preds.filter(p =>
    FORCE || !confirmedSet.has(`${p.fixture_id}__${p.market}`)
  );
}

/**
 * Cria ou atualiza snapshot em prediction_snapshots para mercados Vencer/Dupla Chance.
 * Usa dados do fixture (da tabela fixtures) para montar o row completo.
 */
async function confirmarVencerPred(pred, resultado, fixtureInfo) {
  const resultStatus = calcResultStatus(pred.market, resultado);
  if (resultStatus === null) return null;

  const row = {
    fixture_id:     pred.fixture_id,
    match_name:     fixtureInfo.match_name,
    home_team:      fixtureInfo.home_team,
    away_team:      fixtureInfo.away_team,
    home_team_logo: fixtureInfo.home_team_logo ?? null,
    away_team_logo: fixtureInfo.away_team_logo ?? null,
    league_name:    fixtureInfo.league_name,
    match_date:     fixtureInfo.match_date,
    hour:           fixtureInfo.hour ?? null,
    market:         pred.market,
    score:          pred.score,
    grade:          pred.grade,
    odd:            pred.odd ?? null,
    result_status:  resultStatus,
    confirmed_at:   new Date().toISOString(),
    source:         'confirmar_vencer',
    created_at:     new Date().toISOString(),
  };

  const { error } = await supabase
    .from('prediction_snapshots')
    .upsert(row, { onConflict: 'fixture_id,market' });

  if (error) {
    LOG.error(`  Erro ao salvar snapshot Vencer ${pred.fixture_id} ${pred.market}:`, error.message);
    return null;
  }
  return resultStatus;
}

// ─────────────────────────────────────────────────────────────────
// WC VENCER SNAPSHOTS — confirmar resultado para jogos Copa do Mundo
// calculados inline pelo wc_vencer_engine (não passam por predictions)
// ─────────────────────────────────────────────────────────────────

/**
 * Busca registros de wc_vencer_snapshots do dia que ainda não têm result_status.
 */
async function fetchWcVencerPendentes(fixtureIds) {
  if (!fixtureIds.length) return [];

  const { data, error } = await supabase
    .from('wc_vencer_snapshots')
    .select('id, fixture_id, market, pick, pick_label, score, grade, odd, probability')
    .in('fixture_id', fixtureIds)
    .is('result_status', null);

  if (error || !data?.length) return [];

  // Se FORCE, retorna todos; senão só os pendentes (result_status null)
  return data;
}

/**
 * Calcula e grava result_status em wc_vencer_snapshots.
 */
async function confirmarWcVencer(snap, resultado, fixtureInfo) {
  // Mapear pick para market equivalente e calcular resultado.
  // Se pick = 'evitar' (snapshots antigos), usa favored_team para descobrir
  // se era home ou away e confirma normalmente.
  let resultStatus = null;
  let effectivePick = snap.pick;

  // Resolve pick 'evitar' usando favored_team vs home_team
  if (effectivePick === 'evitar' && snap.favored_team) {
    const norm = s => String(s||'').toLowerCase().trim();
    effectivePick = norm(snap.favored_team) === norm(fixtureInfo.home_team) ? 'home' : 'away';
  }

  if (effectivePick === 'home' || snap.market === 'Vitória da Casa') {
    resultStatus = calcResultStatus('Vitória da Casa', resultado);
  } else if (effectivePick === 'away' || snap.market === 'Vitória do Visitante') {
    resultStatus = calcResultStatus('Vitória do Visitante', resultado);
  } else if (effectivePick === 'draw' || snap.market === 'Empate') {
    if (resultado.goals_home !== null && resultado.goals_away !== null) {
      resultStatus = resultado.goals_home === resultado.goals_away ? 'green' : 'red';
    }
  }

  if (resultStatus === null) return null;

  const { error } = await supabase
    .from('wc_vencer_snapshots')
    .update({
      result_status: resultStatus,
      confirmed_at:  new Date().toISOString(),
    })
    .eq('id', snap.id);

  if (error) {
    LOG.error(`  Erro ao confirmar wc_vencer_snapshot ${snap.fixture_id}:`, error.message);
    return null;
  }

  // Espelha também em prediction_snapshots para o frontend ler result_status
  const market = snap.pick === 'home' ? 'Vitória da Casa'
               : snap.pick === 'away' ? 'Vitória do Visitante'
               : 'Empate';

  const row = {
    fixture_id:     snap.fixture_id,
    match_name:     fixtureInfo.match_name,
    home_team:      fixtureInfo.home_team,
    away_team:      fixtureInfo.away_team,
    home_team_logo: fixtureInfo.home_team_logo ?? null,
    away_team_logo: fixtureInfo.away_team_logo ?? null,
    league_name:    fixtureInfo.league_name,
    match_date:     fixtureInfo.match_date,
    hour:           fixtureInfo.hour ?? null,
    market,
    score:          snap.score  ?? null,
    grade:          snap.grade  ?? null,
    odd:            snap.odd    ?? null,
    result_status:  resultStatus,
    confirmed_at:   new Date().toISOString(),
    source:         'confirmar_wc_vencer',
    created_at:     new Date().toISOString(),
  };

  const { error: err2 } = await supabase
    .from('prediction_snapshots')
    .upsert(row, { onConflict: 'fixture_id,market' });

  if (err2) {
    LOG.warn(`  Aviso: não foi possível espelhar em prediction_snapshots para fixture ${snap.fixture_id}:`, err2.message);
  }

  return resultStatus;
}

// ─────────────────────────────────────────────────────────────────
// WC GOLS SNAPSHOTS — confirmar resultado para jogos Copa do Mundo
// calculados pelo wc_gols_engine (tabela wc_gols_snapshots)
// ─────────────────────────────────────────────────────────────────

/**
 * Busca registros de wc_gols_snapshots do dia que ainda não têm result_status.
 */
async function fetchWcGolsPendentes(fixtureIds) {
  if (!fixtureIds.length) return [];

  const query = supabase
    .from('wc_gols_snapshots')
    .select('id, fixture_id, market_key, market, score, grade, odd')
    .in('fixture_id', fixtureIds);

  // Se FORCE, busca todos; caso contrário só os sem result_status
  const { data, error } = FORCE
    ? await query
    : await query.is('result_status', null);

  if (error || !data?.length) return [];
  return data;
}

/**
 * Atualiza result_status em wc_gols_snapshots para um snapshot específico.
 */
async function confirmarWcGols(snap, resultado) {
  const resultStatus = calcResultStatus(snap.market, resultado);
  if (resultStatus === null) return null;

  const { error } = await supabase
    .from('wc_gols_snapshots')
    .update({
      result_status: resultStatus,
      confirmed_at:  new Date().toISOString(),
    })
    .eq('id', snap.id);

  if (error) {
    LOG.error(`  Erro ao confirmar wc_gols_snapshot ${snap.fixture_id} ${snap.market}: ${error.message}`);
    return null;
  }
  return resultStatus;
}

// ─────────────────────────────────────────────────────────────────
// WC ESCANTEIOS SNAPSHOTS — confirmar resultado para jogos Copa do Mundo
// calculados pelo wc_escanteios_engine (tabela wc_escanteios_snapshots)
// ─────────────────────────────────────────────────────────────────

/**
 * Busca registros de wc_escanteios_snapshots do dia que ainda não têm result_status.
 */
async function fetchWcEscanteiosPendentes(fixtureIds) {
  if (!fixtureIds.length) return [];

  const query = supabase
    .from('wc_escanteios_snapshots')
    .select('id, fixture_id, market_key, market, score, grade, odd')
    .in('fixture_id', fixtureIds);

  const { data, error } = FORCE
    ? await query
    : await query.is('result_status', null);

  if (error || !data?.length) return [];
  return data;
}

/**
 * Atualiza result_status em wc_escanteios_snapshots para um snapshot específico.
 */
async function confirmarWcEscanteios(snap, resultado) {
  const resultStatus = calcResultStatus(snap.market, resultado);
  if (resultStatus === null) return null;

  const { error } = await supabase
    .from('wc_escanteios_snapshots')
    .update({
      result_status: resultStatus,
      confirmed_at:  new Date().toISOString(),
    })
    .eq('id', snap.id);

  if (error) {
    LOG.error(`  Erro ao confirmar wc_escanteios_snapshot ${snap.fixture_id} ${snap.market}: ${error.message}`);
    return null;
  }
  return resultStatus;
}

// ─────────────────────────────────────────────────────────────────
// WC CARTÕES SNAPSHOTS — confirmar resultado para jogos Copa do Mundo
// calculados pelo wc_cartoes_engine (tabela wc_cartoes_snapshots)
// ─────────────────────────────────────────────────────────────────

async function fetchWcCartoesPendentes(fixtureIds) {
  if (!fixtureIds.length) return [];

  const query = supabase
    .from('wc_cartoes_snapshots')
    .select('id, fixture_id, market_key, market, score, grade, odd')
    .in('fixture_id', fixtureIds);

  const { data, error } = FORCE
    ? await query
    : await query.is('result_status', null);

  if (error || !data?.length) return [];
  return data;
}

async function confirmarWcCartoes(snap, resultado) {
  const resultStatus = calcResultStatus(snap.market, resultado);
  if (resultStatus === null) return null;

  const { error } = await supabase
    .from('wc_cartoes_snapshots')
    .update({
      result_status: resultStatus,
      confirmed_at:  new Date().toISOString(),
    })
    .eq('id', snap.id);

  if (error) {
    LOG.error(`  Erro ao confirmar wc_cartoes_snapshot ${snap.fixture_id} ${snap.market}: ${error.message}`);
    return null;
  }
  return resultStatus;
}
  LOG.info(`Confirmando resultados para ${dateStr}...`);

  const snapshots = await fetchSnapshotsPendentes(dateStr);

  // Coletar todos os fixture_ids do dia (snapshots normais + fixtures direto)
  const allFixtureIds = [...new Set(snapshots.map(s => s.fixture_id))];

  // Buscar também fixtures do dia para processar Vencer (que não têm snapshot ainda)
  const [y, m, d] = dateStr.split('-').map(Number);
  const startDate = new Date(Date.UTC(y, m - 1, d, 3, 0, 0));
  const endDate   = new Date(Date.UTC(y, m - 1, d, 3, 0, 0));
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  endDate.setUTCMinutes(endDate.getUTCMinutes() - 1);

  const { data: fixturesDia } = await supabase
    .from('fixtures')
    .select('fixture_id, home_team, away_team, home_team_logo, away_team_logo, league_name, match_date, hour')
    .gte('match_date', startDate.toISOString())
    .lte('match_date', endDate.toISOString());

  const fixturesDiaIds = (fixturesDia || []).map(f => f.fixture_id);
  const fixturesById   = {};
  (fixturesDia || []).forEach(f => {
    fixturesById[f.fixture_id] = {
      ...f,
      match_name: (f.home_team && f.away_team) ? `${f.home_team} x ${f.away_team}` : String(f.fixture_id),
    };
  });

  // Buscar predictions de Vencer/Dupla Chance pendentes
  const vencerPreds         = await fetchVencerPendentes(fixturesDiaIds);
  const wcVencerPendentes   = await fetchWcVencerPendentes(fixturesDiaIds);
  const wcGolsPendentes     = await fetchWcGolsPendentes(fixturesDiaIds);
  const wcEscanteiosPendentes = await fetchWcEscanteiosPendentes(fixturesDiaIds);
  const wcCartoesPendentes  = await fetchWcCartoesPendentes(fixturesDiaIds);

  const totalPendentes = snapshots.length + vencerPreds.length + wcVencerPendentes.length
    + wcGolsPendentes.length + wcEscanteiosPendentes.length + wcCartoesPendentes.length;

  if (!totalPendentes) {
    LOG.dim(`  Nenhum snapshot pendente em ${dateStr}`);
    return { green: 0, red: 0, sem_dados: 0, nao_finalizado: 0 };
  }

  LOG.info(`  ${snapshots.length} snapshot(s) normais + ${vencerPreds.length} Vencer/Dupla Chance + ${wcGolsPendentes.length} WC Gols + ${wcEscanteiosPendentes.length} WC Escanteios + ${wcCartoesPendentes.length} WC Cartões para confirmar`);

  // Agrupa tudo por fixture_id para chamar API uma vez por jogo
  const byFixture = {};

  for (const snap of snapshots) {
    if (!byFixture[snap.fixture_id]) byFixture[snap.fixture_id] = { snaps: [], vencers: [] };
    byFixture[snap.fixture_id].snaps.push(snap);
  }

  for (const pred of vencerPreds) {
    if (!byFixture[pred.fixture_id]) byFixture[pred.fixture_id] = { snaps: [], vencers: [], wcVencers: [] };
    byFixture[pred.fixture_id].vencers.push(pred);
  }

  for (const snap of wcVencerPendentes) {
    if (!byFixture[snap.fixture_id]) byFixture[snap.fixture_id] = { snaps: [], vencers: [], wcVencers: [] };
    if (!byFixture[snap.fixture_id].wcVencers) byFixture[snap.fixture_id].wcVencers = [];
    byFixture[snap.fixture_id].wcVencers.push(snap);
  }

  for (const snap of wcGolsPendentes) {
    if (!byFixture[snap.fixture_id]) byFixture[snap.fixture_id] = { snaps: [], vencers: [], wcVencers: [], wcGols: [], wcEscanteios: [] };
    if (!byFixture[snap.fixture_id].wcGols) byFixture[snap.fixture_id].wcGols = [];
    byFixture[snap.fixture_id].wcGols.push(snap);
  }

  for (const snap of wcEscanteiosPendentes) {
    if (!byFixture[snap.fixture_id]) byFixture[snap.fixture_id] = { snaps: [], vencers: [], wcVencers: [], wcGols: [], wcEscanteios: [], wcCartoes: [] };
    if (!byFixture[snap.fixture_id].wcEscanteios) byFixture[snap.fixture_id].wcEscanteios = [];
    byFixture[snap.fixture_id].wcEscanteios.push(snap);
  }

  for (const snap of wcCartoesPendentes) {
    if (!byFixture[snap.fixture_id]) byFixture[snap.fixture_id] = { snaps: [], vencers: [], wcVencers: [], wcGols: [], wcEscanteios: [], wcCartoes: [] };
    if (!byFixture[snap.fixture_id].wcCartoes) byFixture[snap.fixture_id].wcCartoes = [];
    byFixture[snap.fixture_id].wcCartoes.push(snap);
  }

  const stats = { green: 0, red: 0, sem_dados: 0, nao_finalizado: 0 };

  for (const [fixtureId, grupo] of Object.entries(byFixture)) {
    const matchName = grupo.snaps[0]?.match_name
      || fixturesById[Number(fixtureId)]?.match_name
      || fixtureId;

    await delay(500);   // evita rate limit
    const resultado = await buscarResultado(Number(fixtureId));

    if (!resultado) {
      LOG.dim(`  ⏳ ${matchName} — ainda não finalizado`);
      const total = grupo.snaps.length + grupo.vencers.length
        + (grupo.wcVencers?.length || 0) + (grupo.wcGols?.length || 0)
        + (grupo.wcEscanteios?.length || 0) + (grupo.wcCartoes?.length || 0);
      stats.nao_finalizado += total;
      continue;
    }

    // Atualiza fixture com placar real
    await atualizarFixture(Number(fixtureId), resultado);

    const placar = `${resultado.goals_home}-${resultado.goals_away}`;

    // ── Snapshots normais (Gols, Escanteios, Cartões) ──
    for (const snap of grupo.snaps) {
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

    // ── WC Vencer (vêm de wc_vencer_snapshots, calculados inline) ──
    for (const snap of (grupo.wcVencers || [])) {
      const fixtureInfo = fixturesById[Number(fixtureId)];
      if (!fixtureInfo) {
        LOG.warn(`  ? ${matchName} — fixture não encontrado para WC Vencer`);
        stats.sem_dados++;
        continue;
      }

      const rs = await confirmarWcVencer(snap, resultado, fixtureInfo);

      if (rs === null) {
        LOG.warn(`  ? ${matchName} ${placar} | WC Vencer (${snap.grade}) — sem dados suficientes`);
        stats.sem_dados++;
      } else {
        const emoji = rs === 'green' ? '✓' : '✗';
        const cor   = rs === 'green' ? '\x1b[32m' : '\x1b[31m';
        LOG.ok(`  ${cor}${emoji}\x1b[0m ${matchName} ${placar} | WC Vencer (${snap.grade}) → ${rs.toUpperCase()}`);
        stats[rs]++;
      }
    }

    // ── WC Gols (vêm de wc_gols_snapshots) ──
    for (const snap of (grupo.wcGols || [])) {
      const rs = await confirmarWcGols(snap, resultado);

      if (rs === null) {
        LOG.warn(`  ? ${matchName} ${placar} | WC Gols ${snap.market} (${snap.grade}) — sem dados suficientes`);
        stats.sem_dados++;
      } else {
        const emoji = rs === 'green' ? '✓' : '✗';
        const cor   = rs === 'green' ? '\x1b[32m' : '\x1b[31m';
        LOG.ok(`  ${cor}${emoji}\x1b[0m ${matchName} ${placar} | WC Gols ${snap.market} (${snap.grade}) → ${rs.toUpperCase()}`);
        stats[rs]++;
      }
    }

    // ── WC Escanteios (vêm de wc_escanteios_snapshots) ──
    for (const snap of (grupo.wcEscanteios || [])) {
      const rs = await confirmarWcEscanteios(snap, resultado);

      if (rs === null) {
        LOG.warn(`  ? ${matchName} ${placar} | WC Esc ${snap.market} (${snap.grade}) — sem dados suficientes`);
        stats.sem_dados++;
      } else {
        const emoji = rs === 'green' ? '✓' : '✗';
        const cor   = rs === 'green' ? '\x1b[32m' : '\x1b[31m';
        LOG.ok(`  ${cor}${emoji}\x1b[0m ${matchName} ${placar} | WC Esc ${snap.market} (${snap.grade}) → ${rs.toUpperCase()}`);
        stats[rs]++;
      }
    }

    // ── WC Cartões (vêm de wc_cartoes_snapshots) ──
    for (const snap of (grupo.wcCartoes || [])) {
      const rs = await confirmarWcCartoes(snap, resultado);

      if (rs === null) {
        LOG.warn(`  ? ${matchName} ${placar} | WC Cart ${snap.market} (${snap.grade}) — sem dados suficientes`);
        stats.sem_dados++;
      } else {
        const emoji = rs === 'green' ? '✓' : '✗';
        const cor   = rs === 'green' ? '\x1b[32m' : '\x1b[31m';
        LOG.ok(`  ${cor}${emoji}\x1b[0m ${matchName} ${placar} | WC Cart ${snap.market} (${snap.grade}) → ${rs.toUpperCase()}`);
        stats[rs]++;
      }
    }

    // ── Vencer / Dupla Chance (vêm de predictions, precisam criar snapshot) ──
    for (const pred of grupo.vencers) {
      const fixtureInfo = fixturesById[Number(fixtureId)];
      if (!fixtureInfo) {
        LOG.warn(`  ? ${matchName} — fixture não encontrado para ${pred.market}`);
        stats.sem_dados++;
        continue;
      }

      const rs = await confirmarVencerPred(pred, resultado, fixtureInfo);

      if (rs === null) {
        LOG.warn(`  ? ${matchName} ${placar} | ${pred.market} (${pred.grade}) — sem dados suficientes`);
        stats.sem_dados++;
      } else {
        const emoji = rs === 'green' ? '✓' : '✗';
        const cor   = rs === 'green' ? '\x1b[32m' : '\x1b[31m';
        LOG.ok(`  ${cor}${emoji}\x1b[0m ${matchName} ${placar} | ${pred.market} (${pred.grade}) → ${rs.toUpperCase()}`);
        stats[rs]++;
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
