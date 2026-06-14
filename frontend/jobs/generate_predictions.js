#!/usr/bin/env node
/**
 * WinMetrics Analytics â€” Generate Predictions
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Pipeline de geraÃ§Ã£o de previsÃµes reais.
 * ImplementaÃ§Ã£o fiel ao coletar.py do PackBall v3.0 (seÃ§Ãµes 2â€“7).
 *
 * Fluxo:
 *   1. Buscar fixtures do dia nas ligas suportadas
 *   2. Coletar dados da API-Football (5 chamadas paralelas por jogo)
 *   3. Mapear â†’ PackBallMapper.mapFixtureToPackBall()
 *   4. Calcular â†’ PredictionEngine.processFixture()
 *   5. Salvar â†’ fixtures, match_metrics, odds, predictions, prediction_snapshots
 *   6. Log detalhado por fixture
 *
 * Uso:
 *   node generate_predictions.js [--date YYYY-MM-DD] [--days N] [--dry-run] [--force] [--only-new] [--limit N]
 *
 * Exemplos econÃ´micos:
 *   node generate_predictions.js --days=3 --only-new --dry-run
 *   node generate_predictions.js --days=3 --only-new
 *   node generate_predictions.js --date=2026-06-10 --force
 *
 * VariÃ¡veis de ambiente:
 *   SUPABASE_URL          â€” URL do projeto Supabase
 *   SUPABASE_SERVICE_KEY  â€” service_role key (bypass RLS)
 *   API_FOOTBALL_KEY      â€” chave da API-Football v3
 *
 * DependÃªncias (package.json):
 *   @supabase/supabase-js ^2
 *   node-fetch ^3   (ou Node 18+ nativo)
 */

'use strict';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// IMPORTS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const path  = require('path');
const { createClient } = require('@supabase/supabase-js');

// Carrega os mÃ³dulos locais relativos a este arquivo
const PredictionEngine       = require('../lib/prediction_engine_v1.js');
const PackBallMapper         = require('../lib/packball_mapper.js');
const AltLineResolver        = require('../lib/alternative_line_resolver.js');
const { enrichFromWorldCup } = require('../lib/enrichFromWorldCup.js');
const { PackBallCSVEnricher, applyCsvToRaw } = require('../lib/packball_csv_enricher.js');


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CONFIGURAÃ‡ÃƒO
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SUPABASE_URL  = process.env.SUPABASE_URL         || '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';
const API_KEY       = process.env.API_FOOTBALL_KEY     || '';
const API_BASE      = 'https://v3.football.api-sports.io';

// Flags de execuÃ§Ã£o
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MODO COMPATÃVEL V1
// Ativado por padrÃ£o enquanto V1 for fonte de verdade.
// Desative com --no-v1-compat apenas quando o V3 estiver validado.
//
// Com V1_COMPAT_MODE = true:
//   â€¢ Linhas alternativas NÃƒO sÃ£o aplicadas (AltLineResolver ignorado)
//   â€¢ market salvo = nome canÃ´nico V1 (mkt original, sem final_market)
//   â€¢ passou_filtro afeta apenas a elegibilidade do Over 1.5
//   â€¢ Sem filtros extras por probability / confidence / edge / odd
//   â€¢ Sem filtros por status ou league
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const V1_COMPAT_MODE = !args.includes('--no-v1-compat');

// Ligas suportadas (Â§2.2)
const LIGAS = [
  // â”€â”€ Tier elite â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  // â”€â”€ Tier normal â€” Europa â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  // â”€â”€ Tier normal â€” AmÃ©ricas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  { id: 11,  season: 2026, name: 'Copa Sudamericana',         tier: 'normal' },
  { id: 9,   season: 2024, name: 'Copa America',              tier: 'normal' },
  { id: 71,  season: 2026, name: 'BrasileirÃ£o SÃ©rie A',       tier: 'normal' },
  { id: 72,  season: 2026, name: 'BrasileirÃ£o SÃ©rie B',       tier: 'normal' },
  { id: 75,  season: 2026, name: 'Copa do Brasil',            tier: 'normal' },
  { id: 73,  season: 2026, name: 'BrasileirÃ£o SÃ©rie C',       tier: 'normal' },
  { id: 475, season: 2026, name: 'Copa do Nordeste',          tier: 'normal' },
  { id: 474, season: 2026, name: 'Carioca Serie A',           tier: 'normal' },
  { id: 477, season: 2026, name: 'Paulista A1',               tier: 'normal' },
  { id: 478, season: 2026, name: 'Mineiro 1',                 tier: 'normal' },
  { id: 128, season: 2026, name: 'Liga Profesional de FÃºtbol', tier: 'normal' },
  { id: 136, season: 2025, name: 'Serie B',                   tier: 'normal' },
  // â”€â”€ Tier normal â€” Mundial / Amistosos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  { id: 10,  season: 2026, name: 'Friendlies',                tier: 'normal' },
  { id: 960, season: 2025, name: 'UEFA Nations League',       tier: 'normal' },
];

// Status de jogo aceitos Â§2.3
const VALID_STATUS = new Set(['NS','1H','HT','2H','ET','P','LIVE','FT','AET','PEN']);

// Termos que bloqueiam jogos sub-20/21 Â§2.3
const BLOCKED_TERMS = [
  'women','womens','feminino','feminina','femenino','femenina',
  'ladies','frauenliga','wpsl','nwsl',
  'u17','u18','u19','u20','u21','u23',
  'u-17','u-18','u-19','u-20','u-21','u-23',
  'under 17','under 18','under 19','under 20','under 21','under 23',
  'under-17','under-18','under-19','under-20','under-21','under-23',
  'youth','academy','reserve','reserves','reserva','amateur',
];

// Grades exibÃ­veis nas previsÃµes. A+/A seguem como destaque; Todos inclui B/C/D.
const GRADES_OFICIAIS = new Set(['A+', 'A', 'B', 'C', 'D']);

// Bilhete do dia: grade A+ E score >= 90 (Â§7.2)
const TICKET_DIA_MIN_SCORE = 90;


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CLIENTES
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    })
  : null;

// â”€â”€ PackBall CSV Enricher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CSV_DIR = process.env.PACKBALL_CSV_DIR || path.join(__dirname, '../data/packball');
const csvEnricher = new PackBallCSVEnricher(CSV_DIR);


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// LOGGER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const LOG = {
  _ts:   () => new Date().toISOString().replace('T', ' ').slice(0, 19),
  info:  (...a) => console.log (`\x1b[36m[INFO]\x1b[0m  ${LOG._ts()} `, ...a),
  ok:    (...a) => console.log (`\x1b[32m[ OK ]\x1b[0m  ${LOG._ts()} `, ...a),
  warn:  (...a) => console.warn(`\x1b[33m[WARN]\x1b[0m  ${LOG._ts()} `, ...a),
  error: (...a) => console.error(`\x1b[31m[ERR ]\x1b[0m  ${LOG._ts()} `, ...a),
  dim:   (...a) => console.log (`\x1b[90m[    ]\x1b[0m  ${LOG._ts()} `, ...a),
};


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// API-FOOTBALL â€” chamada base com retry
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * apiFetch(endpoint, params, retries)
 * Chamada Ã  API-Football com headers corretos e retry em rate limit.
 *
 * @param {string} endpoint  â€” ex: '/fixtures'
 * @param {object} params    â€” query params
 * @param {number} retries   â€” tentativas restantes
 * @returns {object}         â€” { response: [...], errors: [...] }
 */
