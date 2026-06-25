/**
 * WinMetrics V3 — Motor WC Cartões (Copa do Mundo 2026)
 * ─────────────────────────────────────────────────────────────────────────────
 * Calcula previsões de mercados de cartões EXCLUSIVAMENTE para jogos da Copa
 * do Mundo. Segue o mesmo padrão de wc_gols_engine.js e
 * wc_escanteios_engine.js — roda para TODOS os jogos do dia (agendados, ao
 * vivo e finalizados) sem exceção.
 *
 * Mercados:
 *   Over 2.5 Cartões | Over 3.5 Cartões | Over 4.5 Cartões
 *   Under 5.5 Cartões | Under 6.5 Cartões
 *
 * Critérios (score base 0-100, 100 pts total):
 *   1.  Média total de cartões               — 15 pts
 *   2.  Cartões recebidos pelas equipes      — 12 pts
 *   3.  Cartões provocados (sofridos)        — 10 pts
 *   4.  Faltas cometidas                     — 10 pts
 *   5.  Faltas sofridas                      —  8 pts
 *   6.  Árbitro / média de cartões           — 15 pts
 *   7.  Contexto grupo/fase                  —  8 pts
 *   8.  Necessidade de vitória               —  6 pts
 *   9.  Risco de eliminação/classificação    —  6 pts
 *  10.  Estilo físico das seleções           —  5 pts
 *  11.  Histórico H2H                        —  3 pts
 *  12.  Odd como validação                   —  2 pts
 *  Total: 100 pts
 *
 * Ajuste ao vivo:
 *   Quando o jogo está em andamento, as probabilidades são recalculadas
 *   considerando: minuto, placar, cartões já aplicados, faltas acumuladas,
 *   presença de vermelho e necessidade de resultado.
 *
 * Usado por: generate_predictions.js → grava em wc_cartoes_snapshots
 */

'use strict';

const { getTeamPower }                           = require('../data/wc_team_power.js');
const { getFifaRank, calculateFifaRankingScore } = require('../data/wc_fifa_ranking.js');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

const MARKETS = ['over25', 'over35', 'over45', 'under55', 'under65'];

const MARKET_LABELS = {
  over25:   'Over 2.5 Cartões',
  over35:   'Over 3.5 Cartões',
  over45:   'Over 4.5 Cartões',
  under55:  'Under 5.5 Cartões',
  under65:  'Under 6.5 Cartões',
};

// Odd mínima por mercado
const MIN_ODD = {
  over25:  1.25,
  over35:  1.45,
  over45:  1.70,
  under55: 1.35,
  under65: 1.25,
};

// Probabilidade mínima para recomendar
const MIN_PROB = {
  over25:  75,
  over35:  70,
  over45:  65,
  under55: 70,
  under65: 75,
};

// Thresholds de confiança (uniformes para todos os mercados de cartões)
const CONFIDENCE_THRESHOLDS = {
  elite:    85,
  alta:     75,
  moderada: 65,
};

// ─────────────────────────────────────────────────────────────────────────────
// ESTILOS FÍSICOS DAS SELEÇÕES — proxy para propensão a faltas e cartões
// Escala 0-100: 100 = estilo muito físico/agressivo, 0 = técnico/suave
// ─────────────────────────────────────────────────────────────────────────────
const PHYSICAL_STYLE = {
  // Estilo muito físico
  'Panama':          90, 'Saudi Arabia':    85, 'Iran':            85,
  'IR Iran':         85, 'Senegal':         82, 'Morocco':         80,
  'Nigeria':         80, 'DR Congo':        80, 'Congo DR':        80,
  'Algeria':         78, 'Colombia':        78, 'Bolivia':         78,
  'Ecuador':         75, 'Honduras':        80, 'Costa Rica':      75,
  'Venezuela':       75, 'Tunisia':         75, 'South Africa':    75,
  'Haiti':           80, 'Cameroon':        80, 'New Zealand':     70,
  // Estilo equilibrado
  'Croatia':         72, 'Serbia':          72, 'Poland':          70,
  'Turkey':          68, 'Türkiye':         68, 'Ukraine':         65,
  'Mexico':          68, 'Uruguay':         72, 'Paraguay':        72,
  'Chile':           68, 'Peru':            65, 'Qatar':           60,
  'Uzbekistan':      60, 'Canada':          65, 'Australia':       65,
  'South Korea':     62, 'Korea Republic':  62, 'Japan':           60,
  'Ghana':           70, 'Egypt':           65, 'Ivory Coast':     70,
  "Côte d'Ivoire":   70,
  // Estilo técnico
  'Brazil':          58, 'Argentina':       60, 'France':          55,
  'Germany':         52, 'Spain':           48, 'England':         55,
  'Portugal':        52, 'Netherlands':     55, 'Italy':           55,
  'Belgium':         52, 'Switzerland':     50, 'Denmark':         50,
  'United States':   58, 'USA':             58,
};

