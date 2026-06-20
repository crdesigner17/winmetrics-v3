/**
 * WinMetrics V3 — Mercado "Vencer / Vencer" (Resultado Final 1X2) — Copa do Mundo
 * ─────────────────────────────────────────────────────────────────────────────
 * Motor de scoring EXCLUSIVO para jogos da Copa do Mundo. Reescrito em 2026-06
 * para a especificação de máxima assertividade (Carlos): poucos sinais, porém
 * com máxima confiabilidade. Prioriza qualidade sobre quantidade — só mostra
 * score >= 75 (grade C, B, A ou A+).
 *
 * ISOLADO — não altera nenhum outro mercado, engine ou liga. Só roda quando
 * chamado explicitamente para fixtures de Copa do Mundo (WORLD_CUP_LEAGUE_NAMES).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CRITÉRIOS OBRIGATÓRIOS (gates — reprovam o jogo inteiro se não baterem)
 *
 *   #1 Probabilidade mínima:
 *        Vitória Casa:  home_win_probability >= 62%  E  vantagem >= 15pp sobre away
 *        Vitória Fora:  away_win_probability >= 62%  E  vantagem >= 15pp sobre home
 *        Caso nenhum lado bata isso → reprovado (jogo equilibrado).
 *   #2 Probabilidade de empate:  draw_probability > 25%  → reprovado.
 *   #3 Motivação: amistoso, classificação já garantida (sem necessidade) ou
 *      risco de rotação confirmado em manualContext → reprovado.
 *
 * CRITÉRIOS DE SCORE (pool ponderado, 0-100, redistribuído quando faltar dado)
 *
 *   Probabilidade   35%   Forma recente   20%   Ranking FIFA   15%
 *   Valor elenco    15%   Ataque/Defesa   10%   Consistência    5%
 *
 * CLASSIFICAÇÃO
 *   A+ (Elite): score >= 90  E  probabilidade >= 70%  E  vantagem >= 20pp
 *               E  empate <= 22%  E  superioridade clara no Ranking FIFA
 *               E  superioridade clara no valor de elenco.
 *   A:  85-89   B: 80-84   C: 75-79   D: <75
 *   → só retorna resultado aprovável quando grade final é A+, A ou B
 *     (score >= 75, grade D nunca aprova). "Priorizar qualidade em vez de
 *     quantidade" — cada grade tem cor própria no frontend (A+ verde, A
 *     dourado, B azul, C roxo).
 *
 * ODDS — nunca bloqueiam aprovação. Servidas apenas como informação (VALUE
 * quando odd_oferecida > odd_justa × 1.05). odd_justa = 100 / probabilidade.
 *
 * FONTES DE DADO:
 *   Automático (já flui no pipeline hoje): win_home/win_draw/win_away
 *   (API-Football /predictions), home_form_score/away_form_score e
 *   avg_sc_h/avg_sc_a/avg_conc_* (API-Football /teams/statistics).
 *   Manual (frontend/data/wc_manual_context.json — pulado quando ausente,
 *   nunca inventado): valor de elenco (marketValueM em wc_team_power.js,
 *   hoje todo null — critério fica em coverage até ser preenchido), motivação
 *   (friendly / alreadyQualifiedNoStakes / rotationRisk).
 *   Ranking FIFA: snapshot fixo em data/wc_fifa_ranking.js (11/06/2026).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { getTeamPower }                                    = require('../data/wc_team_power.js');
const { getFifaRank, calculateFifaRankingScore }           = require('../data/wc_fifa_ranking.js');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO — limiares e pesos (ajustáveis aqui, em um único lugar)
// ─────────────────────────────────────────────────────────────────────────────

const GATE = {
  MIN_WIN_PROB:        62,   // exige >= 62% para o lado favorito
  MIN_MARGIN:          15,   // exige vantagem mínima de 15pp sobre o adversário
  MAX_DRAW_PROB:       25,   // reprova se draw_probability > 25%
};

// A+ exige um patamar mais alto, à parte da regra geral de aprovação.
const ELITE_GATE = {
  MIN_WIN_PROB:  70,
  MIN_MARGIN:    20,
  MAX_DRAW_PROB: 22,
  MIN_FIFA_SCORE:   80, // calculateFifaRankingScore >= 80 → "vantagem forte" (gap >= 20)
  MIN_ELENCO_SCORE: 80, // scoreValorElenco >= 80 → ratio >= 1.5 ("favorável"/"forte")
};

// Pesos somam 100. Quando um critério não tem dado disponível, seu peso é
// redistribuído proporcionalmente entre os critérios que têm dado real.
const WEIGHTS = {
  probabilidade: 35,
  formaRecente:  20,
  fifaRanking:   15,
  valorElenco:   15,
  ataqueDefesa:  10,
  consistencia:   5,
};

// Cobertura mínima de peso (soma dos pesos com dado disponível) para sequer
// considerar grade acima de C. Hoje probabilidade(35) + ranking(15) sempre
// disponíveis = 50pp; com forma recente (mais 20) chega a 70%, normalmente
// suficiente. Abaixo disso, a grade é travada em 'C' (não aprovado).
const MIN_COVERAGE = 60;

// Penalidade de desfalques (fora do pool de 100 — aplicada depois, como redutor)
const DESFALQUE_PENALTY_EACH = 6;
const DESFALQUE_PENALTY_MAX  = 18;
const OPPONENT_DESFALQUE_BONUS_EACH = 3;
const OPPONENT_DESFALQUE_BONUS_MAX  = 9;

// Ligas de Copa do Mundo aceitas — mesmo array usado no frontend (previsoes.html)
const WORLD_CUP_LEAGUE_NAMES = ['World: World Cup', 'FIFA World Cup', 'World Cup'];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS NUMÉRICOS
// ─────────────────────────────────────────────────────────────────────────────

function clamp(v, min = 0, max = 100) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.max(min, Math.min(max, v));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Analisa os últimos 5 resultados de uma string de forma da API-Football
 * (ex: "WWDLW", mais recente é o último caractere).
 * Retorna { draws, losses, transitions } — usado em scoreConsistencia().
 */
