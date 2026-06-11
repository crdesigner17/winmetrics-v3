#!/usr/bin/env node
/**
 * WinMetrics V3 — Pipeline PackBall v3.0
 * ─────────────────────────────────────────────────────────────────
 * Replica exatamente a lógica do V1 coletar.py + processar.py.
 * Coleta dados da API-Football, calcula scores e salva no Supabase.
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  V1_COMPAT_MODE = true  (padrão)                            ║
 * ║  Regras obrigatórias enquanto V1 é fonte de verdade:        ║
 * ║  1. Não recalcular score/grade importados do V1             ║
 * ║  2. Não aplicar final_market nem linhas alternativas        ║
 * ║  3. passou_filtro afeta APENAS a elegibilidade do Over 1.5  ║
 * ║     como candidato ao best_mkt — não bloqueia o snapshot    ║
 * ║  4. Sem filtros extras por probability/confidence/edge/odd  ║
 * ║  5. Sem filtros por status/league                           ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Endpoints utilizados (idêntico ao V1):
 *   /fixtures              → fixtures do dia por liga
 *   /fixtures/headtohead   → H2H últimos 10 jogos
 *   /teams/statistics      → médias sazonais (PPG, gols, BTTS)
 *   /fixtures/statistics   → corners, cards, shots (jogos recentes)
 *   /odds                  → odds 1X2, over/under
 *   /predictions           → over15_pct, over25_pct, under_over
 *
 * Uso:
 *   node frontend/jobs/pipeline_v1.js --date=2026-06-11
 *   node frontend/jobs/pipeline_v1.js --date=today
 *   node frontend/jobs/pipeline_v1.js --date=today --force
 *   node frontend/jobs/pipeline_v1.js --date=today --dry-run
 *
 * Variáveis de ambiente:
 *   API_FOOTBALL_KEY     — chave da API-Football
 *   SUPABASE_URL         — URL do projeto Supabase
 *   SUPABASE_SERVICE_KEY — service_role key
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────

const API_KEY      = process.env.API_FOOTBALL_KEY     || '';
const SUPABASE_URL = process.env.SUPABASE_URL         || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const API_BASE     = 'https://v3.football.api-sports.io';

const args    = process.argv.slice(2);
const dateArg = args.find(a => a.startsWith('--date='))?.split('=')[1] || 'today';
const FORCE   = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');

// ─────────────────────────────────────────────────────────────────
// LIGAS — idêntico ao V1 coletar.py
// ─────────────────────────────────────────────────────────────────

// Ligas confirmadas nos JSONs V1 atuais:
// Bundesliga, Champions League, Copa do Brasil, Copa Libertadores,
// Copa Uruguay, Eredivisie, FIFA World Cup, Friendlies, La Liga,
// Liga Portugal, Liga Profesional de Futebol, Ligue 1, Premier League,
// Serie A, Serie B, Superliga.
//
// Copa Uruguay existe nos dados V1, mas os JSONs nao trazem league_id.
// Adicionar aqui assim que o ID correto da API-Football for confirmado.
const LIGAS = [
  // Europa (season=2025)
  { id: 2,   nome: 'Champions League',          tier: 'elite',  season: 2025 },
  { id: 3,   nome: 'UEFA Europa League',         tier: 'elite',  season: 2025 },
  { id: 848, nome: 'UEFA Europa Conference League', tier: 'normal', season: 2025 },
  { id: 39,  nome: 'Premier League',             tier: 'elite',  season: 2025 },
  { id: 135, nome: 'Serie A',                    tier: 'elite',  season: 2025 },
  { id: 140, nome: 'La Liga',                    tier: 'elite',  season: 2025 },
  { id: 78,  nome: 'Bundesliga',                 tier: 'elite',  season: 2025 },
  { id: 61,  nome: 'Ligue 1',                    tier: 'elite',  season: 2025 },
  { id: 88,  nome: 'Eredivisie',                 tier: 'normal', season: 2025 },
  { id: 94,  nome: 'Liga Portugal',              tier: 'normal', season: 2025 },
  { id: 283, nome: 'Superliga',                  tier: 'normal', season: 2025 },
  { id: 203, nome: 'Super Lig',                  tier: 'normal', season: 2025 },
  { id: 40,  nome: 'Championship',               tier: 'normal', season: 2025 },
  { id: 87,  nome: 'La Liga 2',                  tier: 'normal', season: 2025 },
  { id: 79,  nome: '2. Bundesliga',              tier: 'normal', season: 2025 },
  { id: 62,  nome: 'Ligue 2',                    tier: 'normal', season: 2025 },
  { id: 89,  nome: 'Eerste Divisie',             tier: 'normal', season: 2025 },
  { id: 119, nome: 'Super League',               tier: 'normal', season: 2025 },
  { id: 271, nome: 'Pro League',                 tier: 'normal', season: 2025 },
  { id: 218, nome: '1. HNL',                     tier: 'normal', season: 2025 },
  { id: 103, nome: 'Eliteserien',                tier: 'normal', season: 2025 },
  // América do Sul (season=2026)
  { id: 13,  nome: 'Copa Libertadores',          tier: 'elite',  season: 2026 },
  { id: 11,  nome: 'Copa Sudamericana',          tier: 'normal', season: 2026 },
  { id: 1,   nome: 'FIFA World Cup',             tier: 'elite',  season: 2026 },
  { id: 9,   nome: 'FIFA Club World Cup',        tier: 'elite',  season: 2025 },
  { id: 6,   nome: 'Copa America',               tier: 'elite',  season: 2024 },
  { id: 71,  nome: 'Brasileirão Série A',        tier: 'normal', season: 2026 },
  { id: 72,  nome: 'Brasileirão Série B',        tier: 'normal', season: 2026 },
  { id: 73,  nome: 'Brasileirão Série C',        tier: 'normal', season: 2026 },
