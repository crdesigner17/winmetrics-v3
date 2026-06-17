#!/usr/bin/env node
'use strict';

/**
 * reprocess_historico.js
 *
 * Reprocessa snapshots de um período passado usando o engine ATUAL,
 * sobrescrevendo market/score/grade mesmo em jogos já confirmados.
 *
 * Preserva: result_status (green/red), goals_home, goals_away, placar
 * Sobrescreve: market, score, grade, confidence
 *
 * USO:
 *   node scripts/reprocess_historico.js --from=2026-06-10 --to=2026-06-22
 *   node scripts/reprocess_historico.js --from=2026-06-10 --to=2026-06-22 --dry-run
 *   node scripts/reprocess_historico.js --from=2026-06-10 --to=2026-06-22 --limit=10
 *
 * ATENÇÃO: Este script altera snapshots históricos. Use --dry-run primeiro.
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (k) => { const a = args.find(a => a.startsWith(k+'=')); return a ? a.split('=')[1] : null; };

const FROM     = getArg('--from');
const TO       = getArg('--to');
const DRY_RUN  = args.includes('--dry-run');
const LIMIT    = parseInt(getArg('--limit') || '999');

if (!FROM || !TO) {
  console.error('Uso: node reprocess_historico.js --from=YYYY-MM-DD --to=YYYY-MM-DD [--dry-run] [--limit=N]');
  process.exit(1);
}

// ── Supabase ──────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Engine ────────────────────────────────────────────────────────
const PredictionEngine = require('../frontend/lib/prediction_engine_v1.js');

// ── Helpers ───────────────────────────────────────────────────────
function pyRound(v, dec) {
  if (v === null || v === undefined) return null;
  return Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec);
}

function getGrade(score) {
  if (score >= 85) return 'A+';
  if (score >= 75) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

function getConfidence(grade) {
  const MAP = { 'A+': 'Elite', 'A': 'Alta', 'B': 'Moderado', 'C': 'Arriscado', 'D': 'Evitar' };
  return MAP[grade] || 'Arriscado';
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' REPROCESS HISTÓRICO — engine atualizado sobre dados passados');
  console.log(`  Período: ${FROM} → ${TO}`);
  console.log(`  Modo: ${DRY_RUN ? '🔍 DRY-RUN (nada será salvo)' : '✏️  ESCRITA REAL'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // 1. Buscar match_metrics do período (dados brutos do engine)
  const startISO = new Date(FROM + 'T00:00:00.000Z').toISOString();
  const endISO   = new Date(TO   + 'T23:59:59.999Z').toISOString();

  const { data: metrics, error: meErr } = await supabase
    .from('match_metrics')
    .select('*')
    .gte('match_date', startISO)
    .lte('match_date', endISO)
    .order('match_date', { ascending: true })
    .limit(LIMIT);

  if (meErr) { console.error('ERRO ao buscar match_metrics:', meErr.message); process.exit(1); }
  if (!metrics?.length) { console.log('Nenhum fixture encontrado no período.'); return; }

  console.log(`Fixtures encontrados: ${metrics.length}\n`);

  // 2. Buscar snapshots confirmados do período (para preservar result_status)
  const fixtureIds = metrics.map(m => m.fixture_id);
  const { data: snapshots } = await supabase
    .from('prediction_snapshots')
    .select('fixture_id, market, result_status, goals_home, goals_away')
    .in('fixture_id', fixtureIds);

  // Indexar por fixture_id → market → snapshot
  const snapMap = {};
  for (const s of (snapshots || [])) {
    if (!snapMap[s.fixture_id]) snapMap[s.fixture_id] = {};
    snapMap[s.fixture_id][s.market] = s;
  }

  // 3. Rodar engine em cada fixture
  let stats = { total: 0, recalculados: 0, sem_mudanca: 0, erros: 0, dry: 0 };
  const mudancas = [];

  for (const m of metrics) {
    stats.total++;
    const fid = m.fixture_id;

    // Montar raw compatível com o engine
    const raw = {
      fixture_id:    fid,
      home_team:     m.home_team,
      away_team:     m.away_team,
      league_name:   m.league_name,
      country:       m.country || '',
      match_date:    m.match_date,
      // Métricas brutas
      over15_g:      m.over15_g,      over25_g:      m.over25_g,
      exg_h:         m.exg_h,         exg_a:         m.exg_a,
      ppg_h:         m.ppg_h,         ppg_a:         m.ppg_a,
      h2h_goals:     m.h2h_goals,
      avg_sc_h:      m.avg_sc_h,      avg_sc_a:      m.avg_sc_a,
      btts_h:        m.btts_h,        btts_a:        m.btts_a,
      over05_ht:     m.over05_ht,     over15_ht:     m.over15_ht,
      avg_corners:   m.avg_corners,
      over65_c:      m.over65_c,      over75_c:      m.over75_c,    over85_c: m.over85_c,
      avg_cards:     m.avg_cards,
      over25_cards:  m.over25_cards,  over35_cards:  m.over35_cards,
      avg_shots:     m.avg_shots,     avg_sot:       m.avg_sot,
      under25_h:     m.under25_h,     under25_a:     m.under25_a,
      historic_data_level: m.historic_data_level ?? 1,
      // Odds — jogos passados não têm odds externas
      odd_o15: null, odd_o25: null, odd_btts: null, odd_05ht: null,
      odd_u35: null, odd_u45: null, odd_esc75: null, odd_esc85: null,
      odd_c25: null, odd_c35: null,
    };

    let result;
    try {
      result = PredictionEngine.processFixture(raw);
    } catch (e) {
      console.log(`  ❌ ERRO engine ${fid} (${m.home_team} x ${m.away_team}): ${e.message}`);
      stats.erros++;
      continue;
    }

    if (!result?.best_mkt) {
      console.log(`  ⚠️  ${m.home_team} x ${m.away_team} — sem best_mkt`);
      continue;
    }

    const newMkt    = result.best_mkt;
    const newScore  = pyRound(result.best_score, 1);
    const newGrade  = result.best_grade;

    // Snapshot existente para esse best_mkt
    const existingSnap = snapMap[fid]?.[newMkt] || null;
    const oldMkt = Object.keys(snapMap[fid] || {}).find(k => snapMap[fid][k]);
    const oldScore = existingSnap?.score ?? null;

    // Verificar se houve mudança
    const changed = !existingSnap || oldScore !== newScore;
    if (changed) {
      mudancas.push({
        fixture:    `${m.home_team} x ${m.away_team}`,
        liga:       m.league_name,
        data:       m.match_date?.slice(0, 10),
        old_mkt:    oldMkt || '—',
        new_mkt:    newMkt,
        old_score:  oldScore,
        new_score:  newScore,
        new_grade:  newGrade,
        result_status: existingSnap?.result_status || snapMap[fid]?.[oldMkt]?.result_status || null,
      });
    }

    if (DRY_RUN) {
      stats.dry++;
      continue;
    }

    // 4. Sobrescrever snapshot — preserva result_status, goals, placar
    const existingConfirmed = snapMap[fid]?.[newMkt];
    const row = {
      fixture_id:    fid,
      market:        newMkt,
      score:         newScore,
      grade:         newGrade,
      match_date:    m.match_date,
      home_team:     m.home_team,
      away_team:     m.away_team,
      league_name:   m.league_name,
      // Preservar resultado confirmado
      result_status: existingConfirmed?.result_status ?? null,
      goals_home:    existingConfirmed?.goals_home    ?? null,
      goals_away:    existingConfirmed?.goals_away    ?? null,
      source:        'reprocess_historico',
      updated_at:    new Date().toISOString(),
    };

    const { error: upErr } = await supabase
      .from('prediction_snapshots')
      .upsert(row, { onConflict: 'fixture_id,market' });

    if (upErr) {
      console.log(`  ❌ ERRO upsert ${fid}: ${upErr.message}`);
      stats.erros++;
    } else {
      stats.recalculados++;
    }
  }

  // 5. Relatório
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(` RESULTADO`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total processados: ${stats.total}`);
  console.log(`  Recalculados:      ${DRY_RUN ? stats.dry + ' (dry-run)' : stats.recalculados}`);
  console.log(`  Erros:             ${stats.erros}`);
  console.log(`  Com mudança:       ${mudancas.length}`);

  if (mudancas.length) {
    console.log('\n  MUDANÇAS DETECTADAS:');
    console.log(`  ${'Jogo'.padEnd(35)} ${'Liga'.padEnd(15)} ${'Data'.padEnd(10)} ${'Antigo'.padEnd(12)} ${'Novo'.padEnd(12)} ${'Score'.padEnd(8)} Res`);
    console.log('  ' + '─'.repeat(100));
    for (const c of mudancas) {
      const mktChange = c.old_mkt !== c.new_mkt ? `${c.old_mkt}→${c.new_mkt}` : c.new_mkt;
      const scoreStr  = c.old_score !== null ? `${c.old_score}→${c.new_score}` : `new:${c.new_score}`;
      const res       = c.result_status === 'green' ? '✅' : c.result_status === 'red' ? '❌' : '⏳';
      console.log(`  ${c.fixture.slice(0,35).padEnd(35)} ${c.liga.slice(0,15).padEnd(15)} ${String(c.data).padEnd(10)} ${mktChange.slice(0,12).padEnd(12)} ${c.new_grade.padEnd(8)} ${scoreStr.padEnd(8)} ${res}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n  ⚠️  DRY-RUN: nenhuma alteração foi salva.');
    console.log('  Rode sem --dry-run para aplicar as mudanças.');
  }

  console.log('\n');
}

main().catch(err => { console.error('ERRO fatal:', err); process.exit(1); });
