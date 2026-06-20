/**
 * WinMetrics V3 — Mercado "Dupla Chance" (1X / X2) — Copa do Mundo
 * ─────────────────────────────────────────────────────────────────────────────
 * Motor de scoring EXCLUSIVO para jogos da Copa do Mundo. Aposta de proteção:
 * cobre vitória do favorito OU empate (1X se o favorito é o mandante, X2 se é
 * o visitante). Por isso o gate central é "não perder" (non_lose_probability),
 * não a vitória pura — diferente do mercado Vencer/Vencer.
 *
 * ISOLADO — não altera nenhum outro mercado, engine ou liga. Só roda quando
 * chamado explicitamente para fixtures de Copa do Mundo (WORLD_CUP_LEAGUE_NAMES).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CRITÉRIOS OBRIGATÓRIOS (gates)
 *
 *   #1 non_lose_probability = win_fav% + draw_probability%  >= 82%
 *   #2 draw_probability ENTRE 18% e 30% (fora desse range → reprovado —
 *      empate baixo demais não justifica a proteção, alto demais é arriscado)
 *   #3 Máximo 1 derrota nos últimos 5 jogos do favorito (quando o dado de
 *      forma está disponível; se ausente, não bloqueia sozinho)
 *   #4 Motivação: amistoso, classificação garantida ou risco de rotação
 *      confirmado em manualContext → reprovado (mesmo critério do Vencer)
 *
 * CRITÉRIOS DE SCORE (pool ponderado, 0-100, redistribuído quando faltar dado)
 *   Probabilidade (non_lose)  35%   Forma recente   20%   Ranking FIFA  15%
 *   Valor elenco              15%   Defesa          10%   Consistência   5%
 *
 * CLASSIFICAÇÃO — mesma régua do Vencer/Vencer:
 *   A+ (Elite): score >= 90 E non_lose >= 88% E superioridade clara no
 *               Ranking FIFA E superioridade clara no valor de elenco.
 *   A: 85-89   B: 80-84   C: 75-79   D: <75
 *   → só retorna resultado aprovável quando grade final é A+, A ou B
 *     (score >= 80) — "priorizar qualidade em vez de quantidade".
 *
 * Ranking FIFA: snapshot fixo em data/wc_fifa_ranking.js (11/06/2026) — nunca
 * aprova sozinho, é só um dos 6 critérios do pool ponderado (peso 15%).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { getTeamPower }                                  = require('../data/wc_team_power.js');
const { getFifaRank, calculateFifaRankingScore }         = require('../data/wc_fifa_ranking.js');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

const GATE = {
  MIN_NON_LOSE_PROB: 82,  // win_fav% + draw% >= 82%
  MIN_DRAW_PROB:     18,
  MAX_DRAW_PROB:     30,
  MAX_LOSSES_LAST5:   1,  // máximo 1 derrota do favorito nos últimos 5 jogos
};

const ELITE_GATE = {
  MIN_NON_LOSE_PROB: 88,
  MIN_FIFA_SCORE:    80, // gap de ranking >= 20 ("vantagem forte")
  MIN_ELENCO_SCORE:  80, // ratio de valor de elenco >= 1.5
};

// Mesma distribuição de pesos do Vencer/Vencer (Ataque/Defesa vira só Defesa
// aqui, já que o mercado é sobre não perder, não sobre marcar gols).
const WEIGHTS = {
  probabilidade: 35,
  formaRecente:  20,
  fifaRanking:   15,
  valorElenco:   15,
  defesa:        10,
  consistencia:   5,
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

/** Últimos 5 resultados (mais recente = último char) — draws/losses/transitions. */
function analyzeLast5(formString) {
  if (!formString || typeof formString !== 'string') return null;
  const chars = formString.toUpperCase().split('').filter(c => ['W', 'D', 'L'].includes(c));
  if (!chars.length) return null;
  const last5 = chars.slice(-5);
  return {
    last5,
    draws:       last5.filter(c => c === 'D').length,
    losses:      last5.filter(c => c === 'L').length,
    transitions: last5.slice(1).filter((c, i) => c !== last5[i]).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCORES — 0-100, favorável ao FAVORITO, null se faltar dado
// ─────────────────────────────────────────────────────────────────────────────

// Probabilidade (non_lose) — 35%
function scoreProbabilidade(nonLose) {
  if (nonLose === null) return null;
  return clamp(50 + (nonLose - GATE.MIN_NON_LOSE_PROB) * 2.5);
}

// Forma recente — 20% (mesmos limiares do Vencer: favorito ideal >=80%, adversário bom <=50%)
function scoreFormaRecente(formFav, formOpp) {
  if (formFav === null && formOpp === null) return null;
  let s = 50;
  if (formFav !== null) {
    if (formFav >= 80)      s += 25;
    else if (formFav >= 70) s += 12;
    else                     s -= 10;
  }
  if (formOpp !== null) {
    if (formOpp <= 50)      s += 15;
    else if (formOpp > 70)  s -= 15;
  }
  return clamp(s);
}

// Ranking FIFA — 15%
function scoreFifaRanking(rankFav, rankOpp) {
  return calculateFifaRankingScore(rankFav, rankOpp);
}

// Valor de elenco — 15% (mesma régua do Vencer)
function scoreValorElenco(valFav, valOpp) {
  if (!valFav || !valOpp) return null;
  const ratio = valFav / valOpp;
  if (ratio >= 2.0) return 100;
  if (ratio >= 1.5) return 80;
  if (ratio >= 1.2) return 65;
  if (ratio >= 1.0) return 55;
  if (ratio >= 0.8) return 40;
  return 25;
}

// Defesa — 10%. Favorito sofrendo pouco + adversário marcando pouco = boa proteção.
function scoreDefesa(gaFav, gfOpp) {
  if (gaFav === null && gfOpp === null) return null;
  let s = 50;
  if (gaFav !== null) {
    if (gaFav <= 0.8)      s += 25;
    else if (gaFav > 1.5)  s -= 20;
  }
  if (gfOpp !== null) {
    if (gfOpp <= 0.8)      s += 15;
    else if (gfOpp > 1.5)  s -= 15;
  }
  return clamp(s);
}

// Consistência — 5% (mesmo critério do Vencer/Vencer)
function scoreConsistencia(formStrFav) {
  const a = analyzeLast5(formStrFav);
  if (!a) return null;
  let s = 80;
  s -= a.draws * 8;
  s -= a.losses * 10;
  if (a.transitions >= 3) s -= 10;
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
 * @returns {object|null} — null se reprovado ou score < 80; senão:
 *   {
 *     market: 'Dupla Chance 1X' | 'Dupla Chance X2',
 *     score, grade,               // grade só pode ser 'A+', 'A' ou 'B'
 *     favoredTeam, opponentTeam, nonLoseProbability,
 *     coverage, breakdown,
 *     rejected: false
 *   }
 *   Use computeWcDuplaChanceDebug() para ver o motivo de rejeição.
 */
function computeWcDuplaChance(input = {}) {
  const result = computeWcDuplaChanceDebug(input);
  if (!result || result.rejected || !['A+', 'A', 'B'].includes(result.grade)) return null;
  const { rejected, rejectReason, ...approved } = result;
  return approved;
}

function computeWcDuplaChanceDebug({ raw, homeFormString = null, awayFormString = null, manualContext = {} } = {}) {
  if (!raw) return { rejected: true, rejectReason: 'raw ausente' };

  const winHome = num(raw.win_home);
  const winDraw = num(raw.win_draw);
  const winAway = num(raw.win_away);

  if (winHome === null || winAway === null) {
    return { rejected: true, rejectReason: 'sem probabilidades (win_home/win_away ausentes)' };
  }
  if (winDraw === null) {
    return { rejected: true, rejectReason: 'sem draw_probability — não dá pra calcular non_lose_probability' };
  }

  // ── GATE #2 — Probabilidade de empate precisa estar entre 18% e 30% ─────
  if (winDraw < GATE.MIN_DRAW_PROB || winDraw > GATE.MAX_DRAW_PROB) {
    return { rejected: true, rejectReason: `draw_probability ${winDraw}% fora da faixa ${GATE.MIN_DRAW_PROB}-${GATE.MAX_DRAW_PROB}%` };
  }

  // Favorito = lado com maior probabilidade de vitória (não exige 62% aqui —
  // o gate real desse mercado é non_lose_probability, não vitória pura).
  const side = winHome >= winAway ? 'home' : 'away';
  const favoredTeam  = side === 'home' ? raw.home_team : raw.away_team;
  const opponentTeam = side === 'home' ? raw.away_team : raw.home_team;
  const winFav       = side === 'home' ? winHome : winAway;

  const nonLoseProbability = Math.round((winFav + winDraw) * 10) / 10;

  // ── GATE #1 — non_lose_probability >= 82% ────────────────────────────────
  if (nonLoseProbability < GATE.MIN_NON_LOSE_PROB) {
    return { rejected: true, rejectReason: `non_lose_probability ${nonLoseProbability}% < ${GATE.MIN_NON_LOSE_PROB}%` };
  }

  // ── GATE #4 — Motivação (mesmo critério do Vencer/Vencer) ───────────────
  const ctxFav = (manualContext && manualContext[favoredTeam]) || {};
  const ctxOpp = (manualContext && manualContext[opponentTeam]) || {};
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

  // ── GATE #3 — Máximo 1 derrota nos últimos 5 jogos do favorito ──────────
  const last5Fav = analyzeLast5(formStrFav);
  if (last5Fav && last5Fav.losses > GATE.MAX_LOSSES_LAST5) {
    return { rejected: true, rejectReason: `${favoredTeam} teve ${last5Fav.losses} derrotas nos últimos 5 jogos (máx. ${GATE.MAX_LOSSES_LAST5})` };
  }

  // ── Coleta de dados por critério ────────────────────────────────────────
  const powerFav = getTeamPower(favoredTeam);
  const powerOpp = getTeamPower(opponentTeam);
  const rankFav  = getFifaRank(favoredTeam);
  const rankOpp  = getFifaRank(opponentTeam);

  const formFav = side === 'home' ? num(raw.home_form_score) : num(raw.away_form_score);
  const formOpp = side === 'home' ? num(raw.away_form_score) : num(raw.home_form_score);

  const gaFav = side === 'home' ? num(raw.home_avg_conc_home) : num(raw.away_avg_conc_away);
  const gfOpp = side === 'home' ? num(raw.avg_sc_a)            : num(raw.avg_sc_h);

  // ── Subscores ─────────────────────────────────────────────────────────
  const subscores = {
    probabilidade: scoreProbabilidade(nonLoseProbability),
    formaRecente:  scoreFormaRecente(formFav, formOpp),
    fifaRanking:   scoreFifaRanking(rankFav, rankOpp),
    valorElenco:   scoreValorElenco(powerFav.marketValueM, powerOpp.marketValueM),
    defesa:        scoreDefesa(gaFav, gfOpp),
    consistencia:  scoreConsistencia(formStrFav),
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
    (subscores.fifaRanking !== null && subscores.fifaRanking >= ELITE_GATE.MIN_FIFA_SCORE) &&
    (subscores.valorElenco !== null && subscores.valorElenco >= ELITE_GATE.MIN_ELENCO_SCORE)
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
    fifaRankFav: rankFav,
    fifaRankOpp: rankOpp,
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