function getPhysicalStyle(name) {
  const k = norm(name);
  for (const [n, s] of Object.entries(PHYSICAL_STYLE)) {
    if (norm(n) === k) return s;
  }
  return 62; // neutro quando desconhecido
}

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
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCORES (0-100 cada)
// ─────────────────────────────────────────────────────────────────────────────

/** 1. Média total de cartões combinada — 15 pts */
function scoreAvgTotal(avgCards) {
  if (avgCards === null) return null;
  // Escala: 0 cartões = 0, 6+ = 100
  return clamp((avgCards / 6.0) * 100);
}

/** 2. Cartões recebidos pelas equipes (frequência Over) — 12 pts */
function scoreCartoesRecebidos(over25, over35) {
  if (over25 === null && over35 === null) return null;
  // Usa Over 2.5 como referência primária (0-100 %)
  const base = over25 !== null ? over25 : (over35 !== null ? over35 * 1.2 : null);
  return clamp(base);
}

/** 3. Cartões provocados/sofridos — 10 pts */
function scoreCartoesSofridos(over35, over45) {
  if (over35 === null && over45 === null) return null;
  // Over 3.5 como proxy de intensidade de cartões sofridos
  const base = over35 !== null ? over35 : (over45 !== null ? over45 * 1.3 : null);
  return clamp(base);
}

/** 4. Faltas cometidas — 10 pts
 *  O pipeline não guarda fouls diretamente; usa avg_cards como proxy
 *  (mais cartões = mais faltas na origem) com escala ajustada.
 */
function scoreFaultsCometidas(avgCards) {
  if (avgCards === null) return null;
  // avg_cards alto é proxy de jogo com muitas faltas
  return clamp((avgCards / 5.0) * 100);
}

/** 5. Faltas sofridas — 8 pts (proxy inverso: time que sofre mais é mais tenso) */
function scoreFaultsSofridas(physicalHome, physicalAway) {
  // Quando os dois times têm estilo físico alto, mais faltas em geral
  const combined = (physicalHome + physicalAway) / 2;
  return clamp(combined);
}

/** 6. Árbitro — 15 pts
 *  Não temos dados de árbitro via API. Usamos avg_cards como proxy direto
 *  (se o histórico do jogo indica muitos cartões, o árbitro tende a ser rigoroso
 *  ou a partida é naturalmente quente). Quando manualContext trouxer
 *  refereAvgCards, usamos esse valor explícito.
 */
function scoreArbitro(avgCards, refereAvgCards) {
  // Prioriza dado manual do árbitro quando disponível
  const base = refereAvgCards !== null ? refereAvgCards : avgCards;
  if (base === null) return null;
  // Escala: árbitro que apita 4+ cartões/jogo = 100
  return clamp((base / 4.5) * 100);
}

