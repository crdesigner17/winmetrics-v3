/**
 * WinMetrics V3 — Mercado "Vencer / Vencer" (Resultado Final 1X2) — Clubes/Ligas
 * ─────────────────────────────────────────────────────────────────────────────
 * Motor PADRÃO para todos os campeonatos que NÃO são Copa do Mundo (Premier
 * League, La Liga, Serie A, Bundesliga, Ligue 1, Brasileirão, Libertadores,
 * Champions League, Europa League, MLS, Eliminatórias, Copa América, Nations
 * League, e qualquer outra liga/competição de clubes ou seleções fora do
 * torneio mundial).
 *
 * ISOLADO do motor da Copa (wc_resultado_final.js) — SEM Ranking FIFA e SEM
 * valor de mercado de seleção. Usa só dado real de clube/liga já disponível
 * no pipeline via packball_mapper.js: probabilidade do modelo, forma recente,
 * PPG, desempenho casa/fora, ataque/defesa, momento (sequência) e H2H.
 *
 * Separação obrigatória (aplicada em generate_predictions.js):
 *   if (WORLD_CUP_LEAGUE_NAMES.includes(raw.league_name)) usa wc_resultado_final.js
 *   else                                                   usa ESTE arquivo
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CRITÉRIOS OBRIGATÓRIOS (gates)
 *
 *   #1 Vitória Casa: home_win_probability >= 58% E vantagem >= 12pp sobre away
 *      Vitória Fora:  away_win_probability >= 58% E vantagem >= 12pp sobre home
 *      (cobre também "diferença < 12% reprova" — é a mesma checagem)
 *   #2 draw_probability > 28%  → reprovado
 *   #3 home_team_form / away_team_form (do favorito) >= 60%  → senão reprovado
 *   #4 Casa/Fora: favorito precisa de desempenho positivo no seu mando
 *      (home_home_perf ou away_away_perf >= 50%) E o adversário precisa
 *      estar fraco/irregular no mando dele (<= 45%) — senão reprovado
 *   #5 Favorito com 2+ derrotas nos últimos 5 jogos → reprovado
 *   #6 Favorito com ataque < 1.2 gols/jogo → reprovado
 *   #7 Adversário com defesa muito sólida (<= 0.8 gols sofridos/jogo no seu
 *      mando) → reprovado (interpretação numérica do critério qualitativo)
 *   #8 PPG: combined_ppg = favorito_ppg - adversário_ppg < 0.15 → reprovado
 *   #9 Dados insuficientes (sem probabilidades ou sem PPG de nenhum lado)
 *      → reprovado
 *
 *   NÃO implementado por falta de dado no pipeline (documentado, não
 *   fabricado): detecção de "clássico/rivalidade equilibrada" — não há fonte
 *   de rivalidade no pipeline hoje. H2H real (quem historicamente vence) —
 *   só temos h2h_goals (média de gols), não vitórias/derrotas H2H, então o
 *   subscore de H2H fica null (peso redistribuído) até essa fonte existir.
 *
 * CRITÉRIOS DE SCORE (pool ponderado, 0-100, redistribuído quando faltar dado)
 *   Probabilidade  30%   Forma recente  20%   PPG            15%
 *   Casa/Fora      15%   Ataque/Defesa  10%   Tabela/Momento  5%   H2H  5%
 *
 * CLASSIFICAÇÃO
 *   A+ score >= 90   A  85-89   B  75-84   C  65-74   D  < 65
 *   Exibe A+, A, B e C (score >= 65) — só D fica de fora. Cada grade tem cor
 *   própria no frontend (A+ verde, A dourado, B azul, C roxo).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

const GATE = {
  MIN_WIN_PROB:        58,
  MIN_MARGIN:          12,
  MAX_DRAW_PROB:        28,
  MIN_FORM_FAV:         60,
  MIN_HOME_AWAY_PERF:   50,  // desempenho do favorito no seu próprio mando ("positivo")
  MAX_OPP_HOME_AWAY_PERF: 45, // desempenho do adversário no mando dele ("fraco/irregular")
  MAX_LOSSES_LAST5:      1,  // 2+ derrotas reprova → máximo permitido é 1
  MIN_ATTACK_FAV:      1.2,  // gols/jogo
  MAX_DEF_SOLID_OPP:   0.8,  // gols sofridos/jogo do adversário no mando dele ("defesa muito sólida")
  MIN_COMBINED_PPG:   0.15,
};

const B_FORTE_MIN_SCORE = 78; // só aprova grade B quando score >= 78

// Pesos somam 100. Quando um critério não tem dado disponível, seu peso é
// redistribuído proporcionalmente entre os critérios que têm dado real.
// "Histórico CSV" é reforço estatístico do PackBall (dados em
// frontend/data/packball/DD-MM/) — nunca aprova sozinho (é só 10% do pool,
// fora de qualquer gate) e nunca substitui o dado ao vivo: ele compara o
// PPG/ataque do CSV com o já calculado pela API, e só reforça ou enfraquece
// a confiança. Quando não há CSV pro dia/fixture, o critério fica null e o
// peso é redistribuído — sem penalizar.
const WEIGHTS = {
  probabilidade: 30,
  formaRecente:  20,
  ppg:           15,
  casaFora:      10,
  ataqueDefesa:  10,
  h2h:            5,
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
    losses:       last5.filter(c => c === 'L').length,
    trailingWins, // sequência positiva atual — usado como proxy de "momento"
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCORES — 0-100, favorável ao FAVORITO, null se faltar dado
// ─────────────────────────────────────────────────────────────────────────────

// Probabilidade — 30%
function scoreProbabilidade(winFav, winOpp) {
  if (winFav === null || winOpp === null) return null;
  const margin = winFav - winOpp;
  return clamp(50 + (winFav - GATE.MIN_WIN_PROB) * 1.3 + (margin - GATE.MIN_MARGIN) * 1.0);
}

// Forma recente — 20%
function scoreFormaRecente(formFav, formOpp) {
  if (formFav === null && formOpp === null) return null;
  let s = 50;
  if (formFav !== null) {
    if (formFav >= 80)      s += 25;
    else if (formFav >= 60) s += 15;
    else                     s -= 15;
  }
  if (formOpp !== null) {
    if (formOpp <= 40)      s += 10;
    else if (formOpp > 65)  s -= 10;
  }
  return clamp(s);
}

// PPG — 15%. Tiers oficiais do adendo (aplica-se a ambos os mercados):
//   >=0.80 muito forte / >=0.50 forte / >=0.30 favorável / >=0.15 leve vantagem
function scorePPG(combinedPpg) {
  if (combinedPpg === null) return null;
  if (combinedPpg >= 0.80) return 100;
  if (combinedPpg >= 0.50) return 90;
  if (combinedPpg >= 0.30) return 75;
  if (combinedPpg >= 0.15) return 55;
  return 30; // defensivo — não deveria chegar aqui (já reprovado pelo gate)
}

// Casa/Fora — 15%. Usa home_home_perf / away_away_perf (% vitórias no mando específico).
function scoreCasaFora(perfFav, perfOpp) {
  if (perfFav === null && perfOpp === null) return null;
  let s = 50;
  if (perfFav !== null) {
    if (perfFav >= 65)      s += 25;
    else if (perfFav >= 50) s += 12;
    else                     s -= 15;
  }
  if (perfOpp !== null) {
    if (perfOpp <= 35)      s += 15;
    else if (perfOpp > 55)  s -= 15;
  }
  return clamp(s);
}

// Ataque/Defesa — 10%
function scoreAtaqueDefesa(gfFav, gaOpp) {
  if (gfFav === null && gaOpp === null) return null;
  let s = 50;
  if (gfFav !== null) {
    if (gfFav >= 1.8)       s += 20;
    else if (gfFav >= 1.2)  s += 8;
    else                     s -= 15;
  }
  if (gaOpp !== null) {
    if (gaOpp >= 1.4)       s += 20;
    else if (gaOpp < 0.8)   s -= 15;
  }
  return clamp(s);
}

// Histórico CSV — 10%. Reforço estatístico do PackBall (frontend/data/
// packball/DD-MM/*.csv). Recebe o objeto CSV BRUTO (apiData.packballCSV,
// antes do merge feito por applyCsvToRaw em raw) — assim a comparação é
// sempre contra o dado independente do CSV, nunca contra um valor que já
// foi sobrescrito. Compara PPG e ataque do CSV com o que o modelo ao vivo
// já calculou: concorda → reforça a confiança; diverge → reduz; sem CSV
// suficiente pro dia/fixture → null (peso redistribuído, sem penalização).
function scoreHistoricoCSV(csvData, side) {
  if (!csvData) return null;
  const csvPpgFav = side === 'home' ? num(csvData.ppg_h)    : num(csvData.ppg_a);
  const csvPpgOpp = side === 'home' ? num(csvData.ppg_a)    : num(csvData.ppg_h);
  const csvScFav  = side === 'home' ? num(csvData.avg_sc_h) : num(csvData.avg_sc_a);

  if (csvPpgFav === null && csvPpgOpp === null && csvScFav === null) return null;

  let s = 50;
  if (csvPpgFav !== null && csvPpgOpp !== null) {
    const csvDiff = csvPpgFav - csvPpgOpp;
    if (csvDiff >= 0.30)      s += 25; // histórico CSV confirma a vantagem do favorito
    else if (csvDiff >= 0.15) s += 12;
    else if (csvDiff < 0)     s -= 20; // histórico CSV aponta o contrário do modelo ao vivo
  }
  if (csvScFav !== null) {
    if (csvScFav >= 1.5)      s += 10;
    else if (csvScFav < 1.0)  s -= 8;
  }
  return clamp(s);
}

// H2H — 5%. Sem fonte de vitórias/derrotas H2H no pipeline hoje (só h2h_goals,
// que é média de gols, não direção de favoritismo) — sempre null por enquanto.
function scoreH2H(_h2hGoals) {
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * computeClubResultadoFinal(input)
 *
 * @param {object} input
 * @param {object} input.raw              — objeto raw já mapeado (PackBallMapper)
 * @param {string} [input.homeFormString]
 * @param {string} [input.awayFormString]
 * @param {object} [input.csvData]        — apiData.packballCSV BRUTO (antes do
 *                                          merge applyCsvToRaw), usado só como
 *                                          reforço estatístico (10% do score,
 *                                          nunca aprova sozinho, nunca substitui
 *                                          o dado ao vivo). Omitir quando não
 *                                          houver CSV pro dia/fixture.
 *
 * @returns {object|null} — null se reprovado ou não aprovado; senão:
 *   {
 *     market: 'Vitória da Casa' | 'Vitória do Visitante',
 *     score, grade,                 // grade só pode ser 'A+', 'A', 'B' ou 'C'
 *     favoredTeam, opponentTeam, combinedPpg,
 *     coverage, breakdown,
 *     rejected: false
 *   }
 *   Use computeClubResultadoFinalDebug() para ver o motivo de rejeição.
 */
