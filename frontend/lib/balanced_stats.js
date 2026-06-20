/**
 * WinMetrics V3 — Estatísticas balanceadas Casa+Fora (metodologia True Signal)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Análise com média balanceada: cada métrica = (média jogando em casa +
 *  média jogando fora) / 2 — para os dois times. Elimina o viés de quem
 *  jogou mais em um lado." (apptruesignal.com/painel)
 *
 * Por que isso importa: hoje o pipeline usa `avg_sc_h`/`avg_sc_a` (média de
 * gols marcados da TEMPORADA INTEIRA, goals.for.average.total) e `ppg_h`/
 * `ppg_a` (PPG da temporada inteira) — ambos enviesados quando um time jogou
 * bem mais em casa do que fora (ou vice-versa), o que é comum no meio da
 * temporada. A média balanceada trata casa e fora com peso igual,
 * independente de quantos jogos o time teve de cada lado.
 *
 * Usado por: wc_resultado_final.js, wc_dupla_chance.js,
 * club_resultado_final.js, club_dupla_chance.js — como camada OPCIONAL que,
 * quando disponível, substitui o dado bruto (`raw.win_home`/`avg_sc_h`/
 * `ppg_h` etc.) só dentro desses 4 motores. NÃO mexe em `raw` nem em
 * nenhum outro mercado — isolado, igual o padrão dos outros módulos novos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FUNÇÕES
 *
 *   computeTeamBalancedStats(teamStats) → { balancedAttack, balancedDefense,
 *     balancedPpg, attackHome, attackAway, defenseHome, defenseAway,
 *     ppgHome, ppgAway }
 *     Recebe o `response` cru de /teams/statistics (mesmo objeto que
 *     packball_mapper.js já usa) e calcula a média balanceada de cada
 *     métrica. Quando só um lado tem dado (ex: time só jogou em casa até
 *     agora), usa o lado disponível sozinho — nunca derruba pra null à toa.
 *
 *   computeBalancedWinProbabilities(homeBalanced, awayBalanced, options)
 *     → { win_home, win_draw, win_away } (somam 100, ou null se faltar dado)
 *     Modelo de Poisson: lambda_home = média do ataque balanceado do
 *     mandante com a defesa balanceada do visitante (e vice-versa para
 *     lambda_away), com um fator pequeno de mando de campo (HOME_ADVANTAGE)
 *     — a média balanceada por si só elimina o viés de QUANTOS jogos cada
 *     time teve de cada lado, mas o mando de campo do jogo de hoje continua
 *     sendo um fator real e conhecido do futebol, então não foi zerado.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// Fator de mando de campo aplicado sobre o lambda do Poisson — valor
// conservador e padrão de mercado (não veio especificado, é minha escolha;
// fácil de ajustar aqui se quiser recalibrar).
const HOME_ADVANTAGE = 1.10;
const AWAY_DISADVANTAGE = 0.92;

// Grade máxima de gols simulada no Poisson (0 a MAX_GOALS para cada lado)
const MAX_GOALS = 8;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Média simples ignorando nulos — nunca derruba pra null se um lado existir. */
function avgIgnoringNull(a, b) {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return (a + b) / 2;
}

/**
 * computeTeamBalancedStats(teamStats)
 * @param {object} teamStats — response cru de /teams/statistics (ex: apiData.homeStats?.response)
 */
function computeTeamBalancedStats(teamStats) {
  if (!teamStats) {
    return { balancedAttack: null, balancedDefense: null, balancedPpg: null,
             attackHome: null, attackAway: null, defenseHome: null, defenseAway: null,
             ppgHome: null, ppgAway: null };
  }

  const attackHome  = num(teamStats.goals?.for?.average?.home);
  const attackAway  = num(teamStats.goals?.for?.average?.away);
  const defenseHome = num(teamStats.goals?.against?.average?.home);
  const defenseAway = num(teamStats.goals?.against?.average?.away);

  const fx = teamStats.fixtures || {};
  const playedHome = num(fx.played?.home);
  const playedAway = num(fx.played?.away);
  const ppgHome = (playedHome && playedHome > 0)
    ? ((num(fx.wins?.home) || 0) * 3 + (num(fx.draws?.home) || 0)) / playedHome
    : null;
  const ppgAway = (playedAway && playedAway > 0)
    ? ((num(fx.wins?.away) || 0) * 3 + (num(fx.draws?.away) || 0)) / playedAway
    : null;

  return {
    balancedAttack:  avgIgnoringNull(attackHome, attackAway),
    balancedDefense: avgIgnoringNull(defenseHome, defenseAway),
    balancedPpg:     avgIgnoringNull(ppgHome, ppgAway),
    attackHome, attackAway, defenseHome, defenseAway, ppgHome, ppgAway,
  };
}

function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/** P(X = k) para uma Poisson de parâmetro lambda. */
function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

/**
 * computeBalancedWinProbabilities(homeBalanced, awayBalanced)
 * @param {object} homeBalanced — saída de computeTeamBalancedStats() do time da casa
 * @param {object} awayBalanced — saída de computeTeamBalancedStats() do time de fora
 * @returns {{win_home:number, win_draw:number, win_away:number}|null} — em %, soma 100
 */
function computeBalancedWinProbabilities(homeBalanced, awayBalanced) {
  if (!homeBalanced || !awayBalanced) return null;
  if (homeBalanced.balancedAttack === null || homeBalanced.balancedDefense === null) return null;
  if (awayBalanced.balancedAttack === null || awayBalanced.balancedDefense === null) return null;

  // Expectativa de gols: ataque balanceado do time × defesa balanceada do
  // adversário, com o ajuste de mando de campo do jogo de hoje.
  const lambdaHome = Math.max(0.05, ((homeBalanced.balancedAttack + awayBalanced.balancedDefense) / 2) * HOME_ADVANTAGE);
  const lambdaAway = Math.max(0.05, ((awayBalanced.balancedAttack + homeBalanced.balancedDefense) / 2) * AWAY_DISADVANTAGE);

  let pHome = 0, pDraw = 0, pAway = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    const pi = poissonPMF(i, lambdaHome);
    for (let j = 0; j <= MAX_GOALS; j++) {
      const pj = poissonPMF(j, lambdaAway);
      const p = pi * pj;
      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;
    }
  }

  // Normaliza pra somar exatamente 100 (a cauda truncada em MAX_GOALS deixa
  // uma fração residual pequena, geralmente < 0.1%).
  const total = pHome + pDraw + pAway;
  if (total <= 0) return null;

  return {
    win_home: Math.round((pHome / total) * 1000) / 10,
    win_draw: Math.round((pDraw / total) * 1000) / 10,
    win_away: Math.round((pAway / total) * 1000) / 10,
    lambdaHome: Math.round(lambdaHome * 100) / 100,
    lambdaAway: Math.round(lambdaAway * 100) / 100,
  };
}

module.exports = {
  computeTeamBalancedStats,
  computeBalancedWinProbabilities,
  poissonPMF,
  HOME_ADVANTAGE,
  AWAY_DISADVANTAGE,
  MAX_GOALS,
};
