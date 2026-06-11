#!/usr/bin/env node
/**
 * WinMetrics V3 — Backfill Histórico
 * ─────────────────────────────────────────────────────────────────
 * Roda o generate_predictions.js para cada data em sequência,
 * do passado até N dias no futuro.
 *
 * Comportamento:
 *   - Pula datas que já têm dados no Supabase (--only-new por padrão)
 *   - Para limpo quando a quota da API esgota (exit code 2 do pipeline)
 *   - Retoma de onde parou na próxima execução (datas já processadas são puladas)
 *
 * Uso:
 *   node scripts/backfill.js
 *   node scripts/backfill.js --from=2026-05-24 --future=10
 *   node scripts/backfill.js --from=2026-05-24 --future=10 --dry-run
 *   node scripts/backfill.js --delay=3000
 *
 * Variáveis de ambiente obrigatórias:
 *   SUPABASE_URL          — URL do projeto Supabase
 *   SUPABASE_SERVICE_KEY  — service_role key (bypass RLS)
 *   API_FOOTBALL_KEY      — chave da API-Football v3
 *
 * Flags:
 *   --from=YYYY-MM-DD   Data início (default: 2026-05-24)
 *   --future=N          Dias no futuro a partir de hoje (default: 10)
 *   --dry-run           Não grava no Supabase, só simula
 *   --delay=N           ms entre datas (default: 2000)
 *   --force             Reprocessa mesmo datas já existentes
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

// ─────────────────────────────────────────────────────────────────
// ARGS
// ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const fromArg   = args.find(a => a.startsWith('--from='))?.split('=')[1];
const futureArg = args.find(a => a.startsWith('--future='))?.split('=')[1];
const delayArg  = args.find(a => a.startsWith('--delay='))?.split('=')[1];
const DRY_RUN   = args.includes('--dry-run');
const FORCE     = args.includes('--force');

const FROM_DATE  = fromArg   || '2026-05-24';
const FUTURE_DAYS = parseInt(futureArg || '10', 10);
const DELAY_MS   = parseInt(delayArg  || '2000', 10);

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayBRT() {
  // UTC-3
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getDatesRange(from, to) {
  const dates = [];
  let current = from;
  while (current <= to) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hr(char = '─', len = 64) { return char.repeat(len); }

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────

async function main() {
  const today  = todayBRT();
  const toDate = addDays(today, FUTURE_DAYS);
  const dates  = getDatesRange(FROM_DATE, toDate);

  const pipelinePath = path.resolve(__dirname, '../frontend/jobs/generate_predictions.js');

  console.log('\n' + hr('═'));
  console.log(' WinMetrics V3 — Backfill + Futuro');
  console.log(hr('═'));
  console.log(` Início:   ${FROM_DATE}`);
  console.log(` Hoje:     ${today}`);
  console.log(` Futuro:   até ${toDate} (+${FUTURE_DAYS} dias)`);
  console.log(` Total:    ${dates.length} datas`);
  console.log(` Delay:    ${DELAY_MS}ms entre datas`);
  console.log(` Dry-run:  ${DRY_RUN}`);
  console.log(` Force:    ${FORCE}`);
  console.log(hr('─') + '\n');

  const results = { ok: [], skipped: [], error: [], quota_stopped: null };

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const isFuture = date > today;
    const progress = `[${String(i + 1).padStart(2, '0')}/${dates.length}]`;
    const label    = isFuture ? `${date} (+futuro)` : date;

    console.log(`${progress} ${label}...`);

    // Monta flags
    const flags = [
      `--date=${date}`,
      '--days=1',
      FORCE ? '--force' : '--only-new',
      DRY_RUN ? '--dry-run' : '',
    ].filter(Boolean);

    const result = spawnSync(
      process.execPath,   // mesmo binário node que está rodando
      [pipelinePath, ...flags],
      {
        env:      { ...process.env },
        timeout:  120_000,
        encoding: 'utf8',
      }
    );

    // ── Exit code 2 = quota esgotada — para tudo ──────────────
    if (result.status === 2) {
      console.log(`         ⛔ QUOTA ESGOTADA em ${date} — parando.`);
      console.log(`            Na próxima execução, o backfill retoma de onde parou.`);
      results.quota_stopped = date;
      break;
    }

    // ── Exit code != 0 = erro real ─────────────────────────────
    if (result.status !== 0) {
      const errLine = (result.stderr || result.stdout || '')
        .split('\n').find(l => l.includes('[ERR') || l.includes('Error')) || 'erro desconhecido';
      console.log(`         ✗ ERRO: ${errLine.trim()}`);
      results.error.push({ date, error: errLine.trim() });
      // Continua para próxima data (erro pontual, não fatal)
      await sleep(DELAY_MS);
      continue;
    }

    // ── Sucesso ────────────────────────────────────────────────
    // Extrai resumo do stdout
    const lines = (result.stdout || '').trim().split('\n');
    const snapLine  = lines.find(l => l.includes('snapshot') || l.includes('Snapshot'));
    const gradeLine = lines.find(l => l.includes('Grade') || l.includes('grade'));
    const warnLine  = lines.find(l => l.includes('Nenhuma fixture') || l.includes('Sem dados'));

    if (warnLine) {
      console.log(`         ○ sem jogos`);
      results.skipped.push(date);
    } else {
      const info = [snapLine, gradeLine].filter(Boolean).map(l => l.trim()).join('  |  ');
      console.log(`         ✓ OK${info ? '  — ' + info : ''}`);
      results.ok.push(date);
    }

    // Delay entre datas
    if (i < dates.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  // ── Relatório final ────────────────────────────────────────────
  console.log('\n' + hr('═'));
  console.log(' Resultado do backfill');
  console.log(hr('─'));
  console.log(` ✓ Processadas:    ${results.ok.length} datas`);
  console.log(` ○ Sem jogos:      ${results.skipped.length} datas`);
  console.log(` ✗ Erros:          ${results.error.length} datas`);

  if (results.quota_stopped) {
    console.log(`\n ⛔ Parou na data: ${results.quota_stopped} (quota esgotada)`);
    console.log(`    Quando os créditos voltarem, rode novamente:`);
    console.log(`    → O backfill detecta automaticamente o que já está no Supabase`);
    console.log(`      e pula as datas já processadas (--only-new).`);
  }

  if (results.error.length > 0) {
    console.log('\n Datas com erro:');
    results.error.forEach(({ date, error }) => console.log(`   ${date}: ${error}`));
  }

  if (!results.quota_stopped && results.ok.length > 0 && !DRY_RUN) {
    console.log('\n ✅ Backfill completo!');
    console.log('    Abra previsoes.html e filtre por qualquer data para validar.');
  }

  console.log(hr('═') + '\n');

  // Exit code: 2 se parou por quota, 1 se houve erros, 0 se OK
  if (results.quota_stopped) process.exit(2);
  if (results.error.length > 0) process.exit(1);
  process.exit(0);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
