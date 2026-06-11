#!/usr/bin/env node
/**
 * WinMetrics — Importar V1 → Supabase V3
 * ─────────────────────────────────────────────────────────────────
 * Lê os JSONs do V1 (docs/data/DD-MM-YYYY.json) e importa os dados
 * para o Supabase V3 nas tabelas fixtures e prediction_snapshots.
 *
 * Fonte dos dados: palpites_snapshot + jogos do JSON do V1
 * Destino: Supabase (fixtures + prediction_snapshots)
 *
 * Uso:
 *   node scripts/import_v1.js --dir=./v1_data
 *   node scripts/import_v1.js --dir=./v1_data --date=24-05-2026
 *   node scripts/import_v1.js --dir=./v1_data --dry-run
 *   node scripts/import_v1.js --dir=./v1_data --force   (re-importa existentes)
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL         — URL do projeto Supabase
 *   SUPABASE_SERVICE_KEY — service_role key (bypass RLS)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL         || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const args    = process.argv.slice(2);
const dirArg  = args.find(a => a.startsWith('--dir='))?.split('=')[1]  || './v1_data';
const dateArg = args.find(a => a.startsWith('--date='))?.split('=')[1] || null;
const DRY_RUN = args.includes('--dry-run');
const FORCE   = args.includes('--force');

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
  skip:  (...a) => console.log (`\x1b[33m[SKIP]\x1b[0m  ${LOG._ts()} `, ...a),
};

// ─────────────────────────────────────────────────────────────────
// SUPABASE
// ─────────────────────────────────────────────────────────────────

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

// ─────────────────────────────────────────────────────────────────
// MAPEAR MKT → campo resultado
// Idêntico ao V1 confirmar.py
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

// ─────────────────────────────────────────────────────────────────
// CONVERTER DATA V1 (DD-MM-YYYY) → ISO UTC
// ─────────────────────────────────────────────────────────────────

function v1DateToISO(ddmmyyyy, hora) {
  // "24-05-2026" + "16:00" → 2026-05-24T19:00:00.000Z (BRT = UTC-3)
  const [dd, mm, yyyy] = ddmmyyyy.split('-').map(Number);
  const [hh, min]      = (hora || '00:00').split(':').map(Number);
  // Converte BRT → UTC (+3h)
  return new Date(Date.UTC(yyyy, mm - 1, dd, hh + 3, min, 0)).toISOString();
}

// ─────────────────────────────────────────────────────────────────
// CALCULAR result_status A PARTIR DO RESULTADO V1
// ─────────────────────────────────────────────────────────────────

function calcResultStatus(mkt, resultado) {
  if (!resultado || resultado.status !== 'FT') return null;
  const campo = MKT_RESULTADO[mkt];
  if (!campo) return null;
  const ok = resultado[campo];
  if (ok === true)  return 'green';
  if (ok === false) return 'red';
  return null;
}

// ─────────────────────────────────────────────────────────────────
// MONTAR FIXTURE PARA SUPABASE
// ─────────────────────────────────────────────────────────────────

function buildFixture(jogo, matchDateISO) {
  const res = jogo.resultado || {};
  return {
    fixture_id:     jogo.fixture_id,
    home_team:      jogo.home,
    away_team:      jogo.away,
    league_name:    jogo.liga,
    match_date:     matchDateISO,
    status:         res.status || 'NS',
    goals_home:     res.gols_home  ?? null,
    goals_away:     res.gols_away  ?? null,
    home_team_logo: null,
    away_team_logo: null,
    best_risk:      jogo.best_risk     ?? null,
    confidence:     jogo.best_risk     ?? null,  // alias para compatibilidade V3
    source:         'v1_import',
    updated_at:     new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────
// MONTAR PREDICTION_SNAPSHOT PARA SUPABASE
// ─────────────────────────────────────────────────────────────────

function buildSnapshot(palpite, jogo, matchDateISO) {
  const res         = palpite.resultado || jogo.resultado || {};
  const resultStatus = calcResultStatus(palpite.mkt, res);

  return {
    fixture_id:     palpite.fixture_id,
    match_name:     palpite.jogo,
    match_date:     matchDateISO,
    league:         palpite.liga,
    market:         palpite.mkt,
    grade:          palpite.grade,
    score:          palpite.score,
    odd_value:      palpite.oddVal   ?? null,
    result_status:  resultStatus,
    confirmed_at:   resultStatus ? new Date().toISOString() : null,

    // Scores por mercado (do jogo completo)
    score_over15:   jogo.score_15     ?? null,
    score_over25:   jogo.score_25     ?? null,
    score_btts:     jogo.score_btts   ?? null,
    score_esc75:    jogo.score_esc75  ?? null,
    score_esc85:    jogo.score_esc85  ?? null,
    score_cart25:   jogo.score_cards25 ?? null,
    score_cart35:   jogo.score_cards35 ?? null,

    // Dados analíticos
    over15_g:       jogo.over15_g     ?? null,
    over25_g:       jogo.over25_g     ?? null,
    exg_home:       jogo.exg_h        ?? null,
    exg_away:       jogo.exg_a        ?? null,
    ppg_home:       jogo.ppg_h        ?? null,
    ppg_away:       jogo.ppg_a        ?? null,
    h2h_goals:      jogo.h2h_goals    ?? null,
    avg_corners:    jogo.avg_corners  ?? null,
    avg_cards:      jogo.avg_cards    ?? null,
    btts_cf:        jogo.btts_cf      ?? null,
    via:            jogo.via          ?? null,

    // Justificativas
    justif_15:      jogo.justif_15    ?? null,
    justif_esc:     jogo.justif_esc   ?? null,
    justif_cards:   jogo.justif_cards ?? null,

    // Resultado detalhado
    goals_home:     res.gols_home     ?? null,
    goals_away:     res.gols_away     ?? null,
    corners_total:  res.corners_total ?? null,
    cards_total:    res.cards_total   ?? null,
    placar:         res.placar        ?? null,

    source:         'v1_import',
    home_team_logo: null,
    away_team_logo: null,
    created_at:     new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────
// PROCESSAR UM ARQUIVO JSON
// ─────────────────────────────────────────────────────────────────

async function processFile(filePath, stats) {
  const filename = path.basename(filePath);
  const dateStr  = filename.replace('.json', ''); // "24-05-2026"

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    LOG.error(`Erro ao ler ${filename}:`, err.message);
    stats.errors++;
    return;
  }

  const palpites = data.palpites_snapshot || [];
  const jogos    = data.jogos             || [];

  if (!palpites.length) {
    LOG.dim(`  ${filename}: sem palpites`);
    return;
  }

  // Mapa fixture_id → jogo completo
  const jogoMap = {};
  for (const j of jogos) {
    jogoMap[j.fixture_id] = j;
  }

  LOG.info(`  ${filename}: ${palpites.length} palpites`);

  for (const palpite of palpites) {
    const jogo = jogoMap[palpite.fixture_id];
    if (!jogo) {
      LOG.warn(`    Jogo não encontrado para fixture ${palpite.fixture_id}`);
      stats.warnings++;
      continue;
    }

    const matchDateISO = v1DateToISO(dateStr, jogo.hora);

    // ── Verificar se já existe (se não for --force)
    if (!FORCE && !DRY_RUN && supabase) {
      const { data: existing } = await supabase
        .from('prediction_snapshots')
        .select('id')
        .eq('fixture_id', palpite.fixture_id)
        .eq('market', palpite.mkt)
        .eq('source', 'v1_import')
        .maybeSingle();

      if (existing) {
        LOG.skip(`    ${palpite.jogo} | ${palpite.mkt} — já existe`);
        stats.skipped++;
        continue;
      }
    }

    if (DRY_RUN) {
      LOG.dim(`    [DRY] ${palpite.jogo} | ${palpite.mkt} | grade=${palpite.grade} | score=${palpite.score}`);
      stats.imported++;
      continue;
    }

    // ── Upsert fixture
    const fixtureData = buildFixture(jogo, matchDateISO);
    const { error: fxErr } = await supabase
      .from('fixtures')
      .upsert(fixtureData, { onConflict: 'fixture_id' });

    if (fxErr) {
      LOG.warn(`    Fixture upsert warning: ${fxErr.message}`);
    }

    // ── Upsert prediction_snapshot
    const snapshotData = buildSnapshot(palpite, jogo, matchDateISO);
    const { error: snapErr } = await supabase
      .from('prediction_snapshots')
      .upsert(snapshotData, { onConflict: 'fixture_id,market' });

    if (snapErr) {
      LOG.error(`    Snapshot error: ${snapErr.message}`);
      stats.errors++;
      continue;
    }

    const resultStr = snapshotData.result_status
      ? (snapshotData.result_status === 'green' ? '\x1b[32m✓ GREEN\x1b[0m' : '\x1b[31m✗ RED\x1b[0m')
      : '— pendente';

    LOG.ok(`    ${palpite.jogo} | ${palpite.mkt} | ${palpite.grade} | ${resultStr}`);
    stats.imported++;
  }
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n' + '═'.repeat(64));
  console.log(' WinMetrics — Importar V1 → Supabase');
  console.log('═'.repeat(64) + '\n');

  if (!supabase && !DRY_RUN) {
    LOG.error('SUPABASE_URL ou SUPABASE_SERVICE_KEY não configurados.');
    LOG.error('Use --dry-run para testar sem banco.');
    process.exit(1);
  }

  // Descobrir arquivos JSON
  let files;
  if (dateArg) {
    const filePath = path.join(dirArg, `${dateArg}.json`);
    if (!fs.existsSync(filePath)) {
      LOG.error(`Arquivo não encontrado: ${filePath}`);
      process.exit(1);
    }
    files = [filePath];
  } else {
    files = fs.readdirSync(dirArg)
      .filter(f => /^\d{2}-\d{2}-\d{4}\.json$/.test(f))
      .sort()
      .map(f => path.join(dirArg, f));
  }

  if (!files.length) {
    LOG.error(`Nenhum arquivo JSON encontrado em: ${dirArg}`);
    process.exit(1);
  }

  LOG.info(`Arquivos: ${files.length} | dry-run: ${DRY_RUN} | force: ${FORCE}`);
  LOG.info(`Diretório: ${dirArg}`);
  console.log();

  const stats = { imported: 0, skipped: 0, errors: 0, warnings: 0 };

  for (const filePath of files) {
    await processFile(filePath, stats);
  }

  // Relatório final
  console.log('\n' + '─'.repeat(64));
  console.log(' Resultado da Importação');
  console.log('─'.repeat(64));
  console.log(` \x1b[32m✓ Importados:\x1b[0m  ${stats.imported}`);
  console.log(` ○ Pulados:     ${stats.skipped}`);
  console.log(` ✗ Erros:       ${stats.errors}`);
  console.log(` ⚠ Avisos:      ${stats.warnings}`);
  console.log('═'.repeat(64) + '\n');

  if (DRY_RUN) {
    console.log(' ℹ️  Modo dry-run — nenhum dado foi salvo.\n');
  }
}

run().catch(err => {
  LOG.error('Erro fatal:', err.message);
  process.exit(1);
});
