#!/usr/bin/env node
/**
 * WinMetrics — Comparar snapshots V1 vs V3 (Supabase)
 * ─────────────────────────────────────────────────────────────────
 * Compara os palpites do V1 (arquivo JSON local) com os palpites
 * do V3 salvos no Supabase, usando fixture_id + market como chave.
 *
 * Uso:
 *   node scripts/compare_v1_v3_snapshots.js 2026-06-10
 *   node scripts/compare_v1_v3_snapshots.js 2026-06-10 --dir=./v1_data
 *   node scripts/compare_v1_v3_snapshots.js 2026-06-10 --score-tol=0.1
 *   node scripts/compare_v1_v3_snapshots.js 2026-06-10 --verbose
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL         — URL do projeto Supabase
 *   SUPABASE_SERVICE_KEY — service_role key (bypass RLS)
 *
 * Divergências verificadas:
 *   score   · grade   · odd   · liga   · home_team   · away_team
 *
 * Saída final:
 *   "COMPATÍVEL COM V1"          — se zero divergências
 *   "N DIVERGÊNCIA(S) DETECTADA" — caso contrário
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

const args       = process.argv.slice(2);
const dateArg    = args.find(a => !a.startsWith('--'))   || null;
const dirArg     = args.find(a => a.startsWith('--dir='))?.split('=')[1]       || './v1_data';
const scoreTolArg= args.find(a => a.startsWith('--score-tol='))?.split('=')[1] ?? '0.05';
const VERBOSE    = args.includes('--verbose');

// Tolerância numérica para score (evita falsos positivos por ponto flutuante)
const SCORE_TOL  = parseFloat(scoreTolArg) || 0.05;

// ─────────────────────────────────────────────────────────────────
// CORES
// ─────────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  purple: '\x1b[35m',
  gray:   '\x1b[90m',
};

const col  = (c, s)  => `${c}${s}${C.reset}`;
const bold = s       => col(C.bold, s);
const dim  = s       => col(C.dim + C.gray, s);
const ok   = s       => col(C.green,  s);
const warn = s       => col(C.yellow, s);
const err  = s       => col(C.red,    s);
const info = s       => col(C.cyan,   s);

// ─────────────────────────────────────────────────────────────────
// SUPABASE
// ─────────────────────────────────────────────────────────────────

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

// ─────────────────────────────────────────────────────────────────
// HELPERS DE DATA
// ─────────────────────────────────────────────────────────────────

/**
 * Converte "YYYY-MM-DD" para o nome do arquivo V1 "DD-MM-YYYY".
 * Ex: "2026-06-10" → "10-06-2026"
 */
function isoToDdMmYyyy(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

/**
 * Converte "YYYY-MM-DD" para range UTC cobrindo o dia inteiro em BRT (UTC-3).
 * 00:00 BRT = 03:00 UTC · 23:59:59 BRT = 02:59:59 UTC do dia seguinte.
 */
function dateToUTCRange(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 3, 0, 0)).toISOString();
  const end   = new Date(Date.UTC(y, m - 1, d + 1, 2, 59, 59)).toISOString();
  return { start, end };
}

// ─────────────────────────────────────────────────────────────────
// CARREGAR V1 (JSON local)
// ─────────────────────────────────────────────────────────────────

function loadV1(dateISO) {
  const filename = isoToDdMmYyyy(dateISO) + '.json';
  const filePath = path.resolve(dirArg, filename);

  if (!fs.existsSync(filePath)) {
    console.error(err(`\n  Arquivo V1 não encontrado: ${filePath}`));
    console.error(dim(`  Use --dir=<caminho> para especificar o diretório dos JSONs do V1.\n`));
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(err(`\n  Erro ao parsear ${filename}: ${e.message}\n`));
    process.exit(1);
  }

  const palpites = data.palpites_snapshot || [];
  // Normaliza para mapa fixture_id+market → palpite
  const map = new Map();
  for (const p of palpites) {
    const key = `${p.fixture_id}::${p.mkt}`;
    map.set(key, {
      fixture_id: p.fixture_id,
      market:     p.mkt,
      score:      p.score     ?? null,
      grade:      p.grade     ?? null,
      odd:        p.oddVal    ?? null,
      league:     p.liga      ?? null,
      home_team:  p.home      ?? null,
      away_team:  p.away      ?? null,
      jogo:       p.jogo      ?? null,
    });
  }

  return map;
}

