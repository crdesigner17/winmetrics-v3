/**
 * WinMetrics V3 — Mercado "Resultado Final (Vitória)" — Copa do Mundo
 * ─────────────────────────────────────────────────────────────────────────────
 * Motor de scoring EXCLUSIVO para jogos da Copa do Mundo. Objetivo: poucos
 * sinais, porém com máxima assertividade (só aprova A+ e A).
 *
 * ISOLADO — não altera nenhum outro mercado, engine ou liga. Só roda quando
 * chamado explicitamente para fixtures de Copa do Mundo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRANSPARÊNCIA SOBRE FONTES DE DADOS (importante para confiar no score):
 *
 * Critérios com dado 100% REAL e automático (já fluem no pipeline hoje):
 *   #1  Probabilidades (win_home/win_draw/win_away)  — API-Football /predictions
 *   #2  Ranking FIFA                                  — tabela estática datada (11/06/2026)
 *   #3  ELO                                           — tabela estática (top 20 mundial, parcial)
 *   #5  Forma Recente (home_form_score/away_form_score) — API-Football /teams/statistics
 *   #6  Força Ofensiva (avg_sc_h/avg_sc_a)            — API-Football /teams/statistics
 *   #7  Força Defensiva (avg_conc_home/avg_conc_away) — API-Football /teams/statistics
 *   #8  Momentum (sequência via form string)          — API-Football /teams/statistics
 *
 * Critérios SEM fonte automatizada — dependem de frontend/data/wc_manual_context.json,
 * e são PULADOS (não fabricados) quando não preenchidos:
 *   #4  Valor de Mercado    (precisa curadoria manual, ex: Transfermarkt)
 *   #9  Qualidade do Elenco (curadoria manual)
 *   #10 Histórico em Copa   (curadoria manual)
 *   #11 Contexto do Grupo   (curadoria manual, atualizar por rodada)
 *   #12 Desfalques          (curadoria manual, atualizar por rodada)
 *
 * Quando um critério está ausente, seu peso é redistribuído proporcionalmente
 * entre os critérios disponíveis — nunca é tratado como "neutro" silenciosamente
 * disfarçado de dado real. Além disso, exigimos uma COBERTURA MÍNIMA de peso
 * (MIN_COVERAGE) para sequer permitir grade A+/A — jogos com pouquíssimo dado
 * real disponível são automaticamente travados em grade C (não aprovados),
 * mesmo que o score bruto desse alto. Isso evita falsa confiança.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { getTeamPower } = require('../data/wc_team_power.js');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO — limiares e pesos (ajustáveis aqui, em um único lugar)
// ─────────────────────────────────────────────────────────────────────────────

const GATE = {
  MAX_DRAW_PROB:      28,   // rejeita se draw_probability > 28%
  MIN_WIN_PROB:       62,   // exige >= 62% para o lado favorito
  MIN_MARGIN:         15,   // exige vantagem mínima de 15pp sobre o adversário
  MIN_FIFA_RANK_DIFF: 40,   // diferença mínima recomendada de ranking
  MIN_ELO_DIFF:       80,   // diferença mínima recomendada de ELO
  MIN_VALUE_RATIO:    2.0,  // valor de mercado >2x é considerado vantagem forte
};

// Pesos somam 100 quando TODOS os critérios automáticos+manuais estão disponíveis.
// Quando algum está ausente, o peso dele é redistribuído proporcionalmente.
const WEIGHTS = {
  probabilidade:    14,
  fifaRanking:       12,
  elo:                16,
  valorMercado:        4,
  formaRecente:       10,
  forcaOfensiva:       9,
  forcaDefensiva:      9,
  momentum:            8,
  qualidadeElenco:     8,
  historicoCopa:       2,
  contextoGrupo:       8,
};

// Cobertura mínima de peso (soma dos pesos dos critérios DISPONÍVEIS) para
// sequer considerar aprovar A+/A. Abaixo disso, grade é travada em 'C'.
const MIN_COVERAGE = 60;

// Penalidade de desfalques (fora do pool de 100 — aplicada depois, como redutor)
const DESFALQUE_PENALTY_EACH = 6;   // por desfalque do time favorito
const DESFALQUE_PENALTY_MAX  = 18;
const OPPONENT_DESFALQUE_BONUS_EACH = 3; // bônus se o ADVERSÁRIO tiver desfalques
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
 * computeStreakFromForm(formString)
 * Conta a sequência invicta atual (mais recente → mais antiga) a partir da
 * string de forma da API-Football (ex: "WWDLW", mais recente é o último char).
 * Retorna { unbeaten, wins } — tamanho da sequência sem derrota e de vitórias puras.
 */
