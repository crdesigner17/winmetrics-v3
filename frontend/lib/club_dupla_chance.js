/**
 * WinMetrics V3 — Mercado "Dupla Chance" (1X / X2) — Clubes/Ligas
 * ─────────────────────────────────────────────────────────────────────────────
 * Motor PADRÃO para todos os campeonatos que NÃO são Copa do Mundo. Aposta de
 * proteção: cobre vitória do favorito OU empate. Usado como mercado de
 * proteção, não como aposta forçada — prioridade é assertividade.
 *
 * ISOLADO do motor da Copa (wc_dupla_chance.js) — SEM Ranking FIFA e SEM
 * valor de mercado de seleção.
 *
 * Separação obrigatória (aplicada em generate_predictions.js):
 *   if (WORLD_CUP_LEAGUE_NAMES.includes(raw.league_name)) usa wc_dupla_chance.js
 *   else                                                   usa ESTE arquivo
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CRITÉRIOS OBRIGATÓRIOS (gates)
 *
 *   #1 non_lose_probability = win_fav% + draw_probability%  >= 80%
 *   #2 draw_probability >= 18%  → abaixo disso, reprovado
 *   #3 Forma recente da equipe protegida >= 55%
 *   #4 Equipe protegida com 3+ derrotas nos últimos 5 jogos → reprovado
 *      (ou seja, máximo permitido é 2)
 *   #5 Adversário sem grande superioridade ofensiva (gols marcados/jogo
 *      do adversário < 2.0) → senão reprovado
 *   #6 Adversário em forte sequência positiva (3+ vitórias seguidas)
 *      → reprovado
 *   #7 Equipe protegida sofre média > 1.7 gols/jogo → reprovado
 *   #8 Diferença entre probabilidades muito baixa e sem vantagem clara
 *      (abs(home - away) < 5pp) → reprovado
 *   #9 PPG: ppg_difference (protegida - adversário) < 0.15 → reprovado
 *   #10 Dados insuficientes (sem probabilidades ou sem PPG de nenhum lado)
 *       → reprovado
 *
 * CRITÉRIOS DE SCORE (pool ponderado, 0-100, redistribuído quando faltar dado)
 *   Probabilidade (não perder)  35%   Forma recente  20%   PPG          15%
 *   Casa/Fora                   15%   Defesa         10%   Adversário    5%
 *
 * CLASSIFICAÇÃO
 *   A+ score >= 90   A  85-89   B  80-84   C  70-79   D  < 70
 *   Exibe A+, A, B e C (score >= 70) — só D fica de fora.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

const GATE = {
  MIN_NON_LOSE_PROB:  80,
  MIN_DRAW_PROB:      18,
  MIN_FORMA_FAV:      55,
  MAX_LOSSES_LAST5:    2,  // 3+ derrotas reprova → máximo permitido é 2
  MAX_OPP_ATTACK:    2.0,  // gols/jogo do adversário ("grande superioridade ofensiva")
  MAX_OPP_TRAILING_WINS: 2, // 3+ vitórias seguidas do adversário reprova
  MAX_GA_FAV:        1.7,  // gols sofridos/jogo da equipe protegida
  MIN_PROB_GAP:         5, // diferença mínima entre probabilidades para "vantagem clara"
  MIN_PPG_DIFF:      0.15,
};

// "Histórico CSV" é reforço estatístico do PackBall (frontend/data/packball/
// DD-MM/) — nunca aprova sozinho, nunca substitui o dado ao vivo, só reforça
// ou enfraquece a confiança (mesmo princípio do club_resultado_final.js).
// Pra abrir os 10% sem mexer em Probabilidade/Forma/PPG (critérios centrais),
// tirei 5pp de Casa/Fora e 5pp de Defesa.
const WEIGHTS = {
  probabilidade: 35,
  formaRecente:  20,
  ppg:           15,
  casaFora:      10,
  defesa:         5,
  adversario:     5,
  historicoCsv:  10,
};

const MIN_COVERAGE = 55;

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

/** Últimos 5 resultados (mais recente = último char) — losses/trailingWins. */
function analyzeLast5(formString) {
  if (!formString || typeof formString !== 'string') return null;
  const chars = formString.toUpperCase().split('').filter(c => ['W', 'D', 'L'].includes(c));
  if (!chars.length) return null;
  const last5 = chars.slice(-5);
  let trailingWins = 0;
  for (let i = last5.length - 1; i >= 0; i--) {
    if (last5[i] === 'W') trailingWins++;
    else break;
  }
  return {
    last5,
    losses: last5.filter(c => c === 'L').length,
    trailingWins,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCORES — 0-100, favorável ao lado PROTEGIDO, null se faltar dado
// ─────────────────────────────────────────────────────────────────────────────

// Probabilidade (não perder) — 35%
function scoreProbabilidade(nonLose) {
  if (nonLose === null) return null;
  return clamp(50 + (nonLose - GATE.MIN_NON_LOSE_PROB) * 2.5);
}

// Forma recente — 20%
function scoreFormaRecente(formFav, formOpp) {
  if (formFav === null && formOpp === null) return null;
  let s = 50;
  if (formFav !== null) {
    if (formFav >= 75)      s += 25;
    else if (formFav >= 55) s += 15;
    else                     s -= 15;
  }
  if (formOpp !== null) {
    if (formOpp <= 45)      s += 10;
    else if (formOpp > 65)  s -= 10;
  }
  return clamp(s);
}

// PPG — 15%. Mesma régua geral do adendo (compartilhada com o Vencer/Vencer).
function scorePPG(ppgDifference) {
  if (ppgDifference === null) return null;
  if (ppgDifference >= 0.50) return 90;
  if (ppgDifference >= 0.30) return 75;
  if (ppgDifference >= 0.15) return 55;
  return 30; // defensivo — não deveria chegar aqui (já reprovado pelo gate)
}

// Casa/Fora — 15%
function scoreCasaFora(perfFav, perfOpp) {
  if (perfFav === null && perfOpp === null) return null;
  let s = 50;
  if (perfFav !== null) {
    if (perfFav >= 60)      s += 20;
    else if (perfFav >= 45) s += 8;
    else                     s -= 15;
  }
  if (perfOpp !== null) {
    if (perfOpp <= 35)      s += 12;
    else if (perfOpp > 60)  s -= 12;
  }
  return clamp(s);
}

// Defesa — 10%. goals_conceded_avg da equipe protegida.
function scoreDefesa(gaFav) {
  if (gaFav === null) return null;
  if (gaFav <= 0.9) return 100;
  if (gaFav <= 1.2) return 80;
  if (gaFav <= 1.7) return 55;
  return 30;
}

// Adversário — 5%. Pontua positivamente baixa eficiência ofensiva e ausência
// de sequência positiva do adversário (tudo isso é bom pra "não perder").
function scoreAdversario(gfOpp, trailingWinsOpp) {
  if (gfOpp === null && trailingWinsOpp === null) return null;
  let s = 50;
  if (gfOpp !== null) {
    if (gfOpp < 1.0)        s += 20;
    else if (gfOpp >= 1.6)  s -= 15;
  }
  if (trailingWinsOpp !== null) {
    if (trailingWinsOpp === 0) s += 15;
    else if (trailingWinsOpp >= 2) s -= 15;
  }
  return clamp(s);
}

// Histórico CSV — 10%. Reforço estatístico do PackBall (frontend/data/
// packball/DD-MM/*.csv). Recebe o objeto CSV BRUTO (apiData.packballCSV,
// antes do merge feito por applyCsvToRaw em raw) — compara PPG/ataque do
// CSV com o lado protegido: concorda → reforça a confiança; diverge →
// reduz; sem CSV suficiente pro dia/fixture → null (peso redistribuído,
// sem penalização). Mesma lógica do club_resultado_final.js.
function scoreHistoricoCSV(csvData, side) {
  if (!csvData) return null;
  const csvPpgFav = side === 'home' ? num(csvData.ppg_h)    : num(csvData.ppg_a);
  const csvPpgOpp = side === 'home' ? num(csvData.ppg_a)    : num(csvData.ppg_h);
  const csvScFav  = side === 'home' ? num(csvData.avg_sc_h) : num(csvData.avg_sc_a);

  if (csvPpgFav === null && csvPpgOpp === null && csvScFav === null) return null;

  let s = 50;
  if (csvPpgFav !== null && csvPpgOpp !== null) {
    const csvDiff = csvPpgFav - csvPpgOpp;
    if (csvDiff >= 0.30)      s += 25; // histórico CSV confirma a vantagem da protegida
    else if (csvDiff >= 0.15) s += 12;
    else if (csvDiff < 0)     s -= 20; // histórico CSV aponta o contrário do modelo ao vivo
  }
  if (csvScFav !== null) {
    if (csvScFav >= 1.5)      s += 10;
    else if (csvScFav < 1.0)  s -= 8;
  }
  return clamp(s);
}

/**
 * computeClubDuplaChance(input)
 *
 * @param {object} input
 * @param {object} input.raw
 * @param {string} [input.homeFormString]
 * @param {string} [input.awayFormString]
 * @param {object} [input.csvData]        — apiData.packballCSV BRUTO (antes do
 *                                          merge applyCsvToRaw), usado só como
 *                                          reforço estatístico (10% do score,
 *                                          nunca aprova sozinho, nunca substitui
 *                                          o dado ao vivo). Omitir quando não
 *                                          houver CSV pro dia/fixture.
 *
 * @returns {object|null} — null se reprovado ou score < 80; senão:
 *   {
 *     market: 'Dupla Chance 1X' | 'Dupla Chance X2',
 *     score, grade,               // grade só pode ser 'A+', 'A', 'B' ou 'C'
 *     favoredTeam, opponentTeam, nonLoseProbability, ppgDifference,
 *     coverage, breakdown,
 *     rejected: false
 *   }
 *   Use computeClubDuplaChanceDebug() para ver o motivo de rejeição.
 */
function computeClubDuplaChance(input = {}) {
  const result = computeClubDuplaChanceDebug(input);
  if (!result || result.rejected || !['A+', 'A', 'B', 'C'].includes(result.grade)) return null;
  const { rejected, rejectReason, ...approved } = result;
  return approved;
}

function computeClubDuplaChanceDebug({ raw, homeFormString = null, awayFormString = null, csvData = null } = {}) {
  if (!raw) return { rejected: true, rejectReason: 'raw ausente' };

  const winHome = num(raw.win_home);
  const winDraw = num(raw.win_draw);
  const winAway = num(raw.win_away);
  const ppgHome = num(raw.ppg_h);
  const ppgAway = num(raw.ppg_a);

  if (winHome === null || winAway === null) {
    return { rejected: true, rejectReason: 'sem probabilidades (win_home/win_away ausentes)' };
  }
  if (winDraw === null) {
    return { rejected: true, rejectReason: 'sem draw_probability — não dá pra calcular non_lose_probability' };
  }
  if (ppgHome === null && ppgAway === null) {
    return { rejected: true, rejectReason: 'sem PPG de nenhum lado — dados insuficientes' };
  }

  // ── GATE #2 — draw_probability >= 18% ────────────────────────────────────
  if (winDraw < GATE.MIN_DRAW_PROB) {
    return { rejected: true, rejectReason: `draw_probability ${winDraw}% < ${GATE.MIN_DRAW_PROB}%` };
  }

  // ── GATE #8 — Diferença mínima entre probabilidades ──────────────────────
  if (Math.abs(winHome - winAway) < GATE.MIN_PROB_GAP) {
    return { rejected: true, rejectReason: `diferença entre probabilidades muito baixa (abs < ${GATE.MIN_PROB_GAP}pp) — sem vantagem clara` };
  }

  // Favorito = lado com maior probabilidade de vitória.
  const side = winHome >= winAway ? 'home' : 'away';
  const favoredTeam  = side === 'home' ? raw.home_team : raw.away_team;
  const opponentTeam = side === 'home' ? raw.away_team : raw.home_team;
  const winFav       = side === 'home' ? winHome : winAway;

  const nonLoseProbability = Math.round((winFav + winDraw) * 10) / 10;

  // ── GATE #1 — non_lose_probability >= 80% ────────────────────────────────
  if (nonLoseProbability < GATE.MIN_NON_LOSE_PROB) {
    return { rejected: true, rejectReason: `non_lose_probability ${nonLoseProbability}% < ${GATE.MIN_NON_LOSE_PROB}%` };
  }

  // ── GATE #3 — Forma recente mínima da equipe protegida ───────────────────
  const formFav = side === 'home' ? num(raw.home_form_score) : num(raw.away_form_score);
  const formOpp = side === 'home' ? num(raw.away_form_score) : num(raw.home_form_score);
  if (formFav !== null && formFav < GATE.MIN_FORMA_FAV) {
    return { rejected: true, rejectReason: `${favoredTeam} forma recente ${formFav}% < ${GATE.MIN_FORMA_FAV}%` };
  }

  const formStrFav = side === 'home' ? homeFormString : awayFormString;
  const formStrOpp = side === 'home' ? awayFormString : homeFormString;

  // ── GATE #4 — Máximo 2 derrotas nos últimos 5 jogos da protegida ─────────
  const last5Fav = analyzeLast5(formStrFav);
  if (last5Fav && last5Fav.losses > GATE.MAX_LOSSES_LAST5) {
    return { rejected: true, rejectReason: `${favoredTeam} teve ${last5Fav.losses} derrotas nos últimos 5 jogos (máx. ${GATE.MAX_LOSSES_LAST5})` };
  }

  // ── GATE #6 — Adversário em forte sequência positiva ─────────────────────
  const last5Opp = analyzeLast5(formStrOpp);
  if (last5Opp && last5Opp.trailingWins > GATE.MAX_OPP_TRAILING_WINS) {
    return { rejected: true, rejectReason: `${opponentTeam} em sequência de ${last5Opp.trailingWins} vitórias seguidas` };
  }

  const gfOpp = side === 'home' ? num(raw.avg_sc_a)            : num(raw.avg_sc_h);
  const gaFav = side === 'home' ? num(raw.home_avg_conc_home) : num(raw.away_avg_conc_away);

  // ── GATE #5 — Adversário sem grande superioridade ofensiva ───────────────
  if (gfOpp !== null && gfOpp >= GATE.MAX_OPP_ATTACK) {
    return { rejected: true, rejectReason: `${opponentTeam} ataque ${gfOpp} gols/jogo >= ${GATE.MAX_OPP_ATTACK} (superioridade ofensiva)` };
  }

  // ── GATE #7 — Defesa da protegida não pode sofrer demais ─────────────────
  if (gaFav !== null && gaFav > GATE.MAX_GA_FAV) {
    return { rejected: true, rejectReason: `${favoredTeam} sofre ${gaFav} gols/jogo > ${GATE.MAX_GA_FAV}` };
  }

  // ── GATE #9 — PPG: vantagem mínima da equipe protegida ───────────────────
  const ppgFav = side === 'home' ? ppgHome : ppgAway;
  const ppgOpp = side === 'home' ? ppgAway : ppgHome;
  const ppgDifference = (ppgFav !== null && ppgOpp !== null) ? Math.round((ppgFav - ppgOpp) * 100) / 100 : null;
  if (ppgDifference !== null && ppgDifference < GATE.MIN_PPG_DIFF) {
    return { rejected: true, rejectReason: `ppg_difference ${ppgDifference} < ${GATE.MIN_PPG_DIFF}` };
  }

  const perfFav = side === 'home' ? num(raw.home_home_perf) : num(raw.away_away_perf);
  const perfOpp = side === 'home' ? num(raw.away_away_perf) : num(raw.home_home_perf);

  // ── Subscores ─────────────────────────────────────────────────────────
  const subscores = {
    probabilidade: scoreProbabilidade(nonLoseProbability),
    formaRecente:  scoreFormaRecente(formFav, formOpp),
    ppg:           scorePPG(ppgDifference),
    casaFora:      scoreCasaFora(perfFav, perfOpp),
    defesa:        scoreDefesa(gaFav),
    adversario:    scoreAdversario(gfOpp, last5Opp ? last5Opp.trailingWins : null),
    historicoCsv:  scoreHistoricoCSV(csvData, side),
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

  let grade;
  if (coverage < MIN_COVERAGE) grade = 'D';
  else if (finalScore >= 90)   grade = 'A+';
  else if (finalScore >= 85)   grade = 'A';
  else if (finalScore >= 80)   grade = 'B';
  else if (finalScore >= 70)   grade = 'C';
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
    ppgDifference,
    last5LossesFav: last5Fav ? last5Fav.losses : null,
    coverage,
    breakdown,
  };
}

module.exports = {
  computeClubDuplaChance,
  computeClubDuplaChanceDebug,
  WEIGHTS,
  GATE,
  MIN_COVERAGE,
};