// ─────────────────────────────────────────────────────────────────
// CARREGAR V3 (Supabase)
// ─────────────────────────────────────────────────────────────────

async function loadV3(dateISO) {
  if (!supabase) {
    console.error(err('\n  SUPABASE_URL ou SUPABASE_SERVICE_KEY não configurados.'));
    console.error(dim('  Configure as variáveis de ambiente e tente novamente.\n'));
    process.exit(1);
  }

  const { start, end } = dateToUTCRange(dateISO);

  const { data, error } = await supabase
    .from('prediction_snapshots')
    .select(
      'fixture_id, market, score, grade, odd, odd_value, ' +
      'league_name, league, home_team, home, away_team, away, match_name'
    )
    .gte('match_date', start)
    .lte('match_date', end)
    .order('fixture_id');

  if (error) {
    console.error(err(`\n  Erro ao consultar Supabase: ${error.message}\n`));
    process.exit(1);
  }

  const map = new Map();
  for (const row of (data || [])) {
    const key = `${row.fixture_id}::${row.market}`;
    map.set(key, {
      fixture_id: row.fixture_id,
      market:     row.market,
      score:      row.score                              ?? null,
      grade:      row.grade                             ?? null,
      // Aceita cascata de campos de odd (canônico → legado)
      odd:        row.odd     ?? row.odd_value           ?? null,
      // Liga: canônico → legado
      league:     row.league_name ?? row.league          ?? null,
      // Times: canônico → legado
      home_team:  row.home_team   ?? row.home            ?? null,
      away_team:  row.away_team   ?? row.away            ?? null,
      match_name: row.match_name                         ?? null,
    });
  }

  return map;
}

// ─────────────────────────────────────────────────────────────────
// COMPARAR CAMPO A CAMPO
// ─────────────────────────────────────────────────────────────────

/**
 * Compara dois valores de odd com tolerância de 0.01.
 * null == null é considerado igual (ambos sem odd).
 */
function oddsDifere(v1, v3) {
  if (v1 === null && v3 === null) return false;
  if (v1 === null || v3 === null) return true;
  return Math.abs(Number(v1) - Number(v3)) > 0.01;
}

/**
 * Compara dois valores de score com tolerância configurável.
 */
function scoreDifere(v1, v3) {
  if (v1 === null && v3 === null) return false;
  if (v1 === null || v3 === null) return true;
  return Math.abs(Number(v1) - Number(v3)) > SCORE_TOL;
}

/**
 * Compara strings ignorando caixa e espaços extras.
 * null == null é considerado igual.
 */