function computeClubResultadoFinal(input = {}) {
  const result = computeClubResultadoFinalDebug(input);
  if (!result || result.rejected) return null;
  if (['A+', 'A', 'B', 'C'].includes(result.grade)) {
    const { rejected, rejectReason, ...approved } = result;
    return approved;
  }
  return null;
}

function computeClubResultadoFinalDebug({ raw, homeFormString = null, awayFormString = null, csvData = null, homeBalanced = null, awayBalanced = null, balancedWin = null } = {}) {
  if (!raw) return { rejected: true, rejectReason: 'raw ausente' };

  // [NOVO] Probabilidades e PPG balanceados casa+fora (True Signal) têm
  // prioridade sobre o dado bruto da API quando disponíveis.
  const winHome = balancedWin ? balancedWin.win_home : num(raw.win_home);
  const winDraw = balancedWin ? balancedWin.win_draw : num(raw.win_draw);
  const winAway = balancedWin ? balancedWin.win_away : num(raw.win_away);
  const ppgHome = homeBalanced?.balancedPpg ?? num(raw.ppg_h);
  const ppgAway = awayBalanced?.balancedPpg ?? num(raw.ppg_a);

  if (winHome === null || winAway === null) {
    return { rejected: true, rejectReason: 'sem probabilidades (win_home/win_away ausentes)' };
  }
  if (ppgHome === null && ppgAway === null) {
    return { rejected: true, rejectReason: 'sem PPG de nenhum lado — dados insuficientes' };
  }

  // ── GATE #2 — Probabilidade de empate ───────────────────────────────────
  if (winDraw !== null && winDraw > GATE.MAX_DRAW_PROB) {
    return { rejected: true, rejectReason: `draw_probability ${winDraw}% > ${GATE.MAX_DRAW_PROB}%` };
  }

  // ── GATE #1 — Probabilidade mínima + vantagem (jogo equilibrado cai aqui) ─
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

  // ── GATE #3 — Forma recente mínima do favorito ──────────────────────────
  const formFav = side === 'home' ? num(raw.home_form_score) : num(raw.away_form_score);
  const formOpp = side === 'home' ? num(raw.away_form_score) : num(raw.home_form_score);
  if (formFav !== null && formFav < GATE.MIN_FORM_FAV) {
    return { rejected: true, rejectReason: `${favoredTeam} forma recente ${formFav}% < ${GATE.MIN_FORM_FAV}%` };
  }

  // ── GATE #4 — Casa/Fora: favorito positivo no mando, adversário fraco ───
  const perfFav = side === 'home' ? num(raw.home_home_perf) : num(raw.away_away_perf);
  const perfOpp = side === 'home' ? num(raw.away_away_perf) : num(raw.home_home_perf);
  if (perfFav !== null && perfFav < GATE.MIN_HOME_AWAY_PERF) {
    return { rejected: true, rejectReason: `${favoredTeam} desempenho no mando ${perfFav}% < ${GATE.MIN_HOME_AWAY_PERF}%` };
  }
  if (perfOpp !== null && perfOpp > GATE.MAX_OPP_HOME_AWAY_PERF) {
    return { rejected: true, rejectReason: `${opponentTeam} desempenho no mando ${perfOpp}% > ${GATE.MAX_OPP_HOME_AWAY_PERF}% (não está fraco/irregular)` };
  }

  const formStrFav = side === 'home' ? homeFormString : awayFormString;

  // ── GATE #5 — Favorito com 2+ derrotas nos últimos 5 ────────────────────
  const last5Fav = analyzeLast5(formStrFav);
  if (last5Fav && last5Fav.losses > GATE.MAX_LOSSES_LAST5) {
    return { rejected: true, rejectReason: `${favoredTeam} teve ${last5Fav.losses} derrotas nos últimos 5 jogos (máx. ${GATE.MAX_LOSSES_LAST5})` };
  }

  const gfFav = side === 'home'
    ? (homeBalanced?.balancedAttack ?? num(raw.avg_sc_h))
    : (awayBalanced?.balancedAttack ?? num(raw.avg_sc_a));
  const gaOpp = side === 'home'
    ? (awayBalanced?.balancedDefense ?? num(raw.away_avg_conc_away))
    : (homeBalanced?.balancedDefense ?? num(raw.home_avg_conc_home));

  // ── GATE #6 — Ataque do favorito mínimo ──────────────────────────────────
  if (gfFav !== null && gfFav < GATE.MIN_ATTACK_FAV) {
    return { rejected: true, rejectReason: `${favoredTeam} ataque ${gfFav} gols/jogo < ${GATE.MIN_ATTACK_FAV}` };
  }

  // ── GATE #7 — Defesa do adversário muito sólida ──────────────────────────
  if (gaOpp !== null && gaOpp <= GATE.MAX_DEF_SOLID_OPP) {
    return { rejected: true, rejectReason: `${opponentTeam} defesa muito sólida (${gaOpp} gols sofridos/jogo)` };
  }

  // ── GATE #8 — PPG: vantagem mínima do favorito ───────────────────────────
  const ppgFav = side === 'home' ? ppgHome : ppgAway;
  const ppgOpp = side === 'home' ? ppgAway : ppgHome;
  const combinedPpg = (ppgFav !== null && ppgOpp !== null) ? Math.round((ppgFav - ppgOpp) * 100) / 100 : null;
  if (combinedPpg !== null && combinedPpg < GATE.MIN_COMBINED_PPG) {
    return { rejected: true, rejectReason: `combined_ppg ${combinedPpg} < ${GATE.MIN_COMBINED_PPG} — pouca diferença entre as equipes` };
  }

  // ── Subscores ─────────────────────────────────────────────────────────
  const subscores = {
    probabilidade: scoreProbabilidade(winFav, winOpp),
    formaRecente:  scoreFormaRecente(formFav, formOpp),
    ppg:           scorePPG(combinedPpg),
    casaFora:      scoreCasaFora(perfFav, perfOpp),
    ataqueDefesa:  scoreAtaqueDefesa(gfFav, gaOpp),
    h2h:           scoreH2H(num(raw.h2h_goals)),
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
  else if (finalScore >= 75)   grade = 'B';
  else if (finalScore >= 65)   grade = 'C';
  else                          grade = 'D';

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
    combinedPpg,
    coverage,
    breakdown,
  };
}

module.exports = {
  computeClubResultadoFinal,
  computeClubResultadoFinalDebug,
  WEIGHTS,
  GATE,
  B_FORTE_MIN_SCORE,
  MIN_COVERAGE,
};
