#!/usr/bin/env node
/**
 * WinMetrics V3 — Backfill Histórico
 * Roda o generate_predictions.js para cada data em sequência,
 * do passado até N dias no futuro.
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);

const fromArg   = args.find(a => a.startsWith('--from='))?.split('=')[1];
const futureArg = args.find(a => a.startsWith('--future='))?.split('=')[1];
const delayArg  = args.find(a => a.startsWith('--delay='))?.split('=')[1];
const DRY_RUN   = args.includes('--dry-run');
const FORCE     = args.includes('--force');

const FROM_DATE   = fromArg   || '2026-05-24';
const FUTURE_DAYS = parseInt(futureArg || '10', 10);
const DELAY_MS    = parseInt(delayArg  || '2000', 10);

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayBRT() {
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

function hr(char, len) { return (char || '─').repeat(len || 64); }

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

    const flags = [
      `--date=${date}`,
      '--days=1',
      FORCE ? '--force' : '--only-new',
      DRY_RUN ? '--dry-run' : '',
    ].filter(Boolean);

    const result = spawnSync(
      process.execPath,
      [pipelinePath, ...flags],
      {
        env:     { ...process.env },
        timeout: 120_000,
        encoding: 'utf8',
      }
    );

    // Exit code 2 = quota esgotada
    if (result.status === 2) {
      console.log(`         ⛔ QUOTA ESGOTADA em ${date} — parando.`);
      console.log(`            Na próxima execução retoma de onde parou.`);
      results.quota_stopped = date;
      break;
    }

    // Erro real — imprime output completo para diagnóstico
    if (result.status !== 0) {
      const fullOutput = ((result.stdout || '') + '\n' + (result.stderr || '')).trim();
      console.log(`         ✗ ERRO (exit ${result.status}) — output completo:`);
      console.log('         ' + fullOutput.split('\n').join('\n         '));
      const errLine = fullOutput.split('\n')
        .find(l => /\[ERR|Error:|error:/i.test(l))
        || fullOutput.split('\n').filter(Boolean).pop()
        || 'erro desconhecido';
      results.error.push({ date, error: errLine.trim() });
      await sleep(DELAY_MS);
      continue;
    }

    // Sucesso
    const lines    = (result.stdout || '').trim().split('\n');
    const snapLine = lines.find(l => /snapshot|Snapshot/i.test(l));
    const warnLine = lines.find(l => /Nenhuma fixture|Sem dados/i.test(l));

    if (warnLine) {
      console.log(`         ○ sem jogos`);
      results.skipped.push(date);
    } else {
      console.log(`         ✓ OK${snapLine ? '  — ' + snapLine.trim() : ''}`);
      results.ok.push(date);
    }

    if (i < dates.length - 1) await sleep(DELAY_MS);
  }

  // Relatório final
  console.log('\n' + hr('═'));
  console.log(' Resultado do backfill');
  console.log(hr('─'));
  console.log(` ✓ Processadas:  ${results.ok.length} datas`);
  console.log(` ○ Sem jogos:    ${results.skipped.length} datas`);
  console.log(` ✗ Erros:        ${results.error.length} datas`);

  if (results.quota_stopped) {
    console.log(`\n ⛔ Parou em: ${results.quota_stopped} (quota esgotada)`);
    console.log(`    Próxima execução retoma automaticamente.`);
  }

  if (results.error.length > 0) {
    console.log('\n Datas com erro:');
    results.error.forEach(({ date, error }) => console.log(`   ${date}: ${error}`));
  }

  if (!results.quota_stopped && results.ok.length > 0 && !DRY_RUN) {
    console.log('\n Backfill completo! Valide em previsoes.html.');
  }

  console.log(hr('═') + '\n');

  if (results.quota_stopped) process.exit(2);
  if (results.error.length > 0) process.exit(1);
  process.exit(0);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