function computeStreakFromForm(formString) {
  if (!formString || typeof formString !== 'string') return { unbeaten: null, wins: null };
  const chars = formString.toUpperCase().split('').filter(c => ['W', 'D', 'L'].includes(c));
  if (!chars.length) return { unbeaten: null, wins: null };

  let unbeaten = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] === 'L') break;
    unbeaten++;
  }
  let wins = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== 'W') break;
    wins++;
  }
  return { unbeaten, wins };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCORES — cada um retorna 0-100 (favorável ao time FAVORITO) ou null se
// faltar dado. Nunca retornam um valor "inventado".
// ─────────────────────────────────────────────────────────────────────────────

function scoreProbabilidade(winFav, winOpp) {
  if (winFav === null || winOpp === null) return null;
  const margin = winFav - winOpp;
  return clamp((winFav - 50) * 1.4 + (margin - GATE.MIN_MARGIN) * 1.0);
}

function scoreFifaRanking(rankFav, rankOpp) {
  if (rankFav === null || rankOpp === null) return null;
  const diff = rankOpp - rankFav; // positivo = favorito melhor posicionado (rank menor)
  return clamp(diff);
}

function scoreElo(eloFav, eloOpp) {
  if (eloFav === null || eloOpp === null) return null;
  const diff = eloFav - eloOpp;
  return clamp(diff / 1.5);
}

function scoreValorMercado(valFav, valOpp) {
  if (!valFav || !valOpp) return null;
  const ratio = valFav / valOpp;
  return clamp((ratio - 1) * 60);
}

function scoreFormaRecente(formFav, formOpp) {
  if (formFav === null || formOpp === null) return null;
  const diff = formFav - formOpp; // ambos já são 0-100
  return clamp(50 + diff / 2);
}

function scoreForcaOfensiva(gfFav, gfOpp) {
  if (gfFav === null || gfOpp === null) return null;
  const diff = gfFav - gfOpp;
  return clamp(50 + diff * 35);
}

function scoreForcaDefensiva(gaFav, gaOpp) {
  if (gaFav === null || gaOpp === null) return null;
  const diff = gaOpp - gaFav; // positivo = favorito sofre menos gols
  return clamp(50 + diff * 35);
}

function scoreMomentum(formFav, formOpp, streakFav, streakOpp) {
  // Usa sequência invicta quando disponível; cai pro form score como proxy.
  if (streakFav !== null && streakOpp !== null) {
    const diff = streakFav - streakOpp;
    return clamp(50 + diff * 8);
  }
  if (formFav === null || formOpp === null) return null;
  return clamp(50 + (formFav - formOpp) / 2);
}

function scoreManual0a100(valFav, valOpp) {
  if (valFav === null || valFav === undefined || valOpp === null || valOpp === undefined) return null;
  const diff = valFav - valOpp;
  return clamp(50 + diff / 2);
}

