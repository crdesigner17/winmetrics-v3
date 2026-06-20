/**
 * WinMetrics V3 — Mercado "Dupla Chance" (1X / X2) — Copa do Mundo
 * ─────────────────────────────────────────────────────────────────────────────
 * Motor de scoring EXCLUSIVO para jogos da Copa do Mundo. Aposta de proteção:
 * cobre vitória do favorito OU empate (1X se o favorito é o mandante, X2 se é
 * o visitante). Objetivo: selecionar equipes com probabilidade extremamente
 * alta de NÃO PERDER — prioridade máxima é assertividade, não quantidade.
 *
 * ISOLADO — não altera nenhum outro mercado, engine ou liga. Só roda quando
 * chamado explicitamente para fixtures de Copa do Mundo (WORLD_CUP_LEAGUE_NAMES).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CRITÉRIOS OBRIGATÓRIOS (gates — reprovam o jogo inteiro se não baterem)
 *
 *   #1 non_lose_probability = win_fav% + draw_probability%
 *        1X → home_win_probability + draw_probability
 *        X2 → away_win_probability + draw_probability
 *      Mínimo 82% (abaixo disso, reprovado). Ideal >=85%. Elite >=88%.
 *   #2 draw_probability < 15%  → reprovado (empate baixo demais não justifica
 *      a proteção). Faixa ideal é 18-30%, mas isso NÃO reprova sozinho —
 *      só entra como exigência extra no gate de A+.
 *   #3 Jogo equilibrado: abs(home_win_probability - away_win_probability) < 8
 *      → reprovado (sem favorito real o suficiente pra "não perder" fazer sentido).
 *   #4 Máximo 1 derrota nos últimos 5 jogos do favorito (quando o dado de
 *      forma está disponível; se ausente, não bloqueia sozinho).
 *   #5 Motivação: amistoso, classificação garantida ou risco de rotação
 *      confirmado em manualContext → reprovado (mesma cautela do Vencer/Vencer;
 *      não estava no enunciado novo, mantido como camada extra de segurança —
 *      "preferir perder oportunidades a aprovar partidas duvidosas").
 *
 * CRITÉRIOS DE SCORE (pool ponderado, 0-100, redistribuído quando faltar dado)
 *   Probabilidade (não perder)  40%   Forma recente   20%   Ranking FIFA  15%
 *   Defesa                      15%   Adversário      10%
 *
 * CLASSIFICAÇÃO
 *   A+ (Elite): score >= 90 E SIMULTANEAMENTE:
 *               non_lose_probability >= 88%
 *               draw_probability entre 18% e 30%
 *               forma recente do favorito >= 75%
 *               máximo 1 derrota nos últimos 5 jogos
 *               média sofrida do favorito (goals_conceded_avg) <= 1.0
 *   A: 85-89   B: 80-84   C: 75-79   D: <75
 *   → só retorna resultado aprovável quando grade final é A+, A ou B
 *     (score >= 75, grade D nunca aprova) — "não aumentar quantidade de jogos; preferir perder
 *     oportunidades do que aprovar partidas duvidosas".
 *
 * Ranking FIFA: snapshot fixo em data/wc_fifa_ranking.js (11/06/2026) — nunca
 * aprova sozinho, é só um dos 5 critérios do pool ponderado (peso 15%).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { getTeamPower }                                  = require('../data/wc_team_power.js');
const { getFifaRank, calculateFifaRankingScore }         = require('../data/wc_fifa_ranking.js');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

const GATE = {
  MIN_NON_LOSE_PROB:   82,  // win_fav% + draw% >= 82% (abaixo disso, reprova)
  IDEAL_NON_LOSE_PROB: 85,
  ELITE_NON_LOSE_PROB: 88,
  MIN_DRAW_PROB:       15,  // draw_probability < 15% → reprova
  IDEAL_DRAW_MIN:      18,  // faixa ideal de empate (não reprova fora dela)
  IDEAL_DRAW_MAX:      30,
  MIN_EQUILIBRIO_GAP:   8,  // abs(home - away) < 8 → jogo equilibrado, reprova
  MAX_LOSSES_LAST5:     1,  // máximo 1 derrota do favorito nos últimos 5 jogos
};

const ELITE_GATE = {
  MIN_NON_LOSE_PROB: 88,
  DRAW_MIN:          18,
  DRAW_MAX:          30,
  MIN_FORMA_FAV:     75,  // forma recente do favorito >= 75%
  MAX_LOSSES_LAST5:   1,
  MAX_GOALS_CONCEDED: 1.0, // média sofrida <= 1 gol
};

// Pesos somam 100. Sem Valor de Elenco e sem Consistência nesta versão —
// "Adversário" entra como critério próprio (irregularidade, baixa eficiência
// ofensiva, sequência negativa do time adversário).
const WEIGHTS = {
  probabilidade: 40,
  formaRecente:  20,
  fifaRanking:   15,
  defesa:        15,
  adversario:    10,
};

const MIN_COVERAGE = 60;

const WORLD_CUP_LEAGUE_NAMES = ['World: World Cup', 'FIFA World Cup', 'World Cup'];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function clamp(v, min = 0, max = 100) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.max(min, Math.min(max, v));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Últimos 5 resultados (mais recente = último char) — draws/losses/transitions/trailingLosses. */
function analyzeLast5(formString) {
  if (!formString || typeof formString !== 'string') return null;
  const chars = formString.toUpperCase().split('').filter(c => ['W', 'D', 'L'].includes(c));
  if (!chars.length) return null;
  const last5 = chars.slice(-5);
  let trailingLosses = 0;
  for (let i = last5.length - 1; i >= 0; i--) {
    if (last5[i] === 'L') trailingLosses++;
    else break;
  }
  return {
    last5,
    draws:           last5.filter(c => c === 'D').length,
    losses:          last5.filter(c => c === 'L').length,
    transitions:     last5.slice(1).filter((c, i) => c !== last5[i]).length,
    trailingLosses,  // sequência negativa atual (derrotas seguidas mais recentes)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCORES — 0-100, favorável ao lado PROTEGIDO (favorito), null se faltar dado
// ─────────────────────────────────────────────────────────────────────────────

// Probabilidade (não perder) — 40%. Tiers: mínimo 82 / ideal 85 / elite 88.
function scoreProbabilidade(nonLose) {
  if (nonLose === null) return null;
  if (nonLose >= 93) return 100;
  if (nonLose >= GATE.ELITE_NON_LOSE_PROB)  return 90 + (nonLose - GATE.ELITE_NON_LOSE_PROB)  * 2; // 88→90 .. 93→100
  if (nonLose >= GATE.IDEAL_NON_LOSE_PROB)  return 75 + (nonLose - GATE.IDEAL_NON_LOSE_PROB)  * 5; // 85→75 .. 88→90
  if (nonLose >= GATE.MIN_NON_LOSE_PROB)    return 60 + (nonLose - GATE.MIN_NON_LOSE_PROB)    * 5; // 82→60 .. 85→75
  return clamp(60 - (GATE.MIN_NON_LOSE_PROB - nonLose) * 5); // defensivo (não deveria chegar aqui — já reprovado pelo gate)
}

// Forma recente — 20%. Equipe protegida ideal >=65%, adversário bom <=50%.
function scoreFormaRecente(formFav, formOpp) {
  if (formFav === null && formOpp === null) return null;
  let s = 50;
  if (formFav !== null) {
    if (formFav >= 85)      s += 30;
    else if (formFav >= 65) s += 20;
    else                     s -= 15;
  }
  if (formOpp !== null) {
    if (formOpp <= 50)      s += 15;
    else if (formOpp > 65)  s -= 15;
  }
  return clamp(s);
}

// Ranking FIFA — 15%. Ideal >=10 posições de vantagem.
function scoreFifaRanking(rankFav, rankOpp) {
  return calculateFifaRankingScore(rankFav, rankOpp);
}

// Defesa — 15%. goals_conceded_avg do favorito: <=1.2 aceitável, ideal <=1.0.
function scoreDefesa(gaFav) {
  if (gaFav === null) return null;
  if (gaFav <= 1.0) return 100;
  if (gaFav <= 1.2) return 75;
  if (gaFav <= 1.5) return 50;
  return 25;
}

// Adversário — 10%. Pontua positivamente irregularidade, baixa eficiência
// ofensiva e sequência negativa do ADVERSÁRIO (tudo isso é bom pra "não perder").
function scoreAdversario(formStrOpp, gfOpp) {
  const a = analyzeLast5(formStrOpp);
  if (!a && gfOpp === null) return null;
  let s = 50;
  if (a) {
    if (a.transitions >= 3)        s += 15; // sequência irregular
    if (a.trailingLosses >= 2)     s += 15; // sequência negativa recente
    else if (a.losses >= 2)        s += 8;  // várias derrotas, mesmo sem ser seguidas
  }
  if (gfOpp !== null) {
    if (gfOpp < 1.0)        s += 15; // baixa eficiência ofensiva
    else if (gfOpp >= 1.8)  s -= 10; // adversário ofensivamente perigoso
  }
  return clamp(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * computeWcDuplaChance(input)
 *
 * @param {object} input
 * @param {object} input.raw              — objeto raw já mapeado (PackBallMapper)
 * @param {string} [input.homeFormString]
 * @param {string} [input.awayFormString]
 * @param {object} [input.manualContext]
 *
 * @returns {object|null} — null se reprovado ou score < 75 (grade D); senão:
 *   {
 *     market: 'Dupla Chance 1X' | 'Dupla Chance X2',
 *     score, grade,               // grade só pode ser 'A+', 'A', 'B' ou 'C'
 *     favoredTeam, opponentTeam, nonLoseProbability,
 *     coverage, breakdown,
 *     rejected: false
 *   }
 *   Use computeWcDuplaChanceDebug() para ver o motivo de rejeição.
 */
function computeWcDuplaChance(input = {}) {
  const result = computeWcDuplaChanceDebug(input);
  if (!result || result.rejected || !['A+', 'A', 'B', 'C'].includes(result.grade)) return null;
  const { rejected, rejectReason, ...approved } = result;
  return approved;
}

function computeWcDuplaChanceDebug({ raw, homeFormString = null, awayFormString = null, manualContext = {}, homeBalanced = null, awayBalanced = null, balancedWin = null } = {}) {
  if (!raw) return { rejected: true, rejectReason: 'raw ausente' };

  // [NOVO] Probabilidades balanceadas casa+fora (True Signal) têm prioridade
  // sobre o pred.percent bruto da API quando disponíveis.
  const winHome = balancedWin ? balancedWin.win_home : num(raw.win_home);
  const winDraw = balancedWin ? balancedWin.win_draw : num(raw.win_draw);
  const winAway = balancedWin ? balancedWin.win_away : num(raw.win_away);

  if (winHome === null || winAway === null) {
    return { rejected: true, rejectReason: 'sem probabilidades (win_home/win_away ausentes)' };
  }
  if (winDraw === null) {
    return { rejected: true, rejectReason: 'sem draw_probability — não dá pra calcular non_lose_probability' };
  }

  // ── GATE #2 — draw_probability < 15% → reprova ──────────────────────────
  if (winDraw < GATE.MIN_DRAW_PROB) {
    return { rejected: true, rejectReason: `draw_probability ${winDraw}% < ${GATE.MIN_DRAW_PROB}%` };
  }

  // ── GATE #3 — Jogo equilibrado: abs(home - away) < 8 → reprova ──────────
  if (Math.abs(winHome - winAway) < GATE.MIN_EQUILIBRIO_GAP) {
    return { rejected: true, rejectReason: `jogo equilibrado — abs(home-away) < ${GATE.MIN_EQUILIBRIO_GAP}pp` };
  }

  // Favorito = lado com maior probabilidade de vitória.
  const side = winHome >= winAway ? 'home' : 'away';
  const favoredTeam  = side === 'home' ? raw.home_team : raw.away_team;
  const opponentTeam = side === 'home' ? raw.away_team : raw.home_team;
  const winFav       = side === 'home' ? winHome : winAway;

  const nonLoseProbability = Math.round((winFav + winDraw) * 10) / 10;

  // ── GATE #1 — non_lose_probability >= 82% ────────────────────────────────
  if (nonLoseProbability < GATE.MIN_NON_LOSE_PROB) {
    return { rejected: true, rejectReason: `non_lose_probability ${nonLoseProbability}% < ${GATE.MIN_NON_LOSE_PROB}%` };
  }

  // ── GATE #5 — Motivação (camada extra de segurança, mesmo critério do Vencer) ─
  const ctxFav = (manualContext && manualContext[favoredTeam]) || {};
  if (ctxFav.friendly) {
    return { rejected: true, rejectReason: `${favoredTeam} — partida amistosa (manualContext)` };
  }
  if (ctxFav.alreadyQualifiedNoStakes) {
    return { rejected: true, rejectReason: `${favoredTeam} — classificação garantida, sem necessidade real (manualContext)` };
  }
  if (ctxFav.rotationRisk) {
    return { rejected: true, rejectReason: `${favoredTeam} — risco de rotação (manualContext)` };
  }

  const formStrFav = side === 'home' ? homeFormString : awayFormString;
  const formStrOpp = side === 'home' ? awayFormString : homeFormString;

  // ── GATE #4 — Máximo 1 derrota nos últimos 5 jogos do favorito ──────────
  const last5Fav = analyzeLast5(formStrFav);
  if (last5Fav && last5Fav.losses > GATE.MAX_LOSSES_LAST5) {
    return { rejected: true, rejectReason: `${favoredTeam} teve ${last5Fav.losses} derrotas nos últimos 5 jogos (máx. ${GATE.MAX_LOSSES_LAST5})` };
  }

  // ── Coleta de dados por critério ────────────────────────────────────────
  const rankFav = getFifaRank(favoredTeam);
  const rankOpp = getFifaRank(opponentTeam);

  const formFav = side === 'home' ? num(raw.home_form_score) : num(raw.away_form_score);
  const formOpp = side === 'home' ? num(raw.away_form_score) : num(raw.home_form_score);

  const gaFav = side === 'home'
    ? (homeBalanced?.balancedDefense ?? num(raw.home_avg_conc_home))
    : (awayBalanced?.balancedDefense ?? num(raw.away_avg_conc_away));
  const gfOpp = side === 'home'
    ? (awayBalanced?.balancedAttack ?? num(raw.avg_sc_a))
    : (homeBalanced?.balancedAttack ?? num(raw.avg_sc_h));

  // ── Subscores ─────────────────────────────────────────────────────────
  const subscores = {
    probabilidade: scoreProbabilidade(nonLoseProbability),
    formaRecente:  scoreFormaRecente(formFav, formOpp),
    fifaRanking:   scoreFifaRanking(rankFav, rankOpp),
    defesa:        scoreDefesa(gaFav),
    adversario:    scoreAdversario(formStrOpp, gfOpp),
  };

  let weightedSum = 0;
  let availableWeight = 0;
  const breakdown = {};
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const sub = subscores[key];
    breakdown[key] = { weight, subscore: sub, available: sub !== null };
    if (sub !== null) {
      weightedSum += sub * weight;
      availableWeight += weight;
    }
  }

  const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const coverage = Math.round((availableWeight / totalWeight) * 1000) / 10;

  if (availableWeight === 0) {
    return { rejected: true, rejectReason: 'nenhum critério com dado disponível' };
  }

  const finalScore = clamp(weightedSum / availableWeight);

  // ── Classificação ─────────────────────────────────────────────────────
  let grade;
  if (coverage < MIN_COVERAGE) {
    grade = 'C';
  } else if (
    finalScore >= 90 &&
    nonLoseProbability >= ELITE_GATE.MIN_NON_LOSE_PROB &&
    winDraw >= ELITE_GATE.DRAW_MIN && winDraw <= ELITE_GATE.DRAW_MAX &&
    (formFav !== null && formFav >= ELITE_GATE.MIN_FORMA_FAV) &&
    (last5Fav === null || last5Fav.losses <= ELITE_GATE.MAX_LOSSES_LAST5) &&
    (gaFav !== null && gaFav <= ELITE_GATE.MAX_GOALS_CONCEDED)
  ) {
    grade = 'A+';
  } else if (finalScore >= 85) grade = 'A';
  else if (finalScore >= 80)   grade = 'B';
  else if (finalScore >= 75)   grade = 'C';
  else                          grade = 'D';

  return {
    rejected: false,
    rejectReason: null,
    market: side === 'home' ? 'Dupla Chance 1X' : 'Dupla Chance X2',
    score: Math.round(finalScore * 10) / 10,
    grade,
    favoredTeam,
    opponentTeam,
    nonLoseProbability,
    drawProbability: winDraw,
    margin: Math.round(Math.abs(winHome - winAway) * 10) / 10,
    fifaRankFav: rankFav,
    fifaRankOpp: rankOpp,
    formFav,
    goalsConcededFav: gaFav,
    last5LossesFav: last5Fav ? last5Fav.losses : null,
    coverage,
    breakdown,
  };
}

module.exports = {
  computeWcDuplaChance,
  computeWcDuplaChanceDebug,
  WORLD_CUP_LEAGUE_NAMES,
  WEIGHTS,
  GATE,
  ELITE_GATE,
  MIN_COVERAGE,
};
