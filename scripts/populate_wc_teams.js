#!/usr/bin/env node
/**
 * WinMetrics V3 — Populate WC Teams
 * ─────────────────────────────────────────────────────────────────────────────
 * Busca os últimos N jogos de cada time faltante na wc_team_enrichment
 * via API-Football e insere os dados calculados na tabela.
 *
 * Afeta SOMENTE a tabela wc_team_enrichment.
 * Não altera nenhuma outra tabela, lógica, engine ou pipeline.
 *
 * Uso:
 *   node scripts/populate_wc_teams.js
 *   node scripts/populate_wc_teams.js --dry-run       (simula sem inserir)
 *   node scripts/populate_wc_teams.js --team="Uzbekistan"  (time específico)
 *   node scripts/populate_wc_teams.js --last=20       (últimos N jogos, padrão: 15)
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, API_FOOTBALL_KEY
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL         || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const API_KEY      = process.env.API_FOOTBALL_KEY     || '';
const API_BASE     = 'https://v3.football.api-sports.io';

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LAST    = parseInt(args.find(a => a.startsWith('--last='))?.split('=')[1] || '15', 10);
const TEAM_ARG = args.find(a => a.startsWith('--team='))?.split('=')[1] || null;

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

// ─────────────────────────────────────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────────────────────────────────────
const LOG = {
  _ts:   () => new Date().toISOString().replace('T', ' ').slice(0, 19),
  info:  (...a) => console.log (`\x1b[36m[INFO]\x1b[0m  ${LOG._ts()} `, ...a),
  ok:    (...a) => console.log (`\x1b[32m[ OK ]\x1b[0m  ${LOG._ts()} `, ...a),
  warn:  (...a) => console.warn(`\x1b[33m[WARN]\x1b[0m  ${LOG._ts()} `, ...a),
  error: (...a) => console.error(`\x1b[31m[ERR ]\x1b[0m  ${LOG._ts()} `, ...a),
  dim:   (...a) => console.log (`\x1b[90m[    ]\x1b[0m  ${LOG._ts()} `, ...a),
};

// ─────────────────────────────────────────────────────────────────────────────
// TIMES FALTANTES — Copa do Mundo 2026
// Mapeamento: nome exibido → team_id da API-Football
// ─────────────────────────────────────────────────────────────────────────────
const MISSING_TEAMS = [
  { name: 'Uzbekistan',          id: 1567 },
  { name: 'Panama',              id: 78   },
  { name: 'Honduras',            id: 83   },
  { name: 'Guatemala',           id: 81   },
  { name: 'Haiti',               id: 84   },
  { name: 'Costa Rica',          id: 79   },
  { name: 'Venezuela',           id: 97   },
  { name: 'Curaçao',             id: 1228 },
  { name: 'Austria',             id: 775  },
  { name: 'Jordan',              id: 785  },
  { name: 'Congo DR',            id: 1587 },
  { name: 'China',               id: 796  },
  { name: 'Indonesia',           id: 800  },
  { name: 'Trinidad and Tobago', id: 89   },
  { name: 'Palestine',           id: 812  },
];

// ─────────────────────────────────────────────────────────────────────────────
// API-FOOTBALL — chamada com retry
// ─────────────────────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

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
        LOG.warn(`Rate limit — aguardando ${wait}ms...`);
        await delay(wait);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const json = await res.json();
      const apiErrors = Array.isArray(json?.errors)
        ? json.errors
        : Object.values(json?.errors || {});
      const quotaError = apiErrors.some(e =>
        typeof e === 'string' && /daily.*(limit|quota|exceeded)|quota.*exceeded|upgrade.*plan/i.test(e)
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

  LOG.error(`apiFetch falhou: ${endpoint}`, lastErr?.message);
  return { response: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSCAR ÚLTIMOS N JOGOS DE UM TIME
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLastGames(teamId, last = 15) {
  const data = await apiFetch('/fixtures', {
    team:   teamId,
    last:   last,
    status: 'FT',
  });
  return data?.response || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// CALCULAR ESTATÍSTICAS A PARTIR DOS JOGOS
// ─────────────────────────────────────────────────────────────────────────────
function calcStats(games, teamId) {
  if (!games.length) return null;

  let wins = 0, draws = 0, losses = 0;
  let goalsFor = 0, goalsAgainst = 0;
  let over15 = 0, over25 = 0, btts = 0, over05ht = 0;
  let totalCards = 0, over25cards = 0, over35cards = 0;
  let gamesWithCards = 0;
  const n = games.length;

  for (const fx of games) {
    const isHome = fx.teams?.home?.id === teamId;
    const gf = isHome ? (fx.goals?.home ?? 0) : (fx.goals?.away ?? 0);
    const ga = isHome ? (fx.goals?.away ?? 0) : (fx.goals?.home ?? 0);
    const total = gf + ga;
    const htHome = fx.score?.halftime?.home ?? 0;
    const htAway = fx.score?.halftime?.away ?? 0;
    const htTotal = htHome + htAway;

    goalsFor     += gf;
    goalsAgainst += ga;

    if (gf > ga)      wins++;
    else if (gf === ga) draws++;
    else              losses++;

    if (total >= 2) over15++;
    if (total >= 3) over25++;
    if (gf >= 1 && ga >= 1) btts++;
    if (htTotal >= 1) over05ht++;
  }

  const ppg = (wins * 3 + draws) / n;
  const avg_gf = goalsFor / n;

  return {
    ppg:          Math.round(ppg * 100) / 100,
    avg_gf:       Math.round(avg_gf * 100) / 100,
    over15_g:     Math.round((over15 / n) * 1000) / 10,   // percentual 0-100
    over25_g:     Math.round((over25 / n) * 1000) / 10,
    btts_avg:     Math.round((btts   / n) * 1000) / 10,
    over05_ht:    Math.round((over05ht / n) * 1000) / 10,
    avg_cards:    null,   // não disponível sem /fixtures/statistics
    over25_cards: null,
    over35_cards: null,
    games_used:   n,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFICAR SE TIME JÁ EXISTE NA TABELA
// ─────────────────────────────────────────────────────────────────────────────
async function teamExists(name) {
  const { data } = await supabase
    .from('wc_team_enrichment')
    .select('api_team_name')
    .eq('api_team_name', name)
    .single();
  return !!data;
}

// ─────────────────────────────────────────────────────────────────────────────
// INSERIR TIME NA TABELA
// ─────────────────────────────────────────────────────────────────────────────
async function insertTeam(name, stats) {
  const row = {
    api_team_name: name,
    last_wc:       null,          // nunca foi ou não cadastrado historicamente
    ppg:           stats.ppg,
    avg_gf:        stats.avg_gf,
    over15_g:      stats.over15_g,   // 0-100 — usado direto como score pelo engine
    over25_g:      stats.over25_g,   // 0-100
    btts_avg:      stats.btts_avg,   // 0-100 — usado como btts_h/btts_a no engine
    over05_ht:     stats.over05_ht,  // 0-100 — usado direto como raw.over05_ht
    avg_cards:     stats.avg_cards,
    over25_cards:  stats.over25_cards,
    over35_cards:  stats.over35_cards,
    source:        'api_football_recent',
    games_used:    stats.games_used,
    updated_at:    new Date().toISOString(),
  };

  const { error } = await supabase
    .from('wc_team_enrichment')
    .upsert(row, { onConflict: 'api_team_name' });

  if (error) throw new Error(`Insert falhou para ${name}: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESSAR UM TIME
// ─────────────────────────────────────────────────────────────────────────────
async function processTeam(team) {
  LOG.info(`Processando: ${team.name} (id=${team.id})...`);

  // Busca jogos recentes
  const games = await fetchLastGames(team.id, LAST);

  if (!games.length) {
    LOG.warn(`  ${team.name}: nenhum jogo encontrado na API`);
    return { status: 'sem_jogos' };
  }

  LOG.dim(`  ${team.name}: ${games.length} jogos encontrados`);

  // Calcula estatísticas
  const stats = calcStats(games, team.id);
  if (!stats) {
    LOG.warn(`  ${team.name}: não foi possível calcular stats`);
    return { status: 'erro_calc' };
  }

  LOG.dim(`  ${team.name}: ppg=${stats.ppg} avg_gf=${stats.avg_gf} over15=${stats.over15_g}% btts=${stats.btts_avg}%`);

  if (DRY_RUN) {
    LOG.ok(`  [DRY-RUN] ${team.name} — seria inserido com ${stats.games_used} jogos`);
    return { status: 'dry_run', stats };
  }

  // Insere no Supabase
  await insertTeam(team.name, stats);
  LOG.ok(`  ✓ ${team.name} inserido — ${stats.games_used} jogos | ppg=${stats.ppg} | over15=${stats.over15_g}%`);
  return { status: 'ok', stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n' + '═'.repeat(64));
  console.log(' WinMetrics V3 — Populate WC Teams');
  console.log('═'.repeat(64));
  console.log(` Últimos jogos por time: ${LAST}`);
  console.log(` Dry-run: ${DRY_RUN}`);
  console.log(` Time específico: ${TEAM_ARG || 'todos'}`);
  console.log('─'.repeat(64) + '\n');

  if (!API_KEY)  { LOG.error('API_FOOTBALL_KEY não configurada.'); process.exit(1); }
  if (!supabase) { LOG.error('SUPABASE_URL ou SUPABASE_SERVICE_KEY não configurados.'); process.exit(1); }

  // Filtra por time específico se passado
  const teams = TEAM_ARG
    ? MISSING_TEAMS.filter(t => t.name.toLowerCase().includes(TEAM_ARG.toLowerCase()))
    : MISSING_TEAMS;

  if (!teams.length) {
    LOG.warn(`Nenhum time encontrado para: ${TEAM_ARG}`);
    process.exit(0);
  }

  const results = { ok: [], sem_jogos: [], erro: [], dry_run: [] };

  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    try {
      // Verifica se já existe (skip se já tiver)
      if (!DRY_RUN) {
        const exists = await teamExists(team.name);
        if (exists) {
          LOG.dim(`  ${team.name}: já existe na tabela — pulando (use --force para sobrescrever)`);
          results.ok.push(team.name + ' (já existia)');
          continue;
        }
      }

      const result = await processTeam(team);
      results[result.status]?.push(team.name);

    } catch (err) {
      LOG.error(`  ${team.name}: ${err.message}`);
      results.erro.push(team.name);
    }

    // Pausa entre times para não estourar rate limit
    if (i < teams.length - 1) await delay(600);
  }

  // Relatório final
  console.log('\n' + '─'.repeat(64));
  console.log(' Resultado');
  console.log('─'.repeat(64));
  console.log(` ✓ Inseridos:    ${results.ok.length}`);
  console.log(` ○ Sem jogos:    ${results.sem_jogos.length}`);
  console.log(` ✗ Erros:        ${results.erro.length}`);
  if (DRY_RUN) console.log(` ~ Dry-run:      ${results.dry_run.length}`);

  if (results.ok.length)       console.log('\n Times inseridos:\n  ' + results.ok.join('\n  '));
  if (results.sem_jogos.length) console.log('\n Sem jogos:\n  ' + results.sem_jogos.join('\n  '));
  if (results.erro.length)     console.log('\n Erros:\n  ' + results.erro.join('\n  '));

  console.log('\n' + '═'.repeat(64) + '\n');

  if (results.erro.length) process.exit(1);
  process.exit(0);
}

run().catch(err => {
  LOG.error('Erro fatal:', err.message);
  process.exit(1);
});