/** 7. Contexto grupo/fase — 8 pts */
function scoreContexto(ctxHome, ctxAway) {
  let score = 45; // base neutra
  // Jogo decisivo aumenta tensão → mais cartões
  if (ctxHome?.needsWin || ctxAway?.needsWin)              score += 30;
  if (ctxHome?.goaldiffNeeded || ctxAway?.goaldiffNeeded)  score += 20;
  if (ctxHome?.eliminated || ctxAway?.eliminated)           score += 15; // desesperado
  // Jogo sem pressão reduz cartões
  if (ctxHome?.alreadyQualifiedNoStakes && ctxAway?.alreadyQualifiedNoStakes) score -= 25;
  if (ctxHome?.friendly || ctxAway?.friendly)               score -= 35;
  if (ctxHome?.rotationRisk || ctxAway?.rotationRisk)       score -= 10;
  return clamp(score);
}

/** 8. Necessidade de vitória — 6 pts */
function scoreNecessidadeVitoria(ctxHome, ctxAway) {
  if (ctxHome?.needsWin || ctxAway?.needsWin)   return 85;
  if (ctxHome?.eliminated || ctxAway?.eliminated) return 75;
  if (ctxHome?.alreadyQualifiedNoStakes && ctxAway?.alreadyQualifiedNoStakes) return 20;
  return 45;
}

/** 9. Risco de eliminação/classificação — 6 pts */
function scoreRiscoEliminacao(ctxHome, ctxAway) {
  // Mata-mata ou necessidade de classificação = muito mais tensão
  if (ctxHome?.eliminationGame || ctxAway?.eliminationGame) return 95;
  if (ctxHome?.needsWin || ctxAway?.needsWin)               return 75;
  if (ctxHome?.alreadyQualifiedNoStakes && ctxAway?.alreadyQualifiedNoStakes) return 15;
  return 50;
}

/** 10. Estilo físico combinado — 5 pts */
function scoreEstiloFisico(physicalHome, physicalAway) {
  return clamp((physicalHome + physicalAway) / 2);
}

/** 11. H2H — média de cartões em confrontos anteriores — 3 pts */
function scoreH2h(h2hGames) {
  if (!h2hGames?.length) return null;
  const last10 = h2hGames.slice(-10);
  // Usa cards_total quando disponível (enriquecido pelo pipeline)
  // Fallback: tenta statistics.cards
  const totals = last10
    .map(g => {
      const ct = num(g?.cards_total) ?? num(g?.statistics?.cards_total);
      if (ct !== null) return ct;
      // Fallback via statistics array
      if (Array.isArray(g?.statistics)) {
        let cards = 0;
        for (const team of g.statistics) {
          for (const item of (team?.statistics || [])) {
            const t = item?.type || '';
            const v = parseInt(item?.value) || 0;
            if (t === 'Yellow Cards' || t === 'Red Cards') cards += v;
          }
        }
        return cards > 0 ? cards : null;
      }
      return null;
    })
    .filter(v => v !== null && v >= 0);

  if (!totals.length) return null;
  const avgH2h = totals.reduce((s, v) => s + v, 0) / totals.length;
  return clamp((avgH2h / 6.0) * 100);
}

/** 12. Odd como validação — 2 pts */
function scoreOddValidation(odd, minOdd) {
  if (odd === null || odd <= 1) return null;
  if (odd < minOdd) return 0;
  return clamp((odd / (minOdd * 1.5)) * 70);
}

// ─────────────────────────────────────────────────────────────────────────────
// EV
// ─────────────────────────────────────────────────────────────────────────────

