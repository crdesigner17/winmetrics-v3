/**
 * WinMetrics V3 — Motor WC Vencer (Spec Completo)
 * ─────────────────────────────────────────────────────────────────
 * Calcula palpite de vitória para TODOS os jogos da Copa do Mundo.
 * Diferente do wc_resultado_final.js (que só aprova jogos com sinal
 * forte), este motor SEMPRE retorna um palpite — inclusive "Evitar 1X2"
 * quando o jogo é equilibrado.
 *
 * Critérios (spec Carlos):
 *   1. Ranking FIFA               — 15 pts
 *   2. Força técnica/elenco       — 15 pts
 *   3. Forma últimos 5 jogos      — 12 pts
 *   4. Forma últimos 10 jogos     — 10 pts
 *   5. PPG                        — 10 pts
 *   6. Ataque (gols marcados)     — 10 pts
 *   7. Defesa (gols sofridos)     — 10 pts
 *   8. Contexto grupo/fase        —  8 pts
 *   9. Tradição em Copa           —  5 pts
 *  10. H2H                        —  3 pts
 *  11. Odd/mercado (validação)    —  2 pts
 *  Total: 100 pts
 *
 * Saída: SEMPRE retorna objeto com pick, probability, confidence, grade.
 * Nunca retorna null.
 *
 * Usado por: generate_predictions.js → grava em wc_vencer_snapshots
 */

'use strict';

const { getTeamPower }                          = require('../data/wc_team_power.js');
const { getFifaRank, calculateFifaRankingScore } = require('../data/wc_fifa_ranking.js');

// ─────────────────────────────────────────────────────────────────
// TRADIÇÃO EM COPA — histórico de títulos/semifinais como proxy
// ─────────────────────────────────────────────────────────────────
const WC_TRADITION = {
  'Brazil':100,'Germany':95,'Italy':95,'France':90,'Argentina':95,
  'Spain':80,'England':70,'Netherlands':75,'Croatia':70,'Portugal':65,
  'Uruguay':80,'Belgium':55,'Mexico':60,'United States':50,'USA':50,
  'Switzerland':50,'Morocco':55,'Japan':50,'South Korea':45,'Korea Republic':45,
  'Australia':40,'Senegal':40,'Colombia':45,'Ecuador':35,'Canada':30,
  'Norway':35,'Sweden':60,'Scotland':30,'Czechia':35,'Paraguay':45,
  'Tunisia':35,'Ghana':40,'Algeria':35,'Egypt':35,'Ivory Coast':35,
  "Côte d'Ivoire":35,'Saudi Arabia':30,'Iran':30,'IR Iran':30,
  'Türkiye':45,'Turkey':45,'Austria':40,'Uzbekistan':15,'Qatar':20,
  'Iraq':20,'South Africa':30,'Jordan':15,'Bosnia and Herzegovina':20,
  'Cape Verde':15,'Cabo Verde':15,'Curaçao':10,'Curacao':10,
  'Haiti':20,'New Zealand':20,'Panama':20,'DR Congo':25,'Congo DR':25,
};