// Erro especial para quota esgotada â€” capturado pelo run() para exit limpo
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
        LOG.warn(`Rate limit em ${endpoint} â€” aguardando ${wait}ms...`);
        await delay(wait);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const json = await res.json();

      // Quota diÃ¡ria esgotada â€” API retorna errors com "requests" ou status 499
      // Header x-ratelimit-requests-remaining = 0 tambÃ©m indica quota zero
      const remaining = res.headers?.get?.('x-ratelimit-requests-remaining');
      const apiErrors = Array.isArray(json?.errors)
        ? json.errors
        : Object.values(json?.errors || {});
      const quotaError = apiErrors.some(e =>
        typeof e === 'string' && /daily.*(limit|quota|exceeded)|quota.*exceeded|requests.*limit.*exceeded|upgrade.*plan/i.test(e)
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

  LOG.error(`apiFetch falhou apÃ³s ${retries} tentativas: ${endpoint}`, lastErr?.message);
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
 * EstratÃ©gia de economia da API:
 * - roda apenas quando --only-new estÃ¡ ativo, existe Supabase e nÃ£o estÃ¡ em --force
 * - se jÃ¡ existe snapshot e status nÃ£o mudou, pula
 * - se jÃ¡ houve predictions nas Ãºltimas 6h, pula
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
      reason: 'snapshot existente + status sem mudanÃ§a',
      savedCalls: 7,
    };
  }

  if (lastPred?.created_at && hoursAgo(lastPred.created_at) < 6) {
    return {
      skip: true,
      reason: `predictions atualizadas hÃ¡ ${hoursAgo(lastPred.created_at).toFixed(1)}h`,
      savedCalls: 7,
    };
  }

  return { skip: false, reason: null, savedCalls: 0 };
}



// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FASE 1 â€” BUSCAR FIXTURES DO DIA
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * blockedName(name)
 * Retorna true se o nome do jogo contiver termos de sub-20/21 (Â§2.3).
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
        LOG.dim(`  ${targetDate} Â· ${liga.name}: ${fixtures.length} fixture(s)`);

        for (const fx of fixtures) {
          const homeName = fx?.teams?.home?.name || '';
          const awayName = fx?.teams?.away?.name || '';
          const matchName = `${homeName} vs ${awayName}`;
          const status   = fx?.fixture?.status?.short || '';

          // Filtros Â§2.3
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
    LOG.warn(`Aplicando --limit=${LIMIT}: ${allFixtures.length} â†’ ${LIMIT} fixtures.`);
    allFixtures.length = LIMIT;
  }

  LOG.info(`Total: ${allFixtures.length} fixtures vÃ¡lidas encontradas.`);
  return allFixtures;
}


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FASE 2 â€” COLETAR DADOS COMPLETOS POR FIXTURE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * fetchAllData(fixtureEntry)
 * Executa atÃ© 7 chamadas paralelas para um Ãºnico fixture.
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

    // Pequena pausa para reduzir risco de rate limit ao enriquecer jogos histÃ³ricos.
    await delay(120);
  }

  return enriched;
}

