#!/usr/bin/env node
/**
 * WinMetrics Analytics — Generate Predictions
 * ─────────────────────────────────────────────
 * Pipeline de geração de previsões reais.
 * Implementação fiel ao coletar.py do PackBall v3.0 (seções 2–7).
 *
 * Fluxo:
 *   1. Buscar fixtures do dia nas ligas suportadas
 *   2. Coletar dados da API-Football (5 chamadas paralelas por jogo)
 *   3. Mapear → PackBallMapper.mapFixtureToPackBall()
 *   4. Calcular → PredictionEngine.processFixture()
 *   5. Salvar → fixtures, match_metrics, odds, predictions, prediction_snapshots
 *   6. Log detalhado por fixture
 *
 * Uso:
 *   node generate_predictions.js [--date YYYY-MM-DD] [--days N] [--dry-run] [--force] [--only-new] [--limit N]
 *
 * Exemplos econômicos:
 *   node generate_predictions.js --days=3 --only-new --dry-run
 *   node generate_predictions.js --days=3 --only-new
 *   node generate_predictions.js --date=2026-06-10 --force
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL          — URL do projeto Supabase
 *   SUPABASE_SERVICE_KEY  — service_role key (bypass RLS)
 *   API_FOOTBALL_KEY      — chave da API-Football v3
 *
 * Dependências (package.json):
 *   @supabase/supabase-js ^2
 *   node-fetch ^3   (ou Node 18+ nativo)
 */

'use strict';

// ─────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────

const path  = require('path');
const { createClient } = require('@supabase/supabase-js');

// Carrega os módulos locais relativos a este arquivo
const PredictionEngine       = require('../lib/prediction_engine_v1.js');
const PackBallMapper         = require('../lib/packball_mapper.js');
const AltLineResolver        = require('../lib/alternative_line_resolver.js');


// ─────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────────

const SUPABASE_URL  = process.env.SUPABASE_URL         || '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';
const API_KEY       = process.env.API_FOOTBALL_KEY     || '';
const API_BASE      = 'https://v3.football.api-sports.io';

// Flags de execução
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

// ─────────────────────────────────────────────────────────────────
// MODO COMPATÍVEL V1
// Ativado por padrão enquanto V1 for fonte de verdade.
// Desative com --no-v1-compat apenas quando o V3 estiver validado.
//
// Com V1_COMPAT_MODE = true:
//   • Linhas alternativas NÃO são aplicadas (AltLineResolver ignorado)
//   • market salvo = nome canônico V1 (mkt original, sem final_market)
//   • passou_filtro afeta apenas a elegibilidade do Over 1.5
//   • Sem filtros extras por probability / confidence / edge / odd
//   • Sem filtros por status ou league
// ─────────────────────────────────────────────────────────────────
const V1_COMPAT_MODE = !args.includes('--no-v1-compat');

// Ligas suportadas (§2.2)
const LIGAS = [
  // ── Tier elite ────────────────────────────────────────────────
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
  // ── Tier normal — Europa ──────────────────────────────────────
  { id: 848, season: 2025, name: 'UEFA Europa Conference League', tier: 'normal' },
  { id: 40,  season: 2025, name: 'Championship',              tier: 'normal' },