function norm(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

function getTradition(name) {
  const k = norm(name);
  for (const [n, s] of Object.entries(WC_TRADITION)) {
    if (norm(n) === k) return s;
  }
  return 30;
}

function clamp(v, min = 0, max = 100) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.max(min, Math.min(max, v));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────────
// SUBSCORES (0-100 cada, favorável ao lado sendo avaliado)
// ─────────────────────────────────────────────────────────────────

// 1. Ranking FIFA (15 pts)
function scoreFifa(rankThis, rankOther) {
  return calculateFifaRankingScore(rankThis, rankOther);
}

// 2. Força técnica/elenco (15 pts) — via marketValueM do wc_team_power
function scoreElenco(valThis, valOther) {
  if (!valThis || !valOther) return null;
  const ratio = valThis / valOther;
  if (ratio >= 2.0) return 100;
  if (ratio >= 1.5) return 80;
  if (ratio >= 1.2) return 65;
  if (ratio >= 1.0) return 55;
  if (ratio >= 0.8) return 40;
  return 25;
}

// 3. Forma últimos 5 jogos (12 pts)
function scoreForma5(formScore) {
  if (formScore === null) return null;
  // formScore é 0-100 da API (home_form_score / away_form_score)
  return clamp(formScore);
}

// 4. Forma últimos 10 jogos (10 pts) — usa string de forma da API
function scoreForma10(formString) {
  if (!formString || typeof formString !== 'string') return null;
  const chars = formString.toUpperCase().split('').filter(c => ['W','D','L'].includes(c));
  if (chars.length < 3) return null;
  const last10 = chars.slice(-10);
  const w = last10.filter(c => c === 'W').length;
  const d = last10.filter(c => c === 'D').length;
  const l = last10.filter(c => c === 'L').length;
  const pts = (w * 3 + d * 1) / (last10.length * 3) * 100;
  return clamp(pts);
}

// 5. PPG (10 pts)
function scorePpg(ppg) {
  if (ppg === null) return null;
  return clamp((ppg / 3) * 100);
}

// 6. Ataque (10 pts)
function scoreAtaque(avgGolsMarcados) {
  if (avgGolsMarcados === null) return null;
  return clamp((avgGolsMarcados / 2.5) * 100);
}

// 7. Defesa (10 pts) — menor gols sofridos = melhor
function scoreDefesa(avgGolsSofridos) {
  if (avgGolsSofridos === null) return null;
  // 0 gols sofridos = 100, 2+ gols sofridos = 0
  return clamp(100 - (avgGolsSofridos / 2.0) * 100);
}

// 8. Contexto grupo/fase (8 pts) — usa manualContext
function scoreContexto(ctx) {
  if (!ctx) return 50; // neutro quando sem dado
  if (ctx.needsWin) return 80;           // precisa vencer → motivação alta
  if (ctx.alreadyQualifiedNoStakes) return 20; // classificado sem necessidade
  if (ctx.friendly) return 10;
  if (ctx.rotationRisk) return 30;
  return 50;
}

// 9. Tradição Copa (5 pts)
function scoreTradition(nameThis, nameOther) {
  const t1 = getTradition(nameThis);
  const t2 = getTradition(nameOther);
  const ratio = t2 > 0 ? t1 / t2 : 1;
  return clamp(50 + (ratio - 1) * 50);
}

// 10. H2H (3 pts) — baseado em win % dos últimos 10 H2H
function scoreH2h(h2hGames, teamId) {
  if (!h2hGames || !h2hGames.length || !teamId) return null;
  const last10 = h2hGames.slice(-10);
  let wins = 0;
  for (const g of last10) {
    const homeId  = g?.teams?.home?.id;
    const awayId  = g?.teams?.away?.id;
    const goalsH  = g?.goals?.home;
    const goalsA  = g?.goals?.away;
    if (goalsH === null || goalsA === null) continue;
    const wonAsHome = homeId === teamId && goalsH > goalsA;
    const wonAsAway = awayId === teamId && goalsA > goalsH;
    if (wonAsHome || wonAsAway) wins++;
  }
  return clamp((wins / last10.length) * 100);
}

// 11. Odd/mercado como validação (2 pts)
function scoreOdd(oddFav) {
  if (!oddFav || oddFav <= 1) return null;
  // Odd baixa = mercado confia = score alto. Odd justa = 1/prob
  const impliedProb = (1 / oddFav) * 100;
  return clamp(impliedProb);
}

// ─────────────────────────────────────────────────────────────────
// AGREGAÇÃO PONDERADA
// ─────────────────────────────────────────────────────────────────

const WEIGHTS = {
  fifa:      15,
  elenco:    15,
  forma5:    12,
  forma10:   10,
  ppg:       10,
  ataque:    10,
  defesa:    10,
  contexto:   8,
  tradicao:   5,
  h2h:        3,
  odd:        2,
};

function aggregateScore(subscores) {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const s = subscores[key];
    if (s !== null && s !== undefined) {
      weightedSum += s * weight;
      totalWeight += weight;
    }
  }
  if (totalWeight === 0) return 50;
  return weightedSum / totalWeight;
}