async function fetchAllData({ fixture, liga }) {
  const fixtureId = fixture?.fixture?.id;
  const homeId    = fixture?.teams?.home?.id;
  const awayId    = fixture?.teams?.away?.id;
  const leagueId  = Number(liga?.id);
  const season    = Number(liga?.season);

  const fixtureWithLeague = {
    ...fixture,
    league: {
      ...(fixture?.league || {}),
      id: Number.isFinite(Number(fixture?.league?.id)) ? Number(fixture.league.id) : leagueId,
      name: fixture?.league?.name || liga?.name || '',
      season: Number.isFinite(Number(fixture?.league?.season)) ? Number(fixture.league.season) : season,
    },
  };

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

  // â”€â”€ Odds com fallback real â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Tentativa 1: bookmaker=6 (Bet365)
  let oddsRaw = await apiFetch('/odds', { fixture: fixtureId, bookmaker: 6 });
  const hasOdds1 = Array.isArray(oddsRaw?.response) && oddsRaw.response.length > 0;

  if (!hasOdds1) {
    LOG.dim(`  Odds bookmaker=6 vazias para fixture ${fixtureId} â€” tentando sem filtro de bookmaker...`);
    // Tentativa 2: qualquer bookmaker
    oddsRaw = await apiFetch('/odds', { fixture: fixtureId });
    const hasOdds2 = Array.isArray(oddsRaw?.response) && oddsRaw.response.length > 0;

    if (!hasOdds2) {
      LOG.dim(`  Odds indisponÃ­veis para este fixture â€” odd=null ev=null`);
      oddsRaw = { response: [] };  // garante estrutura vÃ¡lida, nÃ£o quebra pipeline
    } else {
      const bms = oddsRaw.response.flatMap(i => i?.bookmakers || []);
      const names = [...new Set(bms.map(b => `${b.name}(${b.id})`))].join(', ');
      LOG.dim(`  Odds via fallback â€” bookmakers: ${names}`);
    }
  }

  // â”€â”€ ODDS AUDIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (process.env.DEBUG_ODDS === '1') (function auditOdds() {
    const resp = oddsRaw?.response;
    console.log('\nâ•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
    console.log(`â•‘ ODDS AUDIT â€” fixture ${fixtureId}`);
    console.log('â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
    console.log(`â•‘ URL chamada: GET /odds?fixture=${fixtureId}&bookmaker=6`);
    console.log(`â•‘ oddsRaw keys: ${oddsRaw ? Object.keys(oddsRaw).join(', ') : 'null'}`);

    if (!resp) {
      console.log('â•‘ response: AUSENTE (oddsRaw.response = undefined)');
      console.log('â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');
      return;
    }

    if (!Array.isArray(resp) || resp.length === 0) {
      console.log(`â•‘ response.length: ${Array.isArray(resp) ? 0 : '(nÃ£o Ã© array) ' + typeof resp}`);
      console.log('â•‘ âš   RESPONSE VAZIO â€” API nÃ£o retornou odds para este fixture');
      console.log('â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');
      return;
    }

    console.log(`â•‘ response.length: ${resp.length}`);

    resp.forEach((item, idx) => {
      const bms = item?.bookmakers || [];
      console.log(`â•‘ response[${idx}].bookmakers.length: ${bms.length}`);

      if (bms.length === 0) {
        console.log(`â•‘   âš   Nenhum bookmaker em response[${idx}]`);
        return;
      }

      bms.forEach(bm => {
        const bets = bm?.bets || [];
        console.log(`â•‘   Bookmaker: ${bm.name} (id=${bm.id})  bets.length=${bets.length}`);

        bets.forEach(bet => {
          const vals = bet?.values || [];
          console.log(`â•‘     Market: "${bet.name}"  values.length=${vals.length}`);
          vals.forEach(v => {
            console.log(`â•‘       value="${v.value}"  odd=${v.odd}`);
          });
        });
      });
    });

    // â”€â”€ Mostrar qual bookmaker seria selecionado e por quÃª â”€â”€
    const allBms = resp.flatMap(i => i?.bookmakers || []);
    const bm6 = allBms.find(b => Number(b.id) === 6);
    const chosen = bm6 || (allBms.length > 0
      ? allBms.reduce((best, bm) => (bm.bets?.length||0) > (best.bets?.length||0) ? bm : best, allBms[0])
      : null);

    console.log('â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
    if (!chosen) {
      console.log('â•‘ âš   Nenhum bookmaker vÃ¡lido encontrado â†’ todas odds null');
    } else {
      console.log(`â•‘ Bookmaker SELECIONADO: ${chosen.name} (id=${chosen.id})${bm6 ? ' [id=6 encontrado]' : ' [FALLBACK â€” id=6 ausente]'}`);
      const bets = chosen.bets || [];

      // â”€â”€ Cross-reference: expected markets vs found â”€â”€
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

      console.log('â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
      console.log('â•‘ CROSS-REFERENCE: esperado â†’ encontrado');
      console.log('â•‘');
      for (const exp of EXPECTED) {
        // Find matching bet
        const matchedBet = bets.find(b =>
          exp.marketHints.some(h => b.name?.toLowerCase().includes(h.toLowerCase()))
        );
        if (!matchedBet) {
          console.log(`â•‘  âŒ Esperado market "${exp.label}"  â†’ nenhum market encontrado`);
          console.log(`â•‘     (buscou por: ${exp.marketHints.slice(0,2).join(', ')})`);
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
          console.log(`â•‘  âœ… Esperado: "${exp.label}" (value="${exp.value}")`);
          console.log(`â•‘     Recebido: market="${matchedBet.name}"  value="${matchedVal.value}"  odd=${matchedVal.odd}`);
        } else {
          const availableVals = (matchedBet.values||[]).map(v=>v.value).join(', ');
          console.log(`â•‘  âŒ Esperado: "${exp.label}" (value="${exp.value}")`);
          console.log(`â•‘     Market encontrado: "${matchedBet.name}"  MAS value="${exp.value}" NÃƒO encontrado`);
          console.log(`â•‘     Values disponÃ­veis: ${availableVals}`);
        }
      }
    }
    console.log('â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');
  })();

  // /fixtures?team&last=10 nÃ£o traz statistics embutido de forma confiÃ¡vel.
  // Para cantos, cartÃµes, chutes e SOT, enriquecemos cada fixture histÃ³rico
  // com /fixtures/statistics?fixture=ID antes de enviar ao PackBallMapper.
  const homeGamesBase = homeGamesRaw?.response || [];
  const awayGamesBase = awayGamesRaw?.response || [];

  const homeGames = await enrichGamesWithStatistics(homeGamesBase, 10);
  const awayGames = await enrichGamesWithStatistics(awayGamesBase, 10);

  return {
    fixture: fixtureWithLeague,

    // Manter o wrapper completo porque o PackBallMapper espera homeStats.response
    // e awayStats.response. Antes era enviado apenas homeStats.response, causando
    // ppg_h/exg_h/avg_sc_h/btts_h/under25_h nulos.
    homeStats,
    awayStats,

    homeGames,
    awayGames,
    h2hGames:    h2hRaw?.response || [],

    // Manter resposta completa; o mapper jÃ¡ normaliza predictions.response[0].
    predictions: predictionsRaw,
    odds:        oddsRaw,
  };
}


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FASE 4 â€” SALVAR NO SUPABASE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MKT_TO_LABEL = {
  resultadoFinal: 'Resultado Final (1X2)',
  over15:   'Over 1.5 gols',
  over25:   'Over 2.5 gols',
  btts:     'BTTS',
  over05ht: 'Over 0.5 HT',
  under45:  'Under 4.5 gols',
  under35:  'Under 3.5 gols',
  esc75:    'Over 7.5 cantos',
  esc85:    'Over 8.5 cantos',
  cards25:  'Over 2.5 cartÃ£o',
  cards35:  'Over 3.5 cartÃ£o',
  cards55:  'Over 5.5 cartÃ£o',
};

// Labels alternativos de mercado (linha alternativa resolve em tempo de execuÃ§Ã£o)
// Usado para exibiÃ§Ã£o no log e no banco â€” gerado pelo AltLineResolver
const MKT_ALT_LABELS = {
  // Escanteios
  'Esc 9.5':  'esc75', 'Esc 10.5': 'esc75',
  'Esc 9.5_85': 'esc85', 'Esc 10.5_85': 'esc85',
  // CartÃµes
    'Cart 4.5': 'cards25', 'Cart 5.5': 'cards25',
    'Cart 4.5_35': 'cards35', 'Cart 5.5_35': 'cards35',
};

/**
 * upsertFixture(raw, liga)
 * Upsert na tabela fixtures.
 */
async function upsertFixture(raw, liga) {
  const leagueId = Number(raw.league_id ?? liga?.id);
  if (!Number.isFinite(leagueId)) {
    throw new Error(`upsertFixture: league_id ausente para fixture ${raw.fixture_id}`);
  }

  const season = Number(raw.league_season ?? liga?.season);
  if (!Number.isFinite(season)) {
    throw new Error(`upsertFixture: season ausente para fixture ${raw.fixture_id}`);
  }

  const row = {
    fixture_id:     raw.fixture_id,
    league_id:      leagueId,
    league_name:    raw.league_name,
    season,
    tier:           liga?.tier || 'normal',
    match_date:     raw.match_date,
    home_team:      raw.home_team,
    away_team:      raw.away_team,
    home_team_logo: raw.home_team_logo || null,
    away_team_logo: raw.away_team_logo || null,
    status:         raw.status || 'NS',
    source:         'generate_predictions',
    updated_at:     new Date().toISOString(),
  };

  const { error } = await supabase
    .from('fixtures')
    .upsert(row, { onConflict: 'fixture_id' });

  if (error) throw new Error(`upsertFixture: ${error.message}`);
}

/**
 * upsertMetrics(raw, result)
 * Upsert na tabela match_metrics com variÃ¡veis brutas + derivadas.
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
    // Odds justas (null por enquanto â€” calculadas futuramente)
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
    'Resultado Final (1X2) - Casa': raw.odds_h,
    'Resultado Final (1X2) - Empate': raw.odds_d,
    'Resultado Final (1X2) - Visitante': raw.odds_a,
    'Over 1.5 gols': raw.odd_o15,
    'Over 2.5 gols': raw.odd_o25,
    'BTTS':        raw.odd_btts,
    'Over 0.5 HT': raw.odd_05ht,
    'Under 3.5 gols': raw.odd_u35,
    'Under 4.5 gols': raw.odd_u45,
    'Over 7.5 cantos': raw.odd_esc75,
    'Over 8.5 cantos': raw.odd_esc85,
    'Over 2.5 cartÃ£o': raw.odd_c25,
    'Over 3.5 cartÃ£o': raw.odd_c35,
    'Over 5.5 cartÃ£o': raw.odd_c55,
  };

  const rows = Object.entries(oddMap)
    .filter(([_, v]) => v !== null && v !== undefined)
    .map(([market, odd]) => ({
      fixture_id:    raw.fixture_id,
      market,
      value:        'Over',   // simplificado â€” refinado futuramente
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

  const mainMarketSet = new Set((result.main_markets || []).map(m => m.market));
  const rows = Object.entries(MKT_TO_LABEL).map(([key, marketDefault]) => {
    const score = result.scores[key];
    if (score === null || score === undefined) return null;

    const grade      = result.grades[key];
    const odd        = result.odds[key]  ?? null;
    const ev         = result.evs[key]   ?? null;

    // market Ã© sempre o label canÃ´nico V1 â€” nunca substituÃ­do por final_market.
    // Metadados de linha alternativa ficam em original_market / final_market (colunas separadas).
    const altInfo    = altLabelByKey[key];
    const market     = key === 'resultadoFinal'
      ? (result.filters.resultadoFinal_market || marketDefault)
      : marketDefault;   // canÃ´nico V1: 'Esc 7.5', nÃ£o 'Esc 9.5'
    const isBest     = mainMarketSet.has(market) || marketDefault === result.best_mkt;

    // Filtros especÃ­ficos
    let passedFilter   = false;
    let under35Passed  = false;
    if (key === 'over15')  passedFilter  = result.filters.over15_passed;
    if (key === 'under35') under35Passed = result.filters.under35_passed;

    // V1_COMPAT: apenas colunas que existem no schema base.
    // Removidos: probability, confidence, odd_justa, ev,
    //            original_market, is_alternative_line â€” ausentes no schema.
    return {
      fixture_id:      result.fixture_id,
      market,
      score:           Math.round(score * 100) / 100,
      grade,
      passed_filter:   passedFilter,
      under35_passed:  under35Passed,
      is_best_market:  isBest,
      odd,
      created_at:      new Date().toISOString(),
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
 * O snapshot usa o best_mkt â€” mercado oficial congelado (Â§7.1).
 * Preserva resultado se jogo jÃ¡ confirmado (FORCE=false).
 *
 * @returns {boolean} true se snapshot foi salvo
 */
async function upsertSnapshot(result, raw) {
  const markets = Array.isArray(result.main_markets) && result.main_markets.length
    ? result.main_markets
    : [{
        market: result.best_mkt,
        score: result.best_score,
        grade: result.best_grade,
        odd: result.best_odd,
      }];

  let saved = 0;

  for (const item of markets) {
    if (!item.market || item.score === null || item.score === undefined) continue;

    const _altForCanonical = (result.altLines || []).find(
      a => a.final_market === item.market || a.original_market === item.market
    );
    const canonicalMarket = _altForCanonical ? _altForCanonical.original_market : item.market;

    // Snapshots confirmados (green/red) sao imutaveis.
    const { data: existing } = await supabase
      .from('prediction_snapshots')
      .select('id, result_status')
      .eq('fixture_id', result.fixture_id)
      .eq('market', canonicalMarket)
      .single();

    if (existing?.result_status && existing.result_status !== null) {
      LOG.dim(`    Snapshot ${result.fixture_id} ${canonicalMarket} ja confirmado (${existing.result_status}) - preservado.`);
      continue;
    }

    const row = {
      fixture_id:     result.fixture_id,
      match_name:     result.jogo,
      home_team:      result.home_team,
      away_team:      result.away_team,
      home_team_logo: raw.home_team_logo || null,
      away_team_logo: raw.away_team_logo || null,
      league_name:    result.league_name,
      match_date:     result.match_date,
      hour:           result.hour         ?? null,
      market:         canonicalMarket,
      score:          Math.round(Number(item.score) * 100) / 100,
      grade:          item.grade,
      odd:            item.odd  ?? null,
      result_status:  null,
      source:         'generate_predictions',
      created_at:     new Date().toISOString(),
    };

    const { error } = await supabase
      .from('prediction_snapshots')
      .upsert(row, { onConflict: 'fixture_id,market' });

    if (error) throw new Error(`upsertSnapshot: ${error.message}`);
    saved++;
  }

  return saved;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FASE 5 â€” LOG DETALHADO POR FIXTURE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * printFixtureLog(raw, result, savedSnapshot, validation)
 * Imprime um log completo e estruturado para um fixture processado.
 */
function printFixtureLog(raw, result, savedSnapshot, validation) {
  const hr = 'â”€'.repeat(64);

  console.log(`\n${hr}`);
  console.log(` âš½  ${result.jogo}`);
  console.log(`     ${result.league_name}  â€¢  ${result.match_date?.slice(0,10)}  â€¢  ${result.hour}`);
  console.log(`     fixture_id: ${result.fixture_id}  |  status: ${raw.status}`);
  console.log(hr);

  // VariÃ¡veis-chave
  const d = result.derivadas;
  console.log(' ðŸ“Š  VariÃ¡veis:');
  console.log(`     xG:  h=${d.exg_h?.toFixed(2)??'null'} a=${d.exg_a?.toFixed(2)??'null'} tot=${d.exg_tot?.toFixed(2)??'null (sem xG)'}`);
  console.log(`     PPG: h=${d.ppg_avg?.toFixed(2)??'null'} min=${d.ppg_min?.toFixed(2)??'null'}`);
  console.log(`     H2H gols: ${raw.h2h_goals?.toFixed(1)??'null'}`);
  console.log(`     BTTS cf: ${d.btts_cf?.toFixed(1)??'null'}%`);
  console.log(`     Cantos: avg=${raw.avg_corners?.toFixed(1)??'null'}  over7.5=${raw.over75_c?.toFixed(0)??'null'}%`);
  console.log(`     CartÃµes: avg=${raw.avg_cards?.toFixed(1)??'null'}  over2.5=${raw.over25_cards?.toFixed(0)??'null'}%`);
  if (result.poisson) {
    console.log(`     Poisson: o15=${result.poisson.o15.toFixed(1)}%  o25=${result.poisson.o25.toFixed(1)}%  u35=${result.poisson.u35.toFixed(1)}%`);
  }

  // Warnings de validaÃ§Ã£o
  if (validation.warnings.length > 0) {
    console.log(` âš ï¸   Avisos: ${validation.warnings.join(' | ')}`);
  }

  // Tabela de scores
  console.log('\n ðŸŽ¯  Scores por mercado:');
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
    if (key === 'over15')  filtro = result.filters.over15_passed  ? `âœ“ Via${result.filters.over15_via}` : 'âœ—';
    if (key === 'under35') filtro = result.filters.under35_passed ? 'âœ“' : 'âœ—';

    const marker  = isBest ? ' â˜…' : '  ';
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
    console.log('\n \x1b[33mðŸ”€  Linhas alternativas:\x1b[0m');
    for (const alt of result.altLines) {
      console.log(
        `     ${alt.original_market} â†’ \x1b[33m${alt.final_market}\x1b[0m` +
        `  odd=${alt.odd_used}  score=${alt.score?.toFixed(1)}` +
        `  ev=${alt.ev !== null ? (alt.ev >= 0 ? '+' : '') + alt.ev + '%' : 'n/a'}` +
        `  [linha alternativa â€” gap=${alt.final_line - alt.original_line}]`
      );
    }
  }

  // Snapshot
  if (result.is_official) {
    const snap = savedSnapshot ? '\x1b[32mâœ“ snapshot salvo\x1b[0m' : '\x1b[33mâŸ³ snapshot preservado\x1b[0m';
    console.log(`     ${snap}  (grade ${result.best_grade} â€” palpite oficial)`);
  } else {
    console.log(`     \x1b[90mNÃ£o gera snapshot (grade ${result.best_grade} < A)\x1b[0m`);
  }

  console.log(hr);
}


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// PIPELINE PRINCIPAL
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * run()
 * Ponto de entrada do job. Executa o pipeline completo.
 */
async function run() {
  console.log('\n' + 'â•'.repeat(64));
  console.log(' WinMetrics Analytics â€” Generate Predictions');
  console.log(` Data inicial: ${TODAY}  |  days: ${DAYS}  |  dry-run: ${DRY_RUN}  |  force: ${FORCE}  |  only-new: ${ONLY_NEW}  |  limit: ${LIMIT || 'sem limite'}`);
  console.log('â•'.repeat(64) + '\n');

  // â”€â”€ Carrega CSVs do PackBall â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await csvEnricher.load();
  LOG.info(`[CSVEnricher] ${csvEnricher.index.size} jogos indexados dos CSVs do PackBall`);

  // ValidaÃ§Ã£o de ambiente
  if (!API_KEY) {
    LOG.error('API_FOOTBALL_KEY nÃ£o configurada. Abortando.');
    process.exit(1);
  }
  if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
    LOG.error('SUPABASE_URL ou SUPABASE_SERVICE_KEY nÃ£o configurados. Use --dry-run para testar sem banco.');
    process.exit(1);
  }
  if (DRY_RUN) {
    LOG.warn('Modo DRY-RUN: nenhuma escrita no Supabase serÃ¡ feita.');
  }
  if (V1_COMPAT_MODE) {
    LOG.info('V1_COMPAT_MODE ativo: AltLineResolver desabilitado, market = nome canÃ´nico V1.');
  } else {
    LOG.warn('V1_COMPAT_MODE desativado (--no-v1-compat): linhas alternativas habilitadas.');
  }

  // EstatÃ­sticas globais
  const stats = {
    fixtures_total: 0, fixtures_ok: 0, fixtures_error: 0,
    fixtures_skipped: 0,
    snapshots: 0, grades_ap: 0, grades_a: 0, grades_b: 0,
    markets_scored: 0, errors: [],
    api_fixture_calls: LIGAS.length * DAYS,
    api_detail_calls_estimated: 0,
    api_calls_saved: 0,
  };

  // â”€â”€ FASE 1: Buscar fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const fixtureEntries = await fetchTodayFixtures();
  stats.fixtures_total = fixtureEntries.length;

  if (fixtureEntries.length === 0) {
    LOG.warn('Nenhuma fixture encontrada para hoje. Encerrando.');
    return;
  }

  // â”€â”€ PROCESSAR CADA FIXTURE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  for (const entry of fixtureEntries) {
    const fixtureId = entry.fixture?.fixture?.id;

    try {
      // â”€â”€ CACHE: pula detalhes se jÃ¡ processado recentemente â”€â”€
      const cacheDecision = await shouldSkipFixture(entry);
      if (cacheDecision.skip) {
        stats.fixtures_skipped++;
        stats.api_calls_saved += cacheDecision.savedCalls || 0;
        LOG.dim(`Pulando fixture ${fixtureId} â€” ${cacheDecision.reason} (${cacheDecision.savedCalls} chamadas economizadas)`);
        continue;
      }

      // â”€â”€ FASE 2: Coletar dados â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      stats.api_detail_calls_estimated += 7;
      LOG.info(`Coletando fixture ${fixtureId} â€” ${entry.fixture?.teams?.home?.name} vs ${entry.fixture?.teams?.away?.name}`);
      const apiData = await fetchAllData(entry);

      // â”€â”€ ENRIQUECIMENTO CSV PackBall â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      csvEnricher.enrich(apiData);

      // â”€â”€ FASE 3: Mapear + validar + calcular â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      let raw        = await enrichFromWorldCup(
        PackBallMapper.mapFixtureToPackBall(apiData),
        supabase,
        LOG
      );

      // â”€â”€ APLICAR DADOS CSV SOBRE O raw â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (apiData.packballCSV) {
        raw = applyCsvToRaw(raw, apiData.packballCSV, LOG);
      }

      // ODDS PIPELINE TRACE â€” remove after debugging
      if (process.env.DEBUG_ODDS === '1') {
        const oddFields = ['odd_o15','odd_o25','odd_btts','odd_u35','odd_u45','odd_esc75','odd_esc85','odd_c25','odd_c35'];
        const rawOdds = oddFields.map(f => `${f}=${raw[f]}`).join(' | ');
        console.log(`[PIPELINE] raw apÃ³s mapper â€” ${rawOdds}`);
      }

      const validation = PackBallMapper.validatePackBallInput(raw);

      if (!validation.valid) {
        LOG.warn(`  Fixture ${fixtureId} invÃ¡lida:`, validation.critical.join(', '));
        stats.fixtures_error++;
        stats.errors.push({ fixtureId, errors: validation.critical });
        continue;
      }

      // â”€â”€ LINHA ALTERNATIVA (Esc / CartÃµes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // V1_COMPAT_MODE: AltLineResolver desativado.
      // O mercado exibido deve ser sempre o nome canÃ´nico V1 (mkt original).
      // Linhas alternativas sÃ³ sÃ£o aplicadas quando --no-v1-compat for passado.
      let result;
      if (V1_COMPAT_MODE) {
        // Modo compatÃ­vel: engine direto, sem override de label nem alt lines
        result = PredictionEngine.processFixture(raw);
        result.altLines = [];  // garante que altLines exista e esteja vazio
      } else {
        // Modo V3 nativo: resolve linhas alternativas antes do engine
        // Resolve linhas alternativas ANTES do engine, mas APÃ“S o mapper.
        // NÃ£o altera scores nem fÃ³rmulas â€” apenas preenche raw.odd_* ausentes
        // com a odd de uma linha prÃ³xima, e registra metadados de auditoria.
        // Uma primeira passagem do engine (sem odds) gera os scores que
        // servem de critÃ©rio de aceitaÃ§Ã£o da linha alternativa.
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
        result = AltLineResolver.applyLabelOverrides(_resultBase, labelOverrides, altLines);
      }

      // ODDS PIPELINE TRACE â€” remove after debugging
      if (process.env.DEBUG_ODDS === '1') {
        const mktKeys = ['over15','over25','btts','over05ht','under45','under35','esc75','esc85','cards25','cards35'];
        const resultOdds = mktKeys.map(k => `${k}=${result.odds[k]}`).join(' | ');
        const resultEvs  = mktKeys.map(k => `${k}=${result.evs[k]}`).join(' | ');
        console.log(`[PIPELINE] result.odds  â€” ${resultOdds}`);
        console.log(`[PIPELINE] result.evs   â€” ${resultEvs}`);
        console.log(`[PIPELINE] best_odd=${result.best_odd}  best_ev=${result.best_ev}`);
      }

      // Contabiliza grades
      const g = result.best_grade;
      if (g === 'A+') stats.grades_ap++;
      else if (g === 'A') stats.grades_a++;
      else if (g === 'B') stats.grades_b++;

      const scoredMarkets = Object.values(result.scores).filter(s => s !== null).length;
      stats.markets_scored += scoredMarkets;

      // â”€â”€ FASE 4: Salvar no Supabase â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      let savedSnapshot = false;

      if (!DRY_RUN && supabase) {
        await upsertFixture(raw, entry.liga);
        await upsertMetrics(raw, result);
        await upsertOdds(raw);
        await upsertPredictions(result);
        savedSnapshot = await upsertSnapshot(result, raw);

        if (savedSnapshot) stats.snapshots += Number(savedSnapshot);
        LOG.ok(`  Salvo: fixture ${fixtureId}  ${scoredMarkets} mercados  ${savedSnapshot ? `${savedSnapshot} snapshot(s) âœ“` : ''}`);
      } else if (DRY_RUN) {
        // Em dry-run: simula o snapshot se elegÃ­vel
        savedSnapshot = Array.isArray(result.main_markets) ? result.main_markets.length : Number(Boolean(result.is_official));
        if (savedSnapshot) stats.snapshots += Number(savedSnapshot);
        LOG.ok(`  [DRY-RUN] ${fixtureId}  ${scoredMarkets} mercados  best=${result.best_mkt} grade=${result.best_grade}`);
      }

      // â”€â”€ FASE 5: Log detalhado â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ FASE 6: Resumo final â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  printSummary(stats);
}