function analyzeLast5(formString) {
  if (!formString || typeof formString !== 'string') return null;
  const chars = formString.toUpperCase().split('').filter(c => ['W', 'D', 'L'].includes(c));
  if (!chars.length) return null;
  const last5 = chars.slice(-5);
  const draws  = last5.filter(c => c === 'D').length;
  const losses = last5.filter(c => c === 'L').length;
  let transitions = 0;
  for (let i = 1; i < last5.length; i++) {
    if (last5[i] !== last5[i - 1]) transitions++;
  }
  return { last5, draws, losses, transitions };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCORES — cada um retorna 0-100 (favorável ao FAVORITO) ou null se
// faltar dado. Nunca retornam um valor "inventado".
// ─────────────────────────────────────────────────────────────────────────────

// Probabilidade — 35%
function scoreProbabilidade(winFav, winOpp) {
  if (winFav === null || winOpp === null) return null;
  const margin = winFav - winOpp;
  return clamp(50 + (winFav - GATE.MIN_WIN_PROB) * 1.5 + (margin - GATE.MIN_MARGIN) * 1.0);
}

// Forma recente — 20%. Favorito: ideal >=80%, mínimo >=70%. Adversário: bom se <=50%.
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

// Ranking FIFA — 15%. Usa o snapshot fixo (data/wc_fifa_ranking.js).
function scoreFifaRanking(rankFav, rankOpp) {
  return calculateFifaRankingScore(rankFav, rankOpp);
}

// Valor de elenco — 15%. market_value_ratio = favorito / adversário.
//   >= 2.0 → forte (100)   >= 1.5 → favorável (80)
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

// Ataque/Defesa — 10%. Favorito: goals_scored_avg >= 1.5. Adversário: goals_conceded_avg >= 1.2.
function scoreAtaqueDefesa(gfFav, gaOpp) {
  if (gfFav === null && gaOpp === null) return null;
  let s = 50;
  if (gfFav !== null) {
    if (gfFav >= 1.5)      s += 20;
    else if (gfFav < 1.0)  s -= 15;
  }
  if (gaOpp !== null) {
    if (gaOpp >= 1.2)      s += 20;
    else if (gaOpp < 0.8)  s -= 15;
  }
  return clamp(s);
}

// Consistência — 5%. Penaliza muitos empates e sequência irregular nos últimos 5.
// (Derrotas especificamente "para equipes inferiores" não é calculável hoje —
// não há histórico de força do adversário por partida no pipeline; penalizamos
// derrotas em geral como proxy, documentado aqui para auditoria futura.)
function scoreConsistencia(formStrFav) {
  const a = analyzeLast5(formStrFav);
  if (!a) return null;
  let s = 80;
  s -= a.draws * 8;
  s -= a.losses * 10;
  if (a.transitions >= 3) s -= 10; // sequência irregular (muita alternância W/D/L)
  return clamp(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// ODDS — nunca bloqueiam aprovação, só sinalizam VALUE informativamente.
// ─────────────────────────────────────────────────────────────────────────────

function calcOddJusta(probabilityPct) {
  if (!probabilityPct || probabilityPct <= 0) return null;
  return Math.round((100 / probabilityPct) * 100) / 100;
}

function calcIsValue(oddOferecida, oddJusta) {
  if (oddOferecida === null || oddOferecida === undefined) return null;
  if (oddJusta === null) return null;
  return oddOferecida > oddJusta * 1.05;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * computeWcResultadoFinal(input)
 *
 * @param {object} input
 * @param {object} input.raw              — objeto raw já mapeado (PackBallMapper)
 * @param {string} [input.homeFormString] — string de forma bruta (ex: "WWDLW")
 * @param {string} [input.awayFormString] — idem, away
 * @param {object} [input.manualContext]  — conteúdo de wc_manual_context.json.teams
 * @param {number} [input.oddOferecida]   — odd real do mercado vencedor (se houver
 *                                          alguma fonte futura), só para o flag VALUE
 *
 * @returns {object|null} — null se reprovado ou score < 75 (grade D); senão:
 *   {
 *     market: 'Vitória da Casa' | 'Vitória do Visitante',
 *     score, grade,                 // grade só pode ser 'A+', 'A', 'B' ou 'C'
 *     favoredTeam, opponentTeam,
 *     coverage, breakdown,
 *     oddJusta, isValue,
 *     rejected: false
 *   }
 *   Use computeWcResultadoFinalDebug() para ver o motivo de rejeição.
 */
function computeWcResultadoFinal(input = {}) {
  const result = computeWcResultadoFinalDebug(input);
  if (!result || result.rejected || !['A+', 'A', 'B', 'C'].includes(result.grade)) return null;
  const { rejected, rejectReason, ...approved } = result;
  return approved;
}

function computeWcResultadoFinalDebug({ raw, homeFormString = null, awayFormString = null, manualContext = {}, oddOferecida = null, homeBalanced = null, awayBalanced = null, balancedWin = null } = {}) {
  if (!raw) return { rejected: true, rejectReason: 'raw ausente' };

  // [NOVO] Probabilidades balanceadas casa+fora (True Signal) têm prioridade
  // sobre o pred.percent bruto da API quando disponíveis — elimina o viés
  // de time que jogou mais em casa/fora do que do outro lado.
  const winHome = balancedWin ? balancedWin.win_home : num(raw.win_home);
  const winDraw = balancedWin ? balancedWin.win_draw : num(raw.win_draw);
  const winAway = balancedWin ? balancedWin.win_away : num(raw.win_away);

  if (winHome === null || winAway === null) {
    return { rejected: true, rejectReason: 'sem probabilidades (win_home/win_away ausentes)' };
  }

  // ── GATE #2 — Probabilidade de empate ───────────────────────────────────
  if (winDraw !== null && winDraw > GATE.MAX_DRAW_PROB) {
    return { rejected: true, rejectReason: `draw_probability ${winDraw}% > ${GATE.MAX_DRAW_PROB}%` };
  }

  // ── GATE #1 — Probabilidade mínima + vantagem (jogos equilibrados caem aqui) ─
  let side = null; // 'home' | 'away'
  if (winHome >= GATE.MIN_WIN_PROB && (winHome - winAway) >= GATE.MIN_MARGIN) side = 'home';
  else if (winAway >= GATE.MIN_WIN_PROB && (winAway - winHome) >= GATE.MIN_MARGIN) side = 'away';

  if (!side || Math.abs(winHome - winAway) < GATE.MIN_MARGIN) {
    return { rejected: true, rejectReason: `jogo equilibrado — nenhum lado atinge ${GATE.MIN_WIN_PROB}% + ${GATE.MIN_MARGIN}pp de vantagem` };
  }

  const favoredTeam  = side === 'home' ? raw.home_team : raw.away_team;
  const opponentTeam = side === 'home' ? raw.away_team : raw.home_team;
  const winFav       = side === 'home' ? winHome : winAway;
  const winOpp       = side === 'home' ? winAway : winHome;

  // ── GATE #3 — Motivação ─────────────────────────────────────────────────
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
  if (ctxFav.unpredictable) {
    return { rejected: true, rejectReason: `${favoredTeam} — marcado como imprevisível (manualContext)` };
  }

  // ── Coleta de dados por critério ────────────────────────────────────────
  const powerFav = getTeamPower(favoredTeam);
  const powerOpp = getTeamPower(opponentTeam);

  const rankFav = getFifaRank(favoredTeam);
  const rankOpp = getFifaRank(opponentTeam);

  const formFav = side === 'home' ? num(raw.home_form_score) : num(raw.away_form_score);
  const formOpp = side === 'home' ? num(raw.away_form_score) : num(raw.home_form_score);

  const gfFav = side === 'home'
    ? (homeBalanced?.balancedAttack ?? num(raw.avg_sc_h))
    : (awayBalanced?.balancedAttack ?? num(raw.avg_sc_a));
  const gaOpp = side === 'home'
    ? (awayBalanced?.balancedDefense ?? num(raw.away_avg_conc_away))
    : (homeBalanced?.balancedDefense ?? num(raw.home_avg_conc_home));

  const formStrFav = side === 'home' ? homeFormString : awayFormString;

  // ── Subscores por critério ──────────────────────────────────────────────
  const subscores = {
    probabilidade: scoreProbabilidade(winFav, winOpp),
    formaRecente:  scoreFormaRecente(formFav, formOpp),
    fifaRanking:   scoreFifaRanking(rankFav, rankOpp),
    valorElenco:   scoreValorElenco(powerFav.marketValueM, powerOpp.marketValueM),
    ataqueDefesa:  scoreAtaqueDefesa(gfFav, gaOpp),
    consistencia:  scoreConsistencia(formStrFav),
  };

  // ── Agregação ponderada com redistribuição de peso ──────────────────────
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
  const coverage = Math.round((availableWeight / totalWeight) * 1000) / 10; // %

  if (availableWeight === 0) {
    return { rejected: true, rejectReason: 'nenhum critério com dado disponível' };
  }

  const rawScore = weightedSum / availableWeight;

  // ── Desfalques (penalidade fora do pool de 100) ─────────────────────────
  const missingFav = ctxFav.missingKeyPlayers || {};
  const missingOpp = ctxOpp.missingKeyPlayers || {};
  const favMissingCount = ['strikerOut', 'goalkeeperOut', 'centerBackOut'].filter(k => missingFav[k]).length;
  const oppMissingCount = ['strikerOut', 'goalkeeperOut', 'centerBackOut'].filter(k => missingOpp[k]).length;
  const desfalquePenalty = Math.min(favMissingCount * DESFALQUE_PENALTY_EACH, DESFALQUE_PENALTY_MAX);
  const desfalqueBonus   = Math.min(oppMissingCount * OPPONENT_DESFALQUE_BONUS_EACH, OPPONENT_DESFALQUE_BONUS_MAX);

  const finalScore = clamp(rawScore - desfalquePenalty + desfalqueBonus);

  // ── Classificação ────────────────────────────────────────────────────────
  let grade;
  if (coverage < MIN_COVERAGE) {
    grade = 'C'; // sem dado real suficiente — trava, nunca aprova
  } else if (
    finalScore >= 90 &&
    winFav >= ELITE_GATE.MIN_WIN_PROB &&
    (winFav - winOpp) >= ELITE_GATE.MIN_MARGIN &&
    (winDraw === null || winDraw <= ELITE_GATE.MAX_DRAW_PROB) &&
    (subscores.fifaRanking !== null && subscores.fifaRanking >= ELITE_GATE.MIN_FIFA_SCORE) &&
    (subscores.valorElenco !== null && subscores.valorElenco >= ELITE_GATE.MIN_ELENCO_SCORE)
  ) {
    grade = 'A+';
  } else if (finalScore >= 85) grade = 'A';
  else if (finalScore >= 80)   grade = 'B';
  else if (finalScore >= 75)   grade = 'C';
  else                          grade = 'D';

  const oddJusta = calcOddJusta(winFav);
  const isValue  = calcIsValue(oddOferecida, oddJusta);

  return {
    rejected: false,
    rejectReason: null,
    market: side === 'home' ? 'Vitória da Casa' : 'Vitória do Visitante',
    score: Math.round(finalScore * 10) / 10,
    grade,
    favoredTeam,
    opponentTeam,
    winFav: Math.round(winFav * 10) / 10,
    winOpp: Math.round(winOpp * 10) / 10,
    margin: Math.round((winFav - winOpp) * 10) / 10,
    drawProbability: winDraw,
    fifaRankFav: rankFav,
    fifaRankOpp: rankOpp,
    coverage,
    desfalquePenalty,
    desfalqueBonus,
    oddJusta,
    isValue,
    breakdown,
  };
}

module.exports = {
  computeWcResultadoFinal,
  computeWcResultadoFinalDebug,
  WORLD_CUP_LEAGUE_NAMES,
  WEIGHTS,
  GATE,
  ELITE_GATE,
  MIN_COVERAGE,
};