// ─────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL — computeWcVencer(input)
// SEMPRE retorna resultado (nunca null)
// ─────────────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {object} input.raw              — objeto mapeado pelo PackBallMapper
 * @param {string} [input.homeFormString] — string de forma bruta (ex: "WWDLW")
 * @param {string} [input.awayFormString]
 * @param {Array}  [input.h2hGames]       — lista de jogos H2H da API
 * @param {object} [input.manualContext]  — wc_manual_context.json.teams
 * @param {number} [input.oddHome]        — odd da vitória casa (se disponível)
 * @param {number} [input.oddAway]        — odd da vitória fora (se disponível)
 *
 * @returns {{
 *   pick: 'home'|'away'|'draw'|'evitar',
 *   market: string,
 *   pickLabel: string,
 *   favoredTeam: string,
 *   opponentTeam: string,
 *   probability: number,
 *   probHome: number,
 *   probAway: number,
 *   probDraw: number,
 *   confidence: string,
 *   grade: string,
 *   score: number,
 *   scoreHome: number,
 *   scoreAway: number,
 *   isEvitar: boolean,
 *   breakdown: object,
 * }}
 */
function computeWcVencer(input = {}) {
  const { raw, homeFormString = null, awayFormString = null,
          h2hGames = [], manualContext = {}, oddHome = null, oddAway = null } = input;

  const homeTeam = raw?.home_team || '';
  const awayTeam = raw?.away_team || '';
  const homeId   = num(raw?.home_team_id);
  const awayId   = num(raw?.away_team_id);

  // Dados de força das seleções
  const powerHome = getTeamPower(homeTeam);
  const powerAway = getTeamPower(awayTeam);

  const rankHome = getFifaRank(homeTeam);
  const rankAway = getFifaRank(awayTeam);

  const ctxHome = manualContext[homeTeam] || {};
  const ctxAway = manualContext[awayTeam] || {};

  // Probabilidades da API (win_home/win_draw/win_away do predictions endpoint)
  const apiWinHome = num(raw?.win_home);
  const apiWinDraw = num(raw?.win_draw);
  const apiWinAway = num(raw?.win_away);

  // Subscore para cada critério — home
  const subHome = {
    fifa:      scoreFifa(rankHome, rankAway),
    elenco:    scoreElenco(powerHome.marketValueM, powerAway.marketValueM),
    forma5:    scoreForma5(num(raw?.home_form_score)),
    forma10:   scoreForma10(homeFormString),
    ppg:       scorePpg(num(raw?.ppg_h)),
    ataque:    scoreAtaque(num(raw?.avg_sc_h)),
    defesa:    scoreDefesa(num(raw?.home_avg_conc_home)),
    contexto:  scoreContexto(ctxHome),
    tradicao:  scoreTradition(homeTeam, awayTeam),
    h2h:       scoreH2h(h2hGames, homeId),
    odd:       scoreOdd(oddHome),
  };

  // Subscore para cada critério — away
  const subAway = {
    fifa:      scoreFifa(rankAway, rankHome),
    elenco:    scoreElenco(powerAway.marketValueM, powerHome.marketValueM),
    forma5:    scoreForma5(num(raw?.away_form_score)),
    forma10:   scoreForma10(awayFormString),
    ppg:       scorePpg(num(raw?.ppg_a)),
    ataque:    scoreAtaque(num(raw?.avg_sc_a)),
    defesa:    scoreDefesa(num(raw?.away_avg_conc_away)),
    contexto:  scoreContexto(ctxAway),
    tradicao:  scoreTradition(awayTeam, homeTeam),
    h2h:       scoreH2h(h2hGames, awayId),
    odd:       scoreOdd(oddAway),
  };

  const scoreHome = aggregateScore(subHome);
  const scoreAway = aggregateScore(subAway);

  // Score de empate — forte quando times são equilibrados
  const diff = Math.abs(scoreHome - scoreAway);
  const scoreDraw = Math.max(0, 100 - diff * 2.5);

  // Converter scores em probabilidades via softmax
  const expH = Math.exp(scoreHome / 20);
  const expA = Math.exp(scoreAway / 20);
  const expD = Math.exp(scoreDraw  / 30);
  const total = expH + expA + expD;

  let probHome = (expH / total) * 100;
  let probAway = (expA / total) * 100;
  let probDraw = (expD / total) * 100;

  // Misturar com probabilidades da API quando disponíveis (60% API, 40% motor)
  if (apiWinHome !== null && apiWinAway !== null) {
    const apiTotal = (apiWinHome + (apiWinDraw || 0) + apiWinAway) || 100;
    const apiH = (apiWinHome / apiTotal) * 100;
    const apiA = (apiWinAway / apiTotal) * 100;
    const apiD = (apiWinDraw !== null ? (apiWinDraw / apiTotal) * 100 : 100 - apiH - apiA);
    probHome = probHome * 0.4 + apiH * 0.6;
    probAway = probAway * 0.4 + apiA * 0.6;
    probDraw = probDraw * 0.4 + apiD * 0.6;
  }

  // Normalizar para somar 100
  const sumProb = probHome + probAway + probDraw;
  probHome = Math.round((probHome / sumProb) * 100);
  probAway = Math.round((probAway / sumProb) * 100);
  probDraw = 100 - probHome - probAway;

  // Escolher palpite mais provável
  let pick, pickScore;
  if (probHome >= probAway && probHome >= probDraw) {
    pick = 'home'; pickScore = scoreHome;
  } else if (probAway >= probHome && probAway >= probDraw) {
    pick = 'away'; pickScore = scoreAway;
  } else {
    pick = 'draw'; pickScore = scoreDraw;
  }

  const probability = pick === 'home' ? probHome : pick === 'away' ? probAway : probDraw;
  const margin = Math.abs(
    pick === 'home' ? probHome - Math.max(probAway, probDraw) :
    pick === 'away' ? probAway - Math.max(probHome, probDraw) :
                      probDraw - Math.max(probHome, probAway)
  );

  // Regras de entrada: só recomenda vitória seca quando seguro
  // isEvitar mantido apenas como flag informativo — não altera o pickLabel.
  // A categoria (Arriscado/Moderada/Alta/Elite) já comunica o nível de risco.
  const isEvitar = (
    pick !== 'draw' && (probability < 65 || margin < 10 || pickScore < 55)
  ) || (
    pick === 'draw' && probability < 65
  );

  // Labels — sempre mostra quem vai ganhar, nunca "Evitar 1X2"
  const favoredTeam  = pick === 'home' ? homeTeam : pick === 'away' ? awayTeam : '';
  const opponentTeam = pick === 'home' ? awayTeam : pick === 'away' ? homeTeam : '';

  let pickLabel, market;
  if (pick === 'home') {
    pickLabel = homeTeam ? `${homeTeam} vence` : 'Casa Vence';
    market    = 'Vitória da Casa';
  } else if (pick === 'away') {
    pickLabel = awayTeam ? `${awayTeam} vence` : 'Fora Vence';
    market    = 'Vitória do Visitante';
  } else {
    pickLabel = 'Empate';
    market    = 'Empate';
  }

  // Confiança — baseada na probabilidade real; jogos arriscados ficam em 'C'
  let confidence, grade;
  if (probability >= 85)      { confidence = 'Elite';     grade = 'A+'; }
  else if (probability >= 75) { confidence = 'Alta';      grade = 'A';  }
  else if (probability >= 65) { confidence = 'Moderada';  grade = 'B';  }
  else                        { confidence = 'Arriscado'; grade = 'C';  }

  return {
    pick,
    market,
    pickLabel,
    favoredTeam,
    opponentTeam,
    probability,
    probHome,
    probAway,
    probDraw,
    confidence,
    grade,
    score:     Math.round(pickScore),
    scoreHome: Math.round(scoreHome),
    scoreAway: Math.round(scoreAway),
    isEvitar,
    breakdown: { home: subHome, away: subAway },
  };
}

module.exports = { computeWcVencer };