/**
 * printSummary(stats)
 */
function printSummary(stats) {
  const hr = 'â•'.repeat(64);
  console.log('\n' + hr);
  console.log(' RESUMO FINAL');
  console.log(hr);
  console.log(` Fixtures processadas: ${stats.fixtures_ok}/${stats.fixtures_total}  (${stats.fixtures_error} erros, ${stats.fixtures_skipped || 0} puladas por cache)`);
  console.log(` Mercados calculados:  ${stats.markets_scored}`);
  console.log(` Snapshots criados:    ${stats.snapshots}`);
  console.log(` Grades:  A+=${stats.grades_ap}  A=${stats.grades_a}  B=${stats.grades_b}`);
  console.log(` API â€” chamadas fixtures: ${stats.api_fixture_calls || 0}`);
  console.log(` API â€” chamadas detalhes estimadas: ${stats.api_detail_calls_estimated || 0}`);
  console.log(` API â€” chamadas economizadas: ${stats.api_calls_saved || 0}`);
  if (stats.errors.length > 0) {
    console.log('\n Erros:');
    stats.errors.forEach(e => console.log(`   fixture ${e.fixtureId}: ${e.errors || e.error}`));
  }
  console.log(hr + '\n');
}


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// EXEMPLO COMPLETO â€” runExample()
// Executa com dados mockados para demonstraÃ§Ã£o sem API real
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * runExample()
 * Demonstra o pipeline completo com dados mockados.
 * Invocado automaticamente quando nÃ£o hÃ¡ API_KEY configurada.
 */
