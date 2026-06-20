/**
 * WinMetrics V3 — Ranking FIFA Masculino (snapshot fixo Copa do Mundo 2026)
 * ─────────────────────────────────────────────────────────────────────────────
 * Snapshot estático do Ranking FIFA Masculino de 11/06/2026 — último ranking
 * oficial divulgado antes da abertura da Copa do Mundo 2026.
 * Fonte-base: FIFA, atualização oficial 11 June 2026.
 *
 * NÃO atualizar automaticamente — este ranking é válido para todo o torneio
 * (a FIFA não publica atualização durante a Copa). Para o próximo ciclo,
 * trocar manualmente este objeto.
 *
 * Usado por:
 *   - frontend/lib/wc_resultado_final.js  (mercado Vencer/Vencer — peso 15%)
 *   - frontend/lib/wc_dupla_chance.js     (mercado Dupla Chance   — peso 15%)
 *
 * Regra: ranking MENOR é melhor. O Ranking FIFA nunca aprova uma entrada
 * sozinho — é só um critério complementar dentro do score ponderado.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const FIFA_RANKING_WORLD_CUP_2026 = {
  'Argentina': 1,
  'Spain': 2,
  'France': 3,
  'England': 4,
  'Portugal': 5,
  'Brazil': 6,
  'Morocco': 7,
  'Netherlands': 8,
  'Belgium': 9,
  'Germany': 10,
  'Croatia': 11,
  'Colombia': 13,
  'Mexico': 14,
  'Senegal': 15,
  'Uruguay': 16,
  'United States': 17,
  'USA': 17,
  'Japan': 18,
  'Switzerland': 19,
  'Iran': 20,
  'IR Iran': 20,
  'Türkiye': 22,
  'Turkey': 22,
  'Ecuador': 23,
  'Austria': 24,
  'South Korea': 25,
  'Korea Republic': 25,
  'Australia': 27,
  'Algeria': 28,
  'Egypt': 29,
  'Canada': 30,
  'Norway': 31,
  'Ivory Coast': 33,
  "Côte d'Ivoire": 33,
  'Panama': 34,
  'Sweden': 38,
  'Czechia': 40,
  'Paraguay': 41,
  'Scotland': 42,
  'Tunisia': 45,
  'DR Congo': 46,
  'Congo DR': 46,
  'Uzbekistan': 50,
  'Qatar': 56,
  'Iraq': 57,
  'South Africa': 60,
  'Saudi Arabia': 61,
  'Jordan': 63,
  'Bosnia and Herzegovina': 64,
  'Cape Verde': 67,
  'Cabo Verde': 67,
  'Ghana': 73,
  'Curaçao': 82,
  'Curacao': 82,
  'Haiti': 83,
  'New Zealand': 85,
};

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZAÇÃO DE NOMES
// Remove acentos, ignora maiúsculas/minúsculas, aceita os aliases listados
// (já presentes como chaves duplicadas na tabela acima).
// ─────────────────────────────────────────────────────────────────────────────

function normalizeTeamNameForFifa(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// Índice normalizado, construído uma vez a partir da tabela acima — assim
// qualquer alias já cadastrado (USA/United States, IR Iran/Iran, etc.)
// funciona automaticamente, sem precisar de um mapa de aliases separado.
const FIFA_RANKING_INDEX = Object.entries(FIFA_RANKING_WORLD_CUP_2026)
  .reduce((acc, [name, rank]) => {
    acc[normalizeTeamNameForFifa(name)] = rank;
    return acc;
  }, {});

/**
 * getFifaRank(teamName) → number | null
 * Retorna a posição no Ranking FIFA (snapshot 11/06/2026) ou null se a
 * seleção não está na tabela (nunca inventa um valor).
 */
function getFifaRank(teamName) {
  const key = normalizeTeamNameForFifa(teamName);
  return Object.prototype.hasOwnProperty.call(FIFA_RANKING_INDEX, key)
    ? FIFA_RANKING_INDEX[key]
    : null;
}

/**
 * calculateFifaRankingScore(favoriteRank, opponentRank) → 0-100
 *
 * rankingGap = opponentRank - favoriteRank (positivo = favorito mais bem
 * posicionado, já que ranking menor é melhor).
 *
 *   gap >= 50 → 100  (enorme superioridade)
 *   gap >= 30 →  90
 *   gap >= 20 →  80  (vantagem forte)
 *   gap >= 10 →  70
 *   gap >=  5 →  60
 *   gap >=  0 →  50  (jogo equilibrado quando gap < 5)
 *
 * Quando o favorito (por probabilidade) tem ranking PIOR que o adversário
 * (gap negativo), aplica penalização forte — nunca trava em 50 silenciosamente.
 */
function calculateFifaRankingScore(favoriteRank, opponentRank) {
  if (favoriteRank === null || favoriteRank === undefined) return null;
  if (opponentRank === null || opponentRank === undefined) return null;

  const rankingGap = opponentRank - favoriteRank;

  if (rankingGap >= 50) return 100;
  if (rankingGap >= 30) return 90;
  if (rankingGap >= 20) return 80;
  if (rankingGap >= 10) return 70;
  if (rankingGap >= 5)  return 60;
  if (rankingGap >= 0)  return 50; // jogo equilibrado no critério ranking

  // ── Penalização forte: favorito por probabilidade tem ranking pior ──────
  if (rankingGap <= -50) return 0;
  if (rankingGap <= -20) return 10; // "vantagem forte" do adversário no ranking
  if (rankingGap < 0)    return 30;

  return 50;
}

module.exports = {
  FIFA_RANKING_WORLD_CUP_2026,
  normalizeTeamNameForFifa,
  getFifaRank,
  calculateFifaRankingScore,
};