function scoreEv(prob, odd) {
  if (prob === null || odd === null || odd <= 1) return null;
  const ev = (prob / 100) * odd;
  if (ev >= 1.20) return 100;
  if (ev >= 1.10) return 80;
  if (ev >= 1.05) return 60;
  if (ev >= 1.00) return 30;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGREGAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

const WEIGHTS = {
  avgTotal:      15,
  recebidos:     12,
  sofridos:      10,
  faultsCom:     10,
  faultsSof:      8,
  arbitro:       15,
  contexto:       8,
  necessidade:    6,
  risco:          6,
  estilo:         5,
  h2h:            3,
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

// ─────────────────────────────────────────────────────────────────────────────
// AJUSTE POR MERCADO
// ─────────────────────────────────────────────────────────────────────────────

function adjustScoreForMarket(baseScore, market, avgCards, ctxHome, ctxAway, refereAvgCards) {
  if (baseScore === null) return null;

  const isDecisive = ctxHome?.needsWin || ctxAway?.needsWin ||
                     ctxHome?.eliminationGame || ctxAway?.eliminationGame ||
                     ctxHome?.goaldiffNeeded || ctxAway?.goaldiffNeeded;

  const refereeHigh = (refereAvgCards !== null && refereAvgCards >= 4.5) ||
                      (avgCards !== null && avgCards >= 4.0);

  switch (market) {
    case 'over25':
      // Mercado mais seguro — boost leve
      return clamp(baseScore * 1.08);

    case 'over35':
      // Score base direto
      return baseScore;

    case 'over45':
      // Mais exigente: penaliza se média baixa, bônus se árbitro rígido ou jogo decisivo
      {
        let adj = baseScore;
        if (avgCards !== null && avgCards < 4.5) adj *= 0.82;
        if (refereeHigh) adj = Math.min(adj * 1.10, 100);
        if (isDecisive)  adj = Math.min(adj * 1.08, 100);
        return clamp(adj);
      }

    case 'under55':
      // Inverso do base + bônus árbitro suave ou jogo sem pressão
      {
        const noStakes = ctxHome?.alreadyQualifiedNoStakes && ctxAway?.alreadyQualifiedNoStakes;
        let adj = 100 - baseScore * 0.65;
        if (!refereeHigh) adj = Math.min(adj + 10, 100);
        if (noStakes)     adj = Math.min(adj + 12, 100);
        if (isDecisive)   adj = Math.max(adj - 15, 0);
        return clamp(adj);
      }

    case 'under65':
      // Inversão mais suave — mercado mais conservador
      {
        const noStakes = ctxHome?.alreadyQualifiedNoStakes && ctxAway?.alreadyQualifiedNoStakes;
        let adj = 100 - baseScore * 0.55;
        if (!refereeHigh) adj = Math.min(adj + 8, 100);
        if (noStakes)     adj = Math.min(adj + 10, 100);
        if (isDecisive)   adj = Math.max(adj - 10, 0);
        return clamp(adj);
      }

    default:
      return baseScore;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROBABILIDADE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Usa Poisson quando avg_cards está disponível.
 * Mistura 50% Poisson + 50% score do motor — mesmo padrão do escanteios.
 */
function scoreToProbability(score, market, avgCards) {
  if (score === null) return 50;

  if (avgCards !== null && avgCards > 0) {
    let poissonProb = null;
    switch (market) {
      case 'over25':  poissonProb = poissonOver(avgCards, 2);  break;
      case 'over35':  poissonProb = poissonOver(avgCards, 3);  break;
      case 'over45':  poissonProb = poissonOver(avgCards, 4);  break;
      case 'under55': poissonProb = poissonUnder(avgCards, 5); break;
      case 'under65': poissonProb = poissonUnder(avgCards, 6); break;
    }
    if (poissonProb !== null) {
      return Math.round(poissonProb * 0.5 + score * 0.5);
    }
  }

  return Math.round(score);
}

function poissonOver(lambda, threshold) {
  // P(X > threshold) = 1 - P(X <= threshold)
  let probUnder = 0;
  for (let k = 0; k <= threshold; k++) {
    probUnder += (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
  }
  return clamp((1 - probUnder) * 100);
}

function poissonUnder(lambda, threshold) {
  // P(X <= threshold)
  let prob = 0;
  for (let k = 0; k <= threshold; k++) {
    prob += (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
  }
  return clamp(prob * 100);
}

function factorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// AJUSTE AO VIVO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recalcula probabilidades quando o jogo está em andamento.
 * Recebe o estado atual e os ajusta em cima da probabilidade pré-jogo.
 *
 * @param {number} prob            — probabilidade pré-jogo (0-100)
 * @param {string} market          — chave do mercado
 * @param {object} liveState       — { minute, cardsApplied, foulsCommitted, redCards, status }
 * @param {object} ctxHome         — contexto do time da casa
 * @param {object} ctxAway         — contexto do visitante
 * @returns {number}               — probabilidade ajustada
 */
function adjustProbLive(prob, market, liveState, ctxHome, ctxAway) {
  if (!liveState || liveState.status !== 'LIVE') return prob;

  const { minute = 0, cardsApplied = 0, foulsCommitted = 0, redCards = 0 } = liveState;
  const timeRemaining = Math.max(0, 90 - minute);
  const timeRatio     = timeRemaining / 90; // 1 = início, 0 = fim

  const isDecisive = ctxHome?.needsWin || ctxAway?.needsWin ||
                     ctxHome?.eliminationGame || ctxAway?.eliminationGame;

  let adj = prob;

  // Cartões já aplicados em relação ao esperado
  const expectedByNow = prob / 100 * (minute / 90);
  const cardsAheadOfPace = cardsApplied > expectedByNow * (prob / 100 * 4); // > esperado

  // Over markets: mais cartões já = mais provável de bater o over
  if (['over25', 'over35', 'over45'].includes(market)) {
    // Cada cartão já aplicado aumenta a probabilidade (já andou no caminho)
    adj += cardsApplied * 4;
    // Muitas faltas = sinal de jogo agitado
    if (foulsCommitted > 20) adj += 8;
    if (foulsCommitted > 30) adj += 12;
    // Vermelho = 10 contra 11, mais desesperança = mais faltas
    adj += redCards * 10;
    // Pouco tempo restante com poucos cartões = raro ainda bater over alto
    if (timeRemaining < 20 && cardsApplied === 0 && market === 'over45') adj -= 30;
    if (timeRemaining < 15 && cardsApplied <= 1 && market === 'over35') adj -= 20;
    // Jogo decisivo no 2º tempo aumenta tensão
    if (minute >= 60 && isDecisive) adj += 10;
  }

  // Under markets: mais cartões já = menos provável de ficar abaixo
  if (['under55', 'under65'].includes(market)) {
    // Cada cartão reduz a probabilidade de Under
    adj -= cardsApplied * 5;
    // Muitas faltas = mais provável que mais cartões venham
    if (foulsCommitted > 20) adj -= 8;
    if (foulsCommitted > 30) adj -= 15;
    adj -= redCards * 8;
    // Pouco tempo e poucos cartões = Under é mais seguro
    if (timeRemaining < 20 && cardsApplied <= 2) adj += 15;
    if (timeRemaining < 10 && cardsApplied <= 3) adj += 20;
  }

  return clamp(adj);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIANÇA
// ─────────────────────────────────────────────────────────────────────────────

function getConfidence(prob) {
  if (prob >= CONFIDENCE_THRESHOLDS.elite)    return { confidence: 'Elite',     grade: 'A+' };
  if (prob >= CONFIDENCE_THRESHOLDS.alta)     return { confidence: 'Alta',      grade: 'A'  };
  if (prob >= CONFIDENCE_THRESHOLDS.moderada) return { confidence: 'Moderada',  grade: 'B'  };
  return                                             { confidence: 'Arriscado', grade: 'C'  };
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
 * @param {object} [input.odds]           — { over25, over35, over45, under55, under65 }
 * @param {object} [input.liveState]      — estado ao vivo { minute, cardsApplied,
 *                                          foulsCommitted, redCards, status }
 *
 * @returns {object} — previsão para todos os mercados de cartões
 */
function computeWcCartoes(input = {}) {
  const {
    raw = {},
    homeFormString = null,
    awayFormString = null,
    h2hGames = [],
    manualContext = {},
    odds = {},
    liveState = null,
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
  const avgCards    = num(raw?.avg_cards);         // média combinada de cartões
  const over25cards = num(raw?.over25_cards);      // % jogos com Over 2.5 (0-100)
  const over35cards = num(raw?.over35_cards);      // % jogos com Over 3.5 (0-100)
  const over45cards = num(raw?.over45_cards);      // % jogos com Over 4.5 (0-100)

  // Árbitro: usa campo manual quando disponível, senão proxy via avg_cards
  const refereAvgCards = num(ctxHome?.refereAvgCards) ?? num(ctxAway?.refereAvgCards) ?? null;

  // Estilos físicos
  const physicalHome = getPhysicalStyle(homeTeam);
  const physicalAway = getPhysicalStyle(awayTeam);

  // ── Subscores base ─────────────────────────────────────────────────────────
  const baseSubs = {
    avgTotal:    scoreAvgTotal(avgCards),
    recebidos:   scoreCartoesRecebidos(over25cards, over35cards),
    sofridos:    scoreCartoesSofridos(over35cards, over45cards),
    faultsCom:   scoreFaultsCometidas(avgCards),
    faultsSof:   scoreFaultsSofridas(physicalHome, physicalAway),
    arbitro:     scoreArbitro(avgCards, refereAvgCards),
    contexto:    scoreContexto(ctxHome, ctxAway),
    necessidade: scoreNecessidadeVitoria(ctxHome, ctxAway),
    risco:       scoreRiscoEliminacao(ctxHome, ctxAway),
    estilo:      scoreEstiloFisico(physicalHome, physicalAway),
    h2h:         scoreH2h(h2hGames),
    odd:         null, // calculado por mercado
  };

  const baseScore = aggregateScore(baseSubs);

  // ── Calcular previsão para cada mercado ────────────────────────────────────
  const results = {};

  for (const market of MARKETS) {
    const odd = odds[market] ?? null;

    // Score ajustado para este mercado
    const adjustedScore = adjustScoreForMarket(
      baseScore, market, avgCards, ctxHome, ctxAway, refereAvgCards
    );

    // Odd como subscore adicional
    const oddScore = scoreOddValidation(odd, MIN_ODD[market]);
    let finalScore = adjustedScore;
    if (oddScore !== null) finalScore = clamp(finalScore * 0.98 + oddScore * 0.02);

    // Probabilidade base via Poisson + score
    let prob = scoreToProbability(finalScore, market, avgCards);

    // Ajuste ao vivo quando aplicável
    prob = adjustProbLive(prob, market, liveState, ctxHome, ctxAway);

    // EV
    const ev = odd !== null && odd > 1
      ? Math.round((prob / 100) * odd * 100) / 100
      : null;

    // EV como subscore no score final (leve influência)
    const evScore = scoreEv(prob, odd);
    if (evScore !== null) finalScore = clamp(finalScore * 0.96 + evScore * 0.04);

    // Confiança
    const { confidence, grade } = getConfidence(prob);

    // Flags de qualidade
    const meetsMinProb = prob >= MIN_PROB[market];
    const meetsMinOdd  = odd === null || odd >= MIN_ODD[market];
    const meetsEv      = ev === null  || ev  >= 1.05;
    const recommended  = meetsMinProb && meetsMinOdd && meetsEv;

    results[market] = {
      market:       MARKET_LABELS[market],
      marketKey:    market,
      probability:  prob,
      odd,
      ev,
      score:        Math.round(clamp(finalScore) ?? 0),
      confidence,
      grade,
      recommended,
      meetsMinProb,
      meetsMinOdd,
      meetsEv,
      // Dados ao vivo passados para o frontend
      liveCardsApplied: liveState?.cardsApplied ?? null,
      liveMinute:       liveState?.minute        ?? null,
    };
  }

  // ── Melhor mercado: recomendado com maior EV, depois maior probabilidade ───
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
    _debug: {
      avgCards,
      refereAvgCards,
      physicalHome,
      physicalAway,
      baseScore: Math.round(baseScore ?? 0),
    },
  };
}

module.exports = { computeWcCartoes, MARKETS, MARKET_LABELS };