async function runExample() {
  console.log('\n' + 'â•'.repeat(64));
  console.log(' MODO EXEMPLO â€” dados mockados (sem API real)');
  console.log('â•'.repeat(64));

  // â”€â”€ Entrada API-Football simulada â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const mockApiData = {
    fixture: {
      fixture: { id: 1049201, date: '2026-06-10T22:00:00+00:00', status: { short: 'NS', long: 'Not Started' } },
      league:  { id: 71, name: 'BrasileirÃ£o SÃ©rie A', season: 2026 },
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

  console.log('\nðŸ“¥  FASE 1 â€” Entrada API-Football (resumo):');
  console.log(`    fixture_id: ${mockApiData.fixture.fixture.id}`);
  console.log(`    jogo:       ${mockApiData.fixture.teams.home.name} vs ${mockApiData.fixture.teams.away.name}`);
  console.log(`    liga:       ${mockApiData.fixture.league.name}`);
  console.log(`    homeStats:  played=${mockApiData.homeStats.response.fixtures.played.total}  goals_for_avg=${mockApiData.homeStats.response.goals.for.average.total}`);
  console.log(`    h2h:        ${mockApiData.h2hGames.length} jogos`);
  console.log(`    odds:       ${mockApiData.odds.response[0].bookmakers[0].bets.reduce((a,b) => a + b.values.length, 0)} valores`);

  // â”€â”€ FASE 2: Mapear â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const raw = PackBallMapper.mapFixtureToPackBall(mockApiData);
  console.log('\nðŸ“¦  FASE 2 â€” Objeto RAW (packball_mapper.js):');
  console.log(JSON.stringify(raw, (k, v) => v !== null ? v : undefined, 2));

  // â”€â”€ FASE 3: Validar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const validation = PackBallMapper.validatePackBallInput(raw);
  console.log('\nðŸ”  FASE 3 â€” ValidaÃ§Ã£o:');
  console.log(`    valid: ${validation.valid}  critical: ${validation.critical.length}  warnings: ${validation.warnings.length}`);
  validation.info.forEach(i => console.log(`    â†’ ${i}`));
  if (validation.warnings.length) validation.warnings.forEach(w => console.log(`    âš  ${w}`));

  // â”€â”€ FASE 4: Motor (com resolver de linha alternativa) â”€â”€â”€â”€â”€â”€â”€â”€
  const _scoresEx = PredictionEngine.processFixture(raw).scores;
  const { raw: rawPatchedEx, labelOverrides: loEx, altLines: altLinesEx } =
    AltLineResolver.resolveAlternativeLines(raw, mockApiData.odds, _scoresEx);
  if (altLinesEx.length > 0) {
    console.log('\nðŸ”€  Linhas alternativas resolvidas:');
    AltLineResolver.logAltLines(altLinesEx, raw.fixture_id, { info: console.log });
  }
  const _baseEx = PredictionEngine.processFixture(rawPatchedEx);
  const result  = AltLineResolver.applyLabelOverrides(_baseEx, loEx, altLinesEx);
  console.log('\nðŸ”¢  FASE 4 â€” PredictionEngine.processFixture():');
  console.log(`    exg_tot=${result.derivadas.exg_tot?.toFixed(2)}  ppg_avg=${result.derivadas.ppg_avg?.toFixed(2)}`);
  if (result.poisson) {
    console.log(`    Poisson: o15=${result.poisson.o15.toFixed(1)}%  o25=${result.poisson.o25.toFixed(1)}%  u35=${result.poisson.u35.toFixed(1)}%`);
  }

  // â”€â”€ FASE 5: Log completo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  printFixtureLog(raw, result, result.is_official, validation);

  // â”€â”€ FASE 6: Registro Supabase (simulado) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('\nðŸ’¾  FASE 5 â€” Registros que seriam salvos no Supabase:');

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
    console.log(`    ${(isBest ? 'â˜… ' : '  ')}${market.padEnd(14)} score=${sc.toFixed(1).padStart(5)}  grade=${gr}  is_best=${isBest}`);
  });

  if (result.is_official) {
    console.log('\n  prediction_snapshots:');
    console.log(`    fixture_id=${result.fixture_id}  match_name="${result.jogo}"`);
    console.log(`    market="${result.best_mkt}"  score=${result.best_score?.toFixed(1)}  grade=${result.best_grade}`);
    console.log(`    confidence="${result.best_confidence}"  odd=${result.best_odd}  ev=${result.best_ev}`);
    console.log(`    result_status=null  (aguardando confirmar.js)`);
  } else {
    console.log(`\n  prediction_snapshots: nÃ£o gerado (grade ${result.best_grade} < A)`);
  }

  console.log('\n' + 'â•'.repeat(64));
  console.log(' Exemplo concluÃ­do. Configure API_FOOTBALL_KEY para execuÃ§Ã£o real.');
  console.log('â•'.repeat(64) + '\n');
}


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ENTRY POINT
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

