/**
 * WinMetrics V3 — Motor WC Gols (Copa do Mundo 2026)
 * ─────────────────────────────────────────────────────────────────────────────
 * Calcula previsões de mercados de gols EXCLUSIVAMENTE para jogos da Copa do
 * Mundo. Substitui completamente a lógica padrão do prediction_engine_v1.js
 * para esses jogos.
 *
 * Mercados:
 *   Over 0.5 HT | Over 1.5 | Over 2.5 | Under 3.5 | Under 4.5 | BTTS Sim | BTTS Não
 *
 * Critérios (25 itens, pesos distribuídos em 100 pts):
 *   1.  Média total de gols               — 15 pts
 *   2.  Gols marcados                     — 12 pts
 *   3.  Gols sofridos                     — 12 pts
 *   4.  Frequência Over últimos 10 jogos  — 12 pts
 *   5.  Frequência Over últimos 5 jogos   — 10 pts
 *   6.  Força ofensiva                    — 10 pts
 *   7.  Fragilidade defensiva adversária  — 10 pts
 *   8.  Contexto grupo/fase               —  8 pts
 *   9.  Necessidade de saldo de gols      —  6 pts
 *  10.  BTTS/Tendência ofensiva           —  5 pts
 *  11.  Ranking FIFA/Diferença técnica    —  4 pts
 *  12.  EV                                —  4 pts
 *  13.  Odds (validação)                  —  2 pts
 *  Total: 100 pts
 *
 * Saída: objeto com previsão para TODOS os mercados.
 * Nunca retorna null — retorna grade 'D' quando dados insuficientes.
 *
 * Usado por: generate_predictions.js → grava em wc_gols_snapshots
 */

'use strict';

const { getTeamPower }                           = require('../data/wc_team_power.js');
const { getFifaRank, calculateFifaRankingScore } = require('../data/wc_fifa_ranking.js');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

const MARKETS = ['over05ht', 'over15', 'over25', 'under35', 'under45', 'btts', 'nobtts'];

const MARKET_LABELS = {
  over05ht: 'Over 0.5 HT',
  over15:   'Over 1.5',
  over25:   'Over 2.5',
  under35:  'Under 3.5',
  under45:  'Under 4.5',
  btts:     'BTTS Sim',
  nobtts:   'BTTS Não',
};

// Odd mínima por mercado
const MIN_ODD = {
  over05ht: 1.25,
  over15:   1.20,
  over25:   1.50,
  under35:  1.25,
  under45:  1.10,
  btts:     1.60,
  nobtts:   1.50,
};

// Probabilidade mínima para recomendar (não bloqueia exibição — só confiança)
const MIN_PROB = {
  over05ht: 75,
  over15:   75,
  over25:   65,
  under35:  70,
  under45:  80,
  btts:     65,
  nobtts:   65,
};

// Thresholds de confiança por mercado
const CONFIDENCE_THRESHOLDS = {
  over05ht: { elite: 90, alta: 80, moderada: 70 },
  over15:   { elite: 85, alta: 75, moderada: 65 },
  over25:   { elite: 80, alta: 70, moderada: 60 },
  under35:  { elite: 85, alta: 75, moderada: 70 },
  under45:  { elite: 90, alta: 82, moderada: 75 },
  btts:     { elite: 80, alta: 72, moderada: 65 },
  nobtts:   { elite: 80, alta: 72, moderada: 65 },
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, min = 0, max = 100) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.max(min, Math.min(max, v));
}