function scoreContextoGrupo(ctxFav, ctxOpp) {
  if (!ctxFav && !ctxOpp) return null;
  const f = ctxFav || {};
  const o = ctxOpp || {};
  let s = 50;
  if (f.needsWin && !o.needsWin) s += 20;
  if (!f.needsWin && o.needsWin) s -= 20;
  if (f.alreadyQualified && !f.needsWin) s -= 10; // pode poupar força
  if (o.eliminated) s += 10; // adversário sem nada a jogar
  if (f.eliminated) s -= 25;
  return clamp(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * computeWcResultadoFinal(input)
 *
 * @param {object} input
 * @param {object} input.raw              — objeto raw já mapeado (PackBallMapper)
 * @param {string} [input.homeFormString] — string de forma bruta (ex: "WWDLW"), de
 *                                          apiData.homeStats.response.form, opcional
 * @param {string} [input.awayFormString] — idem, away
 * @param {object} [input.manualContext]  — conteúdo de wc_manual_context.json.teams
 *
 * @returns {object|null} — null se não há sinal aprovável; senão:
 *   {
 *     market: 'Vitória da Casa' | 'Vitória do Visitante',
 *     score, grade,            // grade só pode ser 'A+' ou 'A' (senão retorna null)
 *     favoredTeam, opponentTeam,
 *     coverage,                 // % do peso total que teve dado disponível
 *     breakdown,                // detalhe por critério, para auditoria/log
 *     rejected: false
 *   }
 *   Em modo debug, use computeWcResultadoFinalDebug() para ver motivo de rejeição.
 */
function computeWcResultadoFinal({ raw, homeFormString = null, awayFormString = null, manualContext = {} } = {}) {
  const result = computeWcResultadoFinalDebug({ raw, homeFormString, awayFormString, manualContext });
  if (!result || result.rejected || !['A+', 'A'].includes(result.grade)) return null;
  const { rejected, rejectReason, ...approved } = result;
  return approved;
}

/**
 * computeWcResultadoFinalDebug — mesma lógica, mas sempre retorna o objeto
 * completo (mesmo quando rejeitado), com `rejected` e `rejectReason` preenchidos.
 * Útil para logs/depuração no generate_predictions.js.
 */
function computeWcResultadoFinalDebug({ raw, homeFormString = null, awayFormString = null, manualContext = {} } = {}) {
  if (!raw) return { rejected: true, rejectReason: 'raw ausente' };

  const winHome = num(raw.win_home);
  const winDraw = num(raw.win_draw);
  const winAway = num(raw.win_away);

  if (winHome === null || winAway === null) {
    return { rejected: true, rejectReason: 'sem probabilidades (win_home/win_away ausentes)' };
  }

  // ── GATE #1 — Probabilidades ────────────────────────────────────────────
  if (winDraw !== null && winDraw > GATE.MAX_DRAW_PROB) {
    return { rejected: true, rejectReason: `draw_probability ${winDraw}% > ${GATE.MAX_DRAW_PROB}%` };
  }

  let side = null; // 'home' | 'away'
  if (winHome >= GATE.MIN_WIN_PROB && (winHome - winAway) >= GATE.MIN_MARGIN) side = 'home';
  else if (winAway >= GATE.MIN_WIN_PROB && (winAway - winHome) >= GATE.MIN_MARGIN) side = 'away';

  if (!side) {
    return { rejected: true, rejectReason: 'jogo equilibrado — nenhum lado atinge 62% + 15pp de vantagem' };
  }

  const favoredTeam   = side === 'home' ? raw.home_team : raw.away_team;
  const opponentTeam  = side === 'home' ? raw.away_team : raw.home_team;
  const winFav        = side === 'home' ? winHome : winAway;
  const winOpp         = side === 'home' ? winAway : winHome;

  // ── FILTROS DE EXCLUSÃO (#13) — flags manuais ───────────────────────────
  const ctxFav = (manualContext && manualContext[favoredTeam]) || {};
  const ctxOpp = (manualContext && manualContext[opponentTeam]) || {};
  if (ctxFav.rotationRisk) {
    return { rejected: true, rejectReason: `${favoredTeam} marcado como risco de rotação (manualContext)` };
  }
  if (ctxFav.unpredictable) {
    return { rejected: true, rejectReason: `${favoredTeam} marcado como imprevisível (manualContext)` };
  }

  // ── Coleta de dados por critério ────────────────────────────────────────
  const powerFav = getTeamPower(favoredTeam);
  const powerOpp = getTeamPower(opponentTeam);

  const ppgFav = side === 'home' ? num(raw.ppg_h) : num(raw.ppg_a);
  const ppgOpp = side === 'home' ? num(raw.ppg_a) : num(raw.ppg_h);

  const formFav = side === 'home' ? num(raw.home_form_score) : num(raw.away_form_score);
  const formOpp = side === 'home' ? num(raw.away_form_score) : num(raw.home_form_score);

  const gfFav = side === 'home' ? num(raw.avg_sc_h) : num(raw.avg_sc_a);
  const gfOpp = side === 'home' ? num(raw.avg_sc_a) : num(raw.avg_sc_h);

  const gaFav = side === 'home' ? num(raw.home_avg_conc_home) : num(raw.away_avg_conc_away);
  const gaOpp = side === 'home' ? num(raw.away_avg_conc_away) : num(raw.home_avg_conc_home);

  const formStrFav = side === 'home' ? homeFormString : awayFormString;
  const formStrOpp = side === 'home' ? awayFormString : homeFormString;
  const streakFav = computeStreakFromForm(formStrFav).unbeaten;
  const streakOpp = computeStreakFromForm(formStrOpp).unbeaten;

  // ── Subscores por critério ──────────────────────────────────────────────
  const subscores = {
    probabilidade:    scoreProbabilidade(winFav, winOpp),
    fifaRanking:      scoreFifaRanking(powerFav.fifaRank, powerOpp.fifaRank),
    elo:              scoreElo(powerFav.elo, powerOpp.elo),
    valorMercado:     scoreValorMercado(powerFav.marketValueM, powerOpp.marketValueM),
    formaRecente:     scoreFormaRecente(formFav, formOpp) ?? scoreManual0a100(
                          ppgFav !== null ? (ppgFav / 3) * 100 : null,
                          ppgOpp !== null ? (ppgOpp / 3) * 100 : null,
                        ),
    forcaOfensiva:    scoreForcaOfensiva(gfFav, gfOpp),
    forcaDefensiva:   scoreForcaDefensiva(gaFav, gaOpp),
    momentum:         scoreMomentum(formFav, formOpp, streakFav, streakOpp),
    qualidadeElenco:  scoreManual0a100(ctxFav.squadQuality, ctxOpp.squadQuality),
    historicoCopa:    scoreManual0a100(ctxFav.cupPedigree, ctxOpp.cupPedigree),
    contextoGrupo:    scoreContextoGrupo(ctxFav.groupContext, ctxOpp.groupContext),
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

  let rawScore = weightedSum / availableWeight; // 0-100, já normalizado pelos critérios disponíveis

  // ── #13 — coerência estrutural: rejeita se favorito por probabilidade mas
  // sem nenhuma vantagem estrutural real (ranking/elo/valor) disponível ──
  const structural = ['fifaRanking', 'elo', 'valorMercado']
    .map(k => subscores[k])
    .filter(v => v !== null);
  if (structural.length > 0 && structural.every(v => v < 50)) {
    return { rejected: true, rejectReason: 'sem vantagem estrutural (ranking/elo/valor todos < 50) apesar da probabilidade favorável' };
  }

  // ── #12 — Desfalques (penalidade fora do pool de 100) ───────────────────
  const missingFav = ctxFav.missingKeyPlayers || {};
  const missingOpp = ctxOpp.missingKeyPlayers || {};
  const favMissingCount = ['strikerOut', 'goalkeeperOut', 'centerBackOut'].filter(k => missingFav[k]).length;
  const oppMissingCount = ['strikerOut', 'goalkeeperOut', 'centerBackOut'].filter(k => missingOpp[k]).length;
  const desfalquePenalty = Math.min(favMissingCount * DESFALQUE_PENALTY_EACH, DESFALQUE_PENALTY_MAX);
  const desfalqueBonus   = Math.min(oppMissingCount * OPPONENT_DESFALQUE_BONUS_EACH, OPPONENT_DESFALQUE_BONUS_MAX);

  let finalScore = clamp(rawScore - desfalquePenalty + desfalqueBonus);

  // ── Cobertura mínima — sem dado real suficiente, trava em C (não aprova) ─
  let grade;
  if (coverage < MIN_COVERAGE) {
    grade = 'C';
  } else if (finalScore >= 90) grade = 'A+';
  else if (finalScore >= 85)   grade = 'A';
  else if (finalScore >= 80)   grade = 'B';
  else if (finalScore >= 75)   grade = 'C';
  else                          grade = 'D';

  return {
    rejected: false,
    rejectReason: null,
    market: side === 'home' ? 'Vitória da Casa' : 'Vitória do Visitante',
    score: Math.round(finalScore * 10) / 10,
    grade,
    favoredTeam,
    opponentTeam,
    coverage,
    desfalquePenalty,
    desfalqueBonus,
    breakdown,
  };
}

module.exports = {
  computeWcResultadoFinal,
  computeWcResultadoFinalDebug,
  WORLD_CUP_LEAGUE_NAMES,
  WEIGHTS,
  GATE,
  MIN_COVERAGE,
};