if (!MOCK_TO_SUPABASE) {
  // â”€â”€ DiagnÃ³stico de variÃ¡veis de ambiente â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('--- ENV CHECK ---');
  console.log('API_FOOTBALL_KEY:    ', !!process.env.API_FOOTBALL_KEY, process.env.API_FOOTBALL_KEY ? '(set, length=' + process.env.API_FOOTBALL_KEY.length + ')' : '(EMPTY)');
  console.log('SUPABASE_URL:        ', !!process.env.SUPABASE_URL,      process.env.SUPABASE_URL      ? '(set)' : '(EMPTY)');
  console.log('SUPABASE_SERVICE_KEY:', !!process.env.SUPABASE_SERVICE_KEY, process.env.SUPABASE_SERVICE_KEY ? '(set)' : '(EMPTY)');
  console.log('API_KEY (const):     ', !!API_KEY, 'â†’ entra em', !API_KEY ? 'runExample()' : 'run()');
  console.log('-----------------');

  if (!API_KEY) {
    // Sem chave configurada â†’ executa o exemplo de demonstraÃ§Ã£o
    runExample().catch(err => {
      LOG.error('Erro no exemplo:', err.message);
      process.exit(1);
    });
  } else {
    // Com chave configurada â†’ executa o pipeline real
    run().catch(err => {
      if (err.code === 'QUOTA_EXCEEDED') {
        LOG.warn('Quota da API esgotada â€” pipeline encerrado com cÃ³digo 2.');
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


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MODO --mock-to-supabase
// Executa o pipeline completo com dados mockados (Flamengo x Palmeiras)
// e grava no Supabase real. Para validaÃ§Ã£o antes de conectar API-Football.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node generate_predictions.js --mock-to-supabase
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runMockToSupabase() {
  console.log('\n' + 'â•'.repeat(64));
  console.log(' WinMetrics â€” MOCK-TO-SUPABASE');
  console.log(' Pipeline completo com dados mockados â†’ Supabase real');
  console.log('â•'.repeat(64));

  // â”€â”€ ValidaÃ§Ã£o de ambiente â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    LOG.error('SUPABASE_URL e SUPABASE_SERVICE_KEY sÃ£o obrigatÃ³rios neste modo.');
    LOG.error('Exemplo:');
    LOG.error('  SUPABASE_URL=https://xxx.supabase.co \\');
    LOG.error('  SUPABASE_SERVICE_KEY=eyJ... \\');
    LOG.error('  node generate_predictions.js --mock-to-supabase');
    process.exit(1);
  }

  if (!supabase) {
    LOG.error('Supabase client nÃ£o inicializado. Verifique as variÃ¡veis de ambiente.');
    process.exit(1);
  }

  LOG.info('Supabase conectado: ' + SUPABASE_URL);

  // â”€â”€ Dados mockados: Flamengo x Palmeiras â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  LOG.info('Construindo dados mockados (Flamengo x Palmeiras)...');

  const mockApiData = {
    fixture: {
      fixture: {
        id: 1049201,
        date: '2026-06-10T22:00:00+00:00',
        status: { short: 'NS', long: 'Not Started' },
      },
      league: { id: 71, name: 'BrasileirÃ£o SÃ©rie A', season: 2026 },
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

  const liga = { id: 71, season: 2026, name: 'BrasileirÃ£o SÃ©rie A', tier: 'normal' };

  // â”€â”€ Fase 1: Mapear â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  LOG.info('Fase 1 â€” PackBallMapper.mapFixtureToPackBall()...');
  const raw = PackBallMapper.mapFixtureToPackBall(mockApiData);
  LOG.ok(`  fixture_id=${raw.fixture_id}  exg_tot=${((raw.exg_h||0)+(raw.exg_a||0)).toFixed(2)}  over15_g=${raw.over15_g}`);

  const validation = PackBallMapper.validatePackBallInput(raw);
  if (!validation.valid) {
    LOG.error('ValidaÃ§Ã£o falhou:', validation.critical.join(', '));
    process.exit(1);
  }
  LOG.ok('  ValidaÃ§Ã£o OK â€” ' + validation.info.join(' | '));

  // â”€â”€ Fase 2: Motor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  LOG.info('Fase 2 â€” PredictionEngine.processFixture() (com linha alternativa)...');
  const _scoresMock = PredictionEngine.processFixture(raw).scores;
  const { raw: rawPatchedMock, labelOverrides: loMock, altLines: altLinesMock } =
    AltLineResolver.resolveAlternativeLines(raw, mockApiData.odds, _scoresMock);
  if (altLinesMock.length > 0) AltLineResolver.logAltLines(altLinesMock, raw.fixture_id, LOG);
  const _baseMock = PredictionEngine.processFixture(rawPatchedMock);
  const result    = AltLineResolver.applyLabelOverrides(_baseMock, loMock, altLinesMock);
  LOG.ok(`  best_mkt="${result.best_mkt}"  score=${result.best_score?.toFixed(1)}  grade=${result.best_grade}  is_official=${result.is_official}`);

  // â”€â”€ Fase 3: Gravar no Supabase â€” PARA NO PRIMEIRO ERRO â”€â”€â”€â”€â”€â”€â”€â”€
  const inserted = {
    fixtures: 0, match_metrics: 0, odds: 0,
    predictions: 0, prediction_snapshots: 0,
    ids: { prediction_snapshots: null },
    errors: [],
  };

  // â”€â”€ 3a. fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  LOG.info('Fase 3a â€” INSERT fixtures...');
  console.log('  Colunas:', [
    'fixture_id','league_id','league_name','season','tier',
    'match_date','home_team','away_team','home_team_id','away_team_id',
    'status','updated_at',
  ].join(', '));

  try {
    await upsertFixture(raw, liga);
    inserted.fixtures = 1;
    LOG.ok('  fixtures OK â€” fixture_id=' + raw.fixture_id);
  } catch (err) {
    inserted.errors.push({ table: 'fixtures', error: err.message });
    LOG.error('  ERRO em fixtures:', err.message);
    printMockSummary(inserted);
    process.exit(1);
  }

  // â”€â”€ 3b. match_metrics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  LOG.info('Fase 3b â€” INSERT match_metrics...');
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
    LOG.ok('  match_metrics OK â€” exg_tot=' + result.derivadas.exg_tot?.toFixed(3));
  } catch (err) {
    inserted.errors.push({ table: 'match_metrics', error: err.message });
    LOG.error('  ERRO em match_metrics:', err.message);
    printMockSummary(inserted);
    process.exit(1);
  }

  // â”€â”€ 3c. odds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  LOG.info('Fase 3c â€” DELETE + INSERT odds...');
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
    LOG.ok(`  odds OK â€” ${oddsToInsert.length} linhas inseridas`);
  } catch (err) {
    inserted.errors.push({ table: 'odds', error: err.message });
    LOG.error('  ERRO em odds:', err.message);
    printMockSummary(inserted);
    process.exit(1);
  }

  // â”€â”€ 3d. predictions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  LOG.info('Fase 3d â€” UPSERT predictions (10 mercados)...');
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
    console.log(`    ${isBest?'â˜…':' '} market="${m}"  score=${sc.toFixed(1)}  grade=${result.grades[k]}  is_best_market=${isBest}`);
  });

  try {
    await upsertPredictions(result);
    inserted.predictions = Object.values(result.scores).filter(v => v !== null).length;
    LOG.ok(`  predictions OK â€” ${inserted.predictions} linhas, best_mkt="${result.best_mkt}"`);
  } catch (err) {
    inserted.errors.push({ table: 'predictions', error: err.message });
    LOG.error('  ERRO em predictions:', err.message);
    printMockSummary(inserted);
    process.exit(1);
  }

  // â”€â”€ 3e. prediction_snapshots â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (result.is_official) {
    LOG.info('Fase 3e â€” UPSERT prediction_snapshots...');
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
        LOG.ok(`  prediction_snapshots OK â€” snapshot criado`);

        // Busca o ID gerado para mostrar no resumo
        const { data: snap } = await supabase
          .from('prediction_snapshots')
          .select('id, created_at')
          .eq('fixture_id', result.fixture_id)
          .eq('market', result.best_mkt)
          .single();
        inserted.ids.prediction_snapshots = snap?.id || '(nÃ£o recuperado)';
        LOG.ok(`  ID gerado: ${inserted.ids.prediction_snapshots}`);
      } else {
        LOG.warn('  Snapshot nÃ£o criado (jÃ¡ existia com resultado confirmado)');
      }
    } catch (err) {
      inserted.errors.push({ table: 'prediction_snapshots', error: err.message });
      LOG.error('  ERRO em prediction_snapshots:', err.message);
      printMockSummary(inserted);
      process.exit(1);
    }
  } else {
    LOG.dim(`  prediction_snapshots: pulado (grade ${result.best_grade} nÃ£o Ã© A+/A)`);
  }

  // â”€â”€ VerificaÃ§Ã£o pÃ³s-gravaÃ§Ã£o (SELECT de confirmaÃ§Ã£o) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  LOG.info('VerificaÃ§Ã£o â€” lendo registros gravados...');

  const checks = await Promise.allSettled([
    supabase.from('fixtures').select('fixture_id,home_team,away_team,status').eq('fixture_id', raw.fixture_id).single(),
    supabase.from('match_metrics').select('fixture_id,exg_h,exg_a,over15_g').eq('fixture_id', raw.fixture_id).single(),
    supabase.from('odds').select('market,odd').eq('fixture_id', raw.fixture_id),
    supabase.from('predictions').select('market,score,grade,is_best_market').eq('fixture_id', raw.fixture_id),
    supabase.from('prediction_snapshots').select('id,market,score,grade').eq('fixture_id', raw.fixture_id),
  ]);

  const [chkFix, chkMet, chkOdds, chkPred, chkSnap] = checks;

  console.log('\n  â”Œâ”€ fixtures:');
  if (chkFix.status === 'fulfilled' && chkFix.value.data) {
    const r = chkFix.value.data;
    console.log(`  â”‚  fixture_id=${r.fixture_id}  "${r.home_team} vs ${r.away_team}"  status="${r.status}"`);
  } else {
    console.log(`  â”‚  ERRO: ${chkFix.value?.error?.message || chkFix.reason}`);
  }

  console.log('  â”œâ”€ match_metrics:');
  if (chkMet.status === 'fulfilled' && chkMet.value.data) {
    const r = chkMet.value.data;
    console.log(`  â”‚  fixture_id=${r.fixture_id}  exg_h=${r.exg_h}  exg_a=${r.exg_a}  over15_g=${r.over15_g}`);
  } else {
    console.log(`  â”‚  ERRO: ${chkMet.value?.error?.message || chkMet.reason}`);
  }

  console.log('  â”œâ”€ odds:');
  if (chkOdds.status === 'fulfilled' && chkOdds.value.data) {
    chkOdds.value.data.forEach(o => console.log(`  â”‚  market="${o.market}"  odd=${o.odd}`));
  } else {
    console.log(`  â”‚  ERRO: ${chkOdds.value?.error?.message || chkOdds.reason}`);
  }

  console.log('  â”œâ”€ predictions:');
  if (chkPred.status === 'fulfilled' && chkPred.value.data) {
    chkPred.value.data.forEach(p =>
      console.log(`  â”‚  ${p.is_best_market?'â˜…':' '} market="${p.market}"  score=${p.score}  grade=${p.grade}`)
    );
  } else {
    console.log(`  â”‚  ERRO: ${chkPred.value?.error?.message || chkPred.reason}`);
  }

  console.log('  â””â”€ prediction_snapshots:');
  if (chkSnap.status === 'fulfilled' && chkSnap.value.data && chkSnap.value.data.length > 0) {
    chkSnap.value.data.forEach(s =>
      console.log(`     id=${s.id}  market="${s.market}"  score=${s.score}  grade=${s.grade}`)
    );
  } else {
    console.log(`     (nenhum â€” grade < A ou jÃ¡ confirmado)`);
  }

  printMockSummary(inserted);
}