function strDifere(v1, v3) {
  if (v1 === null && v3 === null) return false;
  if (v1 === null || v3 === null) return true;
  return v1.trim().toLowerCase() !== v3.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────
// FORMATAR LINHA DE DIVERGÊNCIA
// ─────────────────────────────────────────────────────────────────

function fmtDiv(campo, v1val, v3val) {
  const v1str = v1val === null ? dim('null') : warn(String(v1val));
  const v3str = v3val === null ? dim('null') : err(String(v3val));
  return `      ${col(C.purple, campo.padEnd(12))} V1=${v1str}  V3=${v3str}`;
}

// ─────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────

async function run() {
  // ── Validação de args ──────────────────────────────────────────
  if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error(err('\n  Uso: node scripts/compare_v1_v3_snapshots.js YYYY-MM-DD\n'));
    console.error(dim('  Exemplos:'));
    console.error(dim('    node scripts/compare_v1_v3_snapshots.js 2026-06-10'));
    console.error(dim('    node scripts/compare_v1_v3_snapshots.js 2026-06-10 --dir=./v1_data --verbose\n'));
    process.exit(1);
  }

  const bar = '═'.repeat(64);
  console.log('\n' + bar);
  console.log(bold(` WinMetrics — Comparação V1 × V3  |  ${dateArg}`));
  console.log(bar + '\n');

  // ── Carregar dados ─────────────────────────────────────────────
  console.log(info(' Carregando V1...'));
  const v1Map = loadV1(dateArg);
  console.log(ok(  ` V1 carregado: ${v1Map.size} palpite(s)\n`));

  console.log(info(' Consultando V3 (Supabase)...'));
  const v3Map = await loadV3(dateArg);
  console.log(ok(  ` V3 carregado: ${v3Map.size} palpite(s)\n`));

  // ── Totais ─────────────────────────────────────────────────────
  const totalV1 = v1Map.size;
  const totalV3 = v3Map.size;

  // ── Faltando no V3 (chaves do V1 não presentes no V3) ──────────
  const faltandoNoV3 = [];
  for (const [key, p1] of v1Map) {
    if (!v3Map.has(key)) {
      faltandoNoV3.push(p1);
    }
  }

  // ── Sobrando no V3 (chaves do V3 não presentes no V1) ──────────
  const sobrandoNoV3 = [];
  for (const [key, p3] of v3Map) {
    if (!v1Map.has(key)) {
      sobrandoNoV3.push(p3);
    }
  }

  // ── Divergências em palpites que existem nos dois ──────────────
  const divScore  = [];
  const divGrade  = [];
  const divOdd    = [];
  const divLiga   = [];
  const divHome   = [];
  const divAway   = [];

  for (const [key, p1] of v1Map) {
    const p3 = v3Map.get(key);
    if (!p3) continue;  // já contado em faltandoNoV3

    if (scoreDifere(p1.score, p3.score)) {
      divScore.push({ key, v1: p1, v3: p3,
        campo: 'score', valV1: p1.score, valV3: p3.score });
    }
    if (p1.grade !== p3.grade) {
      divGrade.push({ key, v1: p1, v3: p3,
        campo: 'grade', valV1: p1.grade, valV3: p3.grade });
    }
    if (oddsDifere(p1.odd, p3.odd)) {
      divOdd.push({ key, v1: p1, v3: p3,
        campo: 'odd', valV1: p1.odd, valV3: p3.odd });
    }
    if (strDifere(p1.league, p3.league)) {
      divLiga.push({ key, v1: p1, v3: p3,
        campo: 'liga', valV1: p1.league, valV3: p3.league });
    }
    if (strDifere(p1.home_team, p3.home_team)) {
      divHome.push({ key, v1: p1, v3: p3,
        campo: 'home_team', valV1: p1.home_team, valV3: p3.home_team });
    }
    if (strDifere(p1.away_team, p3.away_team)) {
      divAway.push({ key, v1: p1, v3: p3,
        campo: 'away_team', valV1: p1.away_team, valV3: p3.away_team });
    }
  }

  // ── Contagem total de divergências ────────────────────────────
  const totalDivCampos =
    divScore.length + divGrade.length + divOdd.length +
    divLiga.length  + divHome.length  + divAway.length;

  const totalDivergencias = faltandoNoV3.length + sobrandoNoV3.length + totalDivCampos;

  // ─────────────────────────────────────────────────────────────
  // RELATÓRIO
  // ─────────────────────────────────────────────────────────────

  const sep = '─'.repeat(64);

  // ── Totais ─────────────────────────────────────────────────────
  console.log(bold(' TOTAIS'));
  console.log(sep);
  console.log(`  Total V1           ${bold(String(totalV1).padStart(4))}`);
  console.log(`  Total V3           ${bold(String(totalV3).padStart(4))}`);
  const deltaStr = totalV3 - totalV1 >= 0
    ? ok(`+${totalV3 - totalV1}`)
    : err(String(totalV3 - totalV1));
  console.log(`  Diferença          ${deltaStr}`);
  console.log();

  // ── Faltando no V3 ─────────────────────────────────────────────
  const labelFalt = faltandoNoV3.length === 0
    ? ok(`${faltandoNoV3.length}`)
    : err(`${faltandoNoV3.length}`);
  console.log(bold(' FALTANDO NO V3') + `   ${labelFalt}`);
  console.log(sep);
  if (faltandoNoV3.length === 0) {
    console.log(ok('  Nenhum palpite faltando.'));
  } else {
    for (const p of faltandoNoV3) {
      console.log(`  ${err('✗')} [${p.fixture_id}] ${warn(p.market.padEnd(14))} ${p.jogo || `${p.home_team} x ${p.away_team}`}`);
      console.log(dim(`      grade=${p.grade}  score=${p.score}  liga=${p.league}`));
    }
  }
  console.log();

  // ── Sobrando no V3 ─────────────────────────────────────────────
  const labelSob = sobrandoNoV3.length === 0
    ? ok(`${sobrandoNoV3.length}`)
    : warn(`${sobrandoNoV3.length}`);
  console.log(bold(' SOBRANDO NO V3') + `   ${labelSob}`);
  console.log(sep);
  if (sobrandoNoV3.length === 0) {
    console.log(ok('  Nenhum palpite extra.'));
  } else {
    for (const p of sobrandoNoV3) {
      const nome = p.match_name || `${p.home_team || '?'} x ${p.away_team || '?'}`;
      console.log(`  ${warn('+')} [${p.fixture_id}] ${warn(p.market.padEnd(14))} ${nome}`);
      console.log(dim(`      grade=${p.grade}  score=${p.score}  liga=${p.league}`));
    }
  }
  console.log();

  // ── Divergências por campo ──────────────────────────────────────
  const campos = [
    { label: 'SCORE',     list: divScore,  tol: `(tolerância ±${SCORE_TOL})` },
    { label: 'GRADE',     list: divGrade,  tol: '' },
    { label: 'ODD',       list: divOdd,    tol: '(tolerância ±0.01)' },
    { label: 'LIGA',      list: divLiga,   tol: '' },
    { label: 'HOME TEAM', list: divHome,   tol: '' },
    { label: 'AWAY TEAM', list: divAway,   tol: '' },
  ];

  for (const { label, list, tol } of campos) {
    const count = list.length === 0
      ? ok('0')
      : err(String(list.length));
    const tolStr = tol ? dim(` ${tol}`) : '';
    console.log(bold(` DIVERGÊNCIAS — ${label}`) + `   ${count}${tolStr}`);
    console.log(sep);

    if (list.length === 0) {
      console.log(ok('  Sem divergências.'));
    } else {
      for (const d of list) {
        const nome = d.v1.jogo || `${d.v1.home_team} x ${d.v1.away_team}`;
        console.log(`  ${err('≠')} [${d.v1.fixture_id}] ${warn(d.v1.market.padEnd(14))} ${nome}`);
        console.log(fmtDiv(d.campo, d.valV1, d.valV3));
        if (VERBOSE) {
          console.log(dim(`      V1 grade=${d.v1.grade}  score=${d.v1.score}  liga=${d.v1.league}`));
          console.log(dim(`      V3 grade=${d.v3.grade}  score=${d.v3.score}  liga=${d.v3.league}`));
        }
      }
    }
    console.log();
  }

  // ── Veredicto final ────────────────────────────────────────────
  console.log(bar);
  if (totalDivergencias === 0) {
    console.log(
      '\n' +
      bold(ok('  ✓ COMPATÍVEL COM V1')) +
      ok(`  —  ${totalV1} palpite(s), zero divergências.\n`)
    );
  } else {
    // Detalhe por categoria
    const partes = [];
    if (faltandoNoV3.length)  partes.push(err(`${faltandoNoV3.length} faltando`));
    if (sobrandoNoV3.length)  partes.push(warn(`${sobrandoNoV3.length} sobrando`));
    if (divScore.length)      partes.push(err(`${divScore.length} score`));
    if (divGrade.length)      partes.push(err(`${divGrade.length} grade`));
    if (divOdd.length)        partes.push(err(`${divOdd.length} odd`));
    if (divLiga.length)       partes.push(err(`${divLiga.length} liga`));
    if (divHome.length)       partes.push(err(`${divHome.length} home`));
    if (divAway.length)       partes.push(err(`${divAway.length} away`));

    console.log(
      '\n' +
      err(bold(`  ✗ ${totalDivergencias} DIVERGÊNCIA(S) DETECTADA(S)`)) +
      `  — ${partes.join(', ')}\n`
    );
    process.exitCode = 1;  // sinaliza erro para CI sem interromper o log
  }
  console.log(bar + '\n');
}

run().catch(e => {
  console.error(err(`\n  Erro fatal: ${e.message}\n`));
  process.exit(1);
});