function norm(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/**
 * Parseia string de forma (ex: "WWDLW") e retorna array de chars válidos.
 */
function parseForm(formString, n = 10) {
  if (!formString || typeof formString !== 'string') return [];
  return formString.toUpperCase().split('').filter(c => ['W', 'D', 'L'].includes(c)).slice(-n);
}

/**
 * Calcula pontos por jogo a partir de array de forma.
 */
function formToPpg(chars) {
  if (!chars.length) return null;
  const pts = chars.reduce((s, c) => s + (c === 'W' ? 3 : c === 'D' ? 1 : 0), 0);
  return pts / chars.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCORES (0-100 cada)
// ─────────────────────────────────────────────────────────────────────────────

/** 1. Média total de gols combinada — 15 pts */
function scoreAvgTotal(avgH, avgA) {
  if (avgH === null || avgA === null) return null;
  const avg = avgH + avgA;
  // Escala: 0 gols = 0, 4+ gols = 100
  return clamp((avg / 4.0) * 100);
}

/** 2. Gols marcados (combinado) — 12 pts */
function scoreGolsMarcados(avgScH, avgScA) {
  if (avgScH === null || avgScA === null) return null;
  const avg = (avgScH + avgScA) / 2;
  return clamp((avg / 2.0) * 100);
}

/** 3. Gols sofridos (combinado, maior = mais gols no jogo) — 12 pts */
function scoreGolsSofridos(avgConcH, avgConcA) {
  if (avgConcH === null || avgConcA === null) return null;
  const avg = (avgConcH + avgConcA) / 2;
  return clamp((avg / 2.0) * 100);
}

/** 4. Frequência Over últimos 10 jogos — 12 pts */
function scoreFreqOver10(freqHome10, freqAway10) {
  if (freqHome10 === null && freqAway10 === null) return null;
  const vals = [freqHome10, freqAway10].filter(v => v !== null);
  return clamp(vals.reduce((s, v) => s + v, 0) / vals.length);
}

/** 5. Frequência Over últimos 5 jogos — 10 pts */
function scoreFreqOver5(freqHome5, freqAway5) {
  if (freqHome5 === null && freqAway5 === null) return null;
  const vals = [freqHome5, freqAway5].filter(v => v !== null);
  return clamp(vals.reduce((s, v) => s + v, 0) / vals.length);
}

/** 6. Força ofensiva (PPG ofensivo) — 10 pts */
function scoreOfensivo(ppgH, ppgA) {
  if (ppgH === null && ppgA === null) return null;
  const vals = [ppgH, ppgA].filter(v => v !== null);
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  return clamp((avg / 3.0) * 100);
}

/** 7. Fragilidade defensiva adversária — 10 pts */
function scoreFragilidade(avgConcH, avgConcA) {
  // Reutiliza gols sofridos — alta concessão = maior fragilidade = mais gols
  return scoreGolsSofridos(avgConcH, avgConcA);
}

/** 8. Contexto grupo/fase — 8 pts */
function scoreContextoGols(ctxHome, ctxAway) {
  // Contexto favorece gols quando: algum time precisa vencer ou tem necessidade de placar
  let score = 50;
  if (ctxHome?.needsWin || ctxAway?.needsWin)           score += 25;
  if (ctxHome?.goaldiffNeeded || ctxAway?.goaldiffNeeded) score += 15;
  if (ctxHome?.alreadyQualifiedNoStakes && ctxAway?.alreadyQualifiedNoStakes) score -= 20;
  if (ctxHome?.friendly || ctxAway?.friendly)            score -= 30;
  return clamp(score);
}

/** 9. Necessidade de saldo de gols — 6 pts */
function scoreNecessidadeSaldo(ctxHome, ctxAway) {
  if (ctxHome?.goaldiffNeeded || ctxAway?.goaldiffNeeded) return 90;
  if (ctxHome?.needsWin || ctxAway?.needsWin)             return 65;
  return 35;
}

/** 10. BTTS/Tendência ofensiva — 5 pts */
function scoreBttsTendencia(bttsRateH, bttsRateA) {
  if (bttsRateH === null && bttsRateA === null) return null;
  const vals = [bttsRateH, bttsRateA].filter(v => v !== null);
  return clamp(vals.reduce((s, v) => s + v, 0) / vals.length);
}

/** 11. Ranking FIFA / Diferença técnica — 4 pts */
function scoreRankingDiff(rankH, rankA, powerH, powerA) {
  const rankScore = calculateFifaRankingScore(rankH, rankA);
  // Diferença técnica: quanto maior a diferença, mais gols (favorito goleia)
  let techDiff = 50;
  if (powerH.marketValueM && powerA.marketValueM) {
    const ratio = Math.max(powerH.marketValueM, powerA.marketValueM) /
                  Math.min(powerH.marketValueM, powerA.marketValueM);
    techDiff = clamp(50 + (ratio - 1) * 20);
  }
  return clamp((rankScore + techDiff) / 2);
}

/** 12+13. EV e Odds — calculados separadamente por mercado */
function scoreEv(prob, odd) {
  if (prob === null || odd === null || odd <= 1) return null;
  const ev = (prob / 100) * odd;
  // EV >= 1.05 = score alto; abaixo = penalidade
  if (ev >= 1.20) return 100;
  if (ev >= 1.10) return 80;
  if (ev >= 1.05) return 60;
  if (ev >= 1.00) return 30;
  return 0;
}

function scoreOddValidation(odd, minOdd) {
  if (odd === null || odd <= 1) return null;
  if (odd < minOdd) return 0; // abaixo do mínimo = inválida
  return clamp((odd / (minOdd * 1.5)) * 70); // normaliza razoavelmente
}

// ─────────────────────────────────────────────────────────────────────────────
// PROBABILIDADE POR MERCADO
// Com base nos subscores + dados brutos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converte score 0-100 em probabilidade 0-100 para cada mercado,
 * usando a direção correta (over vs under).
 */
function scoreToProbability(score, market, raw) {
  if (score === null) return 50; // neutro quando sem dados

  // Dados brutos da API quando disponíveis
  const apiProb = getApiProbability(market, raw);

  // Mistura: 60% motor, 40% API (quando disponível)
  if (apiProb !== null) {
    return Math.round(score * 0.6 + apiProb * 0.4);
  }

  return Math.round(score);
}

/**
 * Extrai probabilidade direta da API-Football para cada mercado.
 */
function getApiProbability(market, raw) {
  switch (market) {
    case 'over05ht': return clamp(num(raw?.over05_ht) * 100);
    case 'over15':   return clamp(num(raw?.over15_g)  * 100) ?? clamp(num(raw?.prob_over15));
    case 'over25':   return clamp(num(raw?.over25_g)  * 100) ?? clamp(num(raw?.prob_over25));
    case 'under35':  {
      const o35 = num(raw?.over35_g);
      return o35 !== null ? clamp((1 - o35) * 100) : null;
    }
    case 'under45':  {
      const o45 = num(raw?.over45_g);
      return o45 !== null ? clamp((1 - o45) * 100) : null;
    }
    case 'btts':   return clamp(num(raw?.btts_pct));
    case 'nobtts': {
      const btts = num(raw?.btts_pct);
      return btts !== null ? clamp(100 - btts) : null;
    }
    default: return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGREGAÇÃO POR MERCADO
// Cada mercado tem seu próprio perfil de subscores relevantes
// ─────────────────────────────────────────────────────────────────────────────

const WEIGHTS = {
  avgTotal:      15,
  golsMarcados:  12,
  golsSofridos:  12,
  freqOver10:    12,
  freqOver5:     10,
  ofensivo:      10,
  fragilidade:   10,
  contexto:       8,
  necessidade:    6,
  btts:           5,
  ranking:        4,
  ev:             4,
  odd:            2,
};

function aggregateScore(subscores) {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const s = subscores[key];
    if (s !== null && s !== undefined && !Number.isNaN(s)) {
      weightedSum += s * weight;
      totalWeight += weight;
    }
  }
  if (totalWeight < 20) return null; // dados insuficientes
  return clamp(weightedSum / totalWeight);
}

/**
 * Ajusta o score base para cada mercado específico.
 * Over e Under têm perspectivas opostas sobre os mesmos dados.
 */
function adjustScoreForMarket(baseScore, market, raw, ctxHome, ctxAway) {
  if (baseScore === null) return null;

  const avgTotal = (num(raw?.avg_sc_h) || 0) + (num(raw?.avg_sc_a) || 0);
  const needsGoals = ctxHome?.needsWin || ctxAway?.needsWin ||
                     ctxHome?.goaldiffNeeded || ctxAway?.goaldiffNeeded;

  switch (market) {
    case 'over05ht':
      // Requer gol no primeiro tempo — usa freqência específica
      return clamp(baseScore * 0.85 + (num(raw?.over05_ht) !== null ? num(raw?.over05_ht) * 100 * 0.15 : 0));

    case 'over15':
      // Score base direto
      return baseScore;

    case 'over25':
      // Mais exigente — penaliza se média baixa
      if (avgTotal < 2.0) return clamp(baseScore * 0.80);
      if (avgTotal >= 3.0) return clamp(baseScore * 1.10);
      return baseScore;

    case 'under35':
      // Inverso dos gols — alta média de gols = baixo score Under
      return clamp(100 - baseScore + (needsGoals ? -10 : 10));

    case 'under45':
      // Mais fácil de acertar — score geralmente alto
      return clamp(100 - (baseScore * 0.6) + 40);

    case 'btts':
      // Requer que ambos marquem — usa taxa BTTS diretamente
      {
        const bttsRate = num(raw?.btts_pct) ?? num(raw?.btts_h) ?? num(raw?.btts_a);
        if (bttsRate !== null) return clamp(baseScore * 0.6 + bttsRate * 100 * 0.4);
        return clamp(baseScore * 0.85);
      }

    case 'nobtts':
      // Inverso do BTTS
      {
        const bttsRate = num(raw?.btts_pct) ?? num(raw?.btts_h) ?? num(raw?.btts_a);
        if (bttsRate !== null) return clamp((1 - bttsRate) * 100 * 0.5 + (100 - baseScore) * 0.5);
        return clamp(100 - baseScore * 0.85);
      }

    default:
      return baseScore;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIANÇA
// ─────────────────────────────────────────────────────────────────────────────

function getConfidence(prob, market) {
  const t = CONFIDENCE_THRESHOLDS[market] || { elite: 85, alta: 75, moderada: 65 };
  if (prob >= t.elite)    return { confidence: 'Elite',     grade: 'A+' };
  if (prob >= t.alta)     return { confidence: 'Alta',      grade: 'A'  };
  if (prob >= t.moderada) return { confidence: 'Moderada',  grade: 'B'  };
  return                         { confidence: 'Arriscado', grade: 'C'  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FREQUÊNCIAS A PARTIR DE STRING DE FORMA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calcula frequência de "gol marcado" a partir de string de forma.
 * W = marcou, L = pode ter marcado ou não — como proxy conservador,
 * conta W como "provavelmente marcou".
 */
function formToScoredFreq(formString, n) {
  const chars = parseForm(formString, n);
  if (!chars.length) return null;
  const scored = chars.filter(c => c === 'W').length;
  return clamp((scored / chars.length) * 100);
}

/**
 * Frequência Over dos últimos N jogos usando média de gols disponível.
 * Proxy: se PPG alto = frequência Over alta.
 */
function estimateOverFreq(ppg, avgGoals, n) {
  if (ppg === null && avgGoals === null) return null;
  // Usa média de gols como proxy para Over 1.5
  const g = avgGoals ?? (ppg ? ppg * 1.2 : null);
  if (g === null) return null;
  // Poisson aproximado: P(X >= 2) = 1 - P(X=0) - P(X=1)
  const lambda = g;
  const p0 = Math.exp(-lambda);
  const p1 = lambda * Math.exp(-lambda);
  return clamp((1 - p0 - p1) * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {object} input.raw              — objeto mapeado pelo PackBallMapper
 * @param {string} [input.homeFormString] — string de forma bruta (ex: "WWDLW")
 * @param {string} [input.awayFormString]
 * @param {Array}  [input.h2hGames]       — lista de jogos H2H da API
 * @param {object} [input.manualContext]  — wc_manual_context.json.teams
 * @param {object} [input.odds]           — { over15, over25, btts, under35, under45, over05ht, nobtts }
 *
 * @returns {object} — previsão para todos os mercados de gols
 */
function computeWcGols(input = {}) {
  const {
    raw = {},
    homeFormString = null,
    awayFormString = null,
    h2hGames = [],
    manualContext = {},
    odds = {},
  } = input;

  const homeTeam = raw?.home_team || '';
  const awayTeam = raw?.away_team || '';

  const powerHome = getTeamPower(homeTeam);
  const powerAway = getTeamPower(awayTeam);
  const rankHome  = getFifaRank(homeTeam);
  const rankAway  = getFifaRank(awayTeam);

  const ctxHome = manualContext[homeTeam] || {};
  const ctxAway = manualContext[awayTeam] || {};

  // ── Dados brutos ───────────────────────────────────────────────────────────
  const avgScH    = num(raw?.avg_sc_h);          // média gols marcados home
  const avgScA    = num(raw?.avg_sc_a);          // média gols marcados away
  const avgConcH  = num(raw?.home_avg_conc_home) ?? num(raw?.avg_conc_h);
  const avgConcA  = num(raw?.away_avg_conc_away) ?? num(raw?.avg_conc_a);
  const ppgH      = num(raw?.ppg_h);
  const ppgA      = num(raw?.ppg_a);
  const bttsH     = num(raw?.btts_h);   // frequência BTTS home (0-1)
  const bttsA     = num(raw?.btts_a);   // frequência BTTS away (0-1)
  const bttsPct   = num(raw?.btts_pct); // frequência BTTS combinada (0-1)

  // Frequências Over a partir de dados disponíveis
  const avgTotalGoals = (avgScH ?? 0) + (avgScA ?? 0);
  const freqH10 = estimateOverFreq(ppgH, avgScH, 10);
  const freqA10 = estimateOverFreq(ppgA, avgScA, 10);
  const freqH5  = formToScoredFreq(homeFormString, 5);
  const freqA5  = formToScoredFreq(awayFormString, 5);

  // H2H — média de gols
  let h2hAvgGoals = null;
  if (h2hGames?.length >= 3) {
    const totals = h2hGames.slice(-10)
      .map(g => (num(g?.goals?.home) ?? 0) + (num(g?.goals?.away) ?? 0))
      .filter(v => v >= 0);
    if (totals.length) h2hAvgGoals = totals.reduce((s, v) => s + v, 0) / totals.length;
  }

  // ── Subscores base (mesmos para todos os mercados) ─────────────────────────
  const baseSubs = {
    avgTotal:     scoreAvgTotal(avgScH, avgScA),
    golsMarcados: scoreGolsMarcados(avgScH, avgScA),
    golsSofridos: scoreGolsSofridos(avgConcH, avgConcA),
    freqOver10:   scoreFreqOver10(freqH10, freqA10),
    freqOver5:    scoreFreqOver5(freqH5, freqA5),
    ofensivo:     scoreOfensivo(ppgH, ppgA),
    fragilidade:  scoreFragilidade(avgConcH, avgConcA),
    contexto:     scoreContextoGols(ctxHome, ctxAway),
    necessidade:  scoreNecessidadeSaldo(ctxHome, ctxAway),
    btts:         scoreBttsTendencia(
                    bttsH !== null ? bttsH * 100 : null,
                    bttsA !== null ? bttsA * 100 : null
                  ) ?? (bttsPct !== null ? bttsPct * 100 : null),
    ranking:      scoreRankingDiff(rankHome, rankAway, powerHome, powerAway),
    ev:           null, // calculado por mercado
    odd:          null, // calculado por mercado
  };

  const baseScore = aggregateScore(baseSubs);

  // ── Calcular previsão para cada mercado ────────────────────────────────────
  const results = {};

  for (const market of MARKETS) {
    const odd = odds[market] ?? null;

    // Score ajustado para este mercado
    const adjustedScore = adjustScoreForMarket(baseScore, market, raw, ctxHome, ctxAway);

    // EV e odd como subscores adicionais
    const evScore  = scoreEv(adjustedScore, odd);
    const oddScore = scoreOddValidation(odd, MIN_ODD[market]);

    // Score final com EV e odd
    let finalScore = adjustedScore;
    if (evScore !== null)  finalScore = finalScore * 0.94 + evScore  * 0.04;
    if (oddScore !== null) finalScore = finalScore * 0.98 + oddScore * 0.02;
    finalScore = clamp(finalScore);

    // Probabilidade
    const prob = finalScore !== null
      ? scoreToProbability(finalScore, market, raw)
      : 50;

    // EV calculado
    const ev = odd !== null && odd > 1 ? Math.round((prob / 100) * odd * 100) / 100 : null;

    // Confiança
    const { confidence, grade } = getConfidence(prob, market);

    // Flag de qualidade
    const meetsMinProb = prob >= MIN_PROB[market];
    const meetsMinOdd  = odd === null || odd >= MIN_ODD[market];
    const meetsEv      = ev === null  || ev  >= 1.05;
    const recommended  = meetsMinProb && meetsMinOdd && meetsEv;

    results[market] = {
      market:      MARKET_LABELS[market],
      marketKey:   market,
      probability: prob,
      odd:         odd,
      ev:          ev,
      score:       Math.round(finalScore ?? 0),
      confidence,
      grade,
      recommended,
      meetsMinProb,
      meetsMinOdd,
      meetsEv,
    };
  }

  // ── Melhor mercado do dia ──────────────────────────────────────────────────
  // Prioriza recomendados com maior EV, depois maior probabilidade
  const recommended = MARKETS
    .map(m => results[m])
    .filter(r => r.recommended)
    .sort((a, b) => {
      const evDiff = (b.ev ?? 0) - (a.ev ?? 0);
      if (Math.abs(evDiff) > 0.05) return evDiff;
      return b.probability - a.probability;
    });

  const bestMarket = recommended[0] ?? null;

  return {
    homeTeam,
    awayTeam,
    markets:    results,
    bestMarket: bestMarket?.marketKey ?? null,
    bestLabel:  bestMarket?.market    ?? null,
    // Dados de contexto para debug/log
    _debug: {
      avgTotalGoals,
      h2hAvgGoals,
      baseScore: Math.round(baseScore ?? 0),
      freqH10: Math.round(freqH10 ?? 0),
      freqA10: Math.round(freqA10 ?? 0),
    },
  };
}

module.exports = { computeWcGols, MARKETS, MARKET_LABELS };