function printMockSummary(inserted) {
  const hr = 'â•'.repeat(64);
  console.log('\n' + hr);
  console.log(' RESUMO â€” mock-to-supabase');
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
    console.log('\n PrÃ³ximo passo recomendado:');
    const tbl = inserted.errors[0].table;
    console.log(`   1. Verificar se a tabela "${tbl}" existe no Supabase (SQL Editor)`);
    console.log(`   2. Confirmar que o SUPABASE_SERVICE_KEY tem role service_role`);
    console.log(`   3. Checar se RLS estÃ¡ bloqueando (policy "Service write ${tbl}" deve existir)`);
    console.log(`   4. Rodar: frontend/database/winmetrics_schema.sql no SQL Editor`);
  } else {
    console.log('\n PrÃ³ximo passo recomendado:');
    console.log('   1. Conferir os registros no Supabase Dashboard â†’ Table Editor');
    console.log('   2. Confirmar que prediction_snapshots.market = "Esc 7.5"');
    console.log('   3. Configurar API_FOOTBALL_KEY e rodar com --dry-run para validar o pipeline real');
    console.log('   4. Em seguida, rodar sem flags para gravar com dados reais da API');
  }
  console.log(hr + '\n');
}

// â”€â”€ Adiciona --mock-to-supabase ao entry point existente â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// (Este bloco substitui o if(!API_KEY) jÃ¡ existente via check adicional)
if (MOCK_TO_SUPABASE) {
  runMockToSupabase().catch(err => {
    LOG.error('Erro fatal no mock-to-supabase:', err.message);
    process.exit(1);
  });
}

