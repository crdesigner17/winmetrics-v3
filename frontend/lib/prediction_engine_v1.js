/**
 * WinMetrics Analytics — Prediction Engine v1
 * ─────────────────────────────────────────────
 * Motor matemático puro do PackBall v3.0.
 * Implementação fiel à Documentação Técnica Completa — Junho 2026.
 *
 * Seções de referência:
 *   3.1  Variáveis brutas
 *   3.2  Variáveis derivadas + Poisson
 *   3.3  Normalizações (escala 0–100)
 *   4.1–4.10  Score Engine por mercado
 *   5.1  Sistema de grades (thresholds coletar.py / modo API)
 *   5.2  Seleção de best_mkt
 *   6    Filtro 3 Vias — Over 1.5 (modo API — inclui Via 4)
 *   4.6  Filtro específico Under 3.5
 *
 * Sem dependências externas. Sem acesso à rede.
 * Entrada: objeto raw com variáveis brutas por fixture.
 * Saída:   objeto processado com scores, grades, filtros, best_mkt e EV.
 *
 * Uso:
 *   const result = PredictionEngine.processFixture(rawData);
 */

const PredictionEngine = (function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // CONSTANTES — Thresholds modo API (coletar.py)  §5.1
  // ═══════════════════════════════════════════════════════════════

  const GRADE_THRESHOLDS = {
    'A+': 88,
    'A':  80,
    'B':  70,
    'C':  60,
  };
  // D = qualquer score abaixo de 60

  const CONFIDENCE_LABELS = {
    'A+': 'Muito Baixo',
    'A':  'Baixo',
    'B':  'Médio',
    'C':  'Alto',
    'D':  'Muito Alto',
  };

  // Mercados que entram no snap / Melhores Previsões (grades oficiais)
  const GRADES_OFICIAIS = new Set(['A+', 'A']);

  // Limites de normalização §3.3
  const NORM_LIMITS = {
    ppg_n:   { min: 0, max: 3  },
    af_n:    { min: 0, max: 4  },
    exg_n:   { min: 0, max: 5  },
    h2h_nv:  { min: 0, max: 5  },
    cant_n:  { min: 0, max: 15 },
    shots_n: { min: 0, max: 40 },
    cards_n: { min: 0, max: 8  },
    sot_n:   { min: 0, max: 20 },
  };

  // ═══════════════════════════════════════════════════════════════
  // 1. n(v, min, max) — Normalização 0–100  §3.3
  //    n(v, min, max) = max(0, min(100, (v - min) / (max - min) * 100))
  // ═══════════════════════════════════════════════════════════════

  /**
   * n(v, min, max)
   * Normaliza um valor para a escala 0–100.
   * Retorna null se v for null/undefined (preserva nulos para ws()).
   *
   * @param {number|null} v
   * @param {number}      lo  — valor mínimo da escala
   * @param {number}      hi  — valor máximo da escala
   * @returns {number|null}
   */
  function n(v, lo, hi) {
    if (v === null || v === undefined) return null;
    if (hi === lo) return 0;
    return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  }


  // ═══════════════════════════════════════════════════════════════
  // 2. ws(pairs) — Média ponderada ignorando nulos  §4.0
  //    ws([(v1,p1), (v2,p2), ...]) ignora pares com valor null/undefined.
  //    Se TODOS forem nulos, retorna null.
  // ═══════════════════════════════════════════════════════════════

  /**
   * ws(pairs)
   * Média ponderada que ignora valores nulos.
   * Cada pair é [valor, peso]. Se valor for null/undefined, o par é ignorado.
   * Os pesos dos pares válidos são re-normalizados automaticamente.
   *
   * @param {Array<[number|null, number]>} pairs
   * @returns {number|null}
   */
  function ws(pairs) {
    let weightSum = 0;
    let valueSum  = 0;

    for (const [v, w] of pairs) {
      if (v === null || v === undefined) continue;
      weightSum += w;
      valueSum  += v * w;
    }

    if (weightSum === 0) return null;
    return valueSum / weightSum;
  }


  // ═══════════════════════════════════════════════════════════════
  // 3. Poisson  §3.2
  // ═══════════════════════════════════════════════════════════════

  /**
   * _poissonP(lambda, k)
   * Probabilidade P(X = k) para distribuição de Poisson.
   * P(X=k) = e^(-λ) × λ^k / k!
   *
   * @param {number} lambda  — gols esperados (exg_tot)
   * @param {number} k       — número exato de gols
   * @returns {number}       0–1
   */
  function _poissonP(lambda, k) {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    let p = Math.exp(-lambda);
    for (let i = 0; i < k; i++) {
      p *= lambda / (i + 1);
    }
    return p;
  }

  /**
   * poissonProbs(exg_tot)
   * Calcula as quatro probabilidades Poisson usadas pelo motor.
   *
   * Documentação §3.2:
   *   prob_o15_poisson = P(gols >= 2) = 1 - P(0) - P(1)
   *   prob_o25_poisson = P(gols >= 3) = 1 - P(0) - P(1) - P(2)
   *   prob_u35_poisson = P(gols <= 3) = P(0)+P(1)+P(2)+P(3)   [= 100 - P(gols>=4)]
   *   prob_u45_poisson = P(gols <= 4) = P(0)+P(1)+P(2)+P(3)+P(4) [= 100 - P(gols>=5)]
   *
   * @param {number|null} exg_tot  — xG total (exg_h + exg_a)
   * @returns {{ o15:number, o25:number, u35:number, u45:number }|null}
   *          Valores em % (0–100). null se exg_tot indisponível.
   */
  function poissonProbs(exg_tot) {
    if (exg_tot === null || exg_tot === undefined || exg_tot <= 0) return null;

    const p0 = _poissonP(exg_tot, 0);
    const p1 = _poissonP(exg_tot, 1);
    const p2 = _poissonP(exg_tot, 2);
    const p3 = _poissonP(exg_tot, 3);
    const p4 = _poissonP(exg_tot, 4);

    return {
      o15: (1 - p0 - p1) * 100,             // P(gols >= 2)
      o25: (1 - p0 - p1 - p2) * 100,        // P(gols >= 3)
      u35: (p0 + p1 + p2 + p3) * 100,       // P(gols <= 3)
      u45: (p0 + p1 + p2 + p3 + p4) * 100,  // P(gols <= 4)
    };
  }


  // ═══════════════════════════════════════════════════════════════
  // DERIVADAS §3.2 e NORMALIZADAS §3.3
  // ═══════════════════════════════════════════════════════════════

  /**
   * computeDerivadas(raw)
   * Calcula variáveis derivadas a partir das brutas.
   * §3.2: exg_tot, ppg_avg, ppg_min, af_avg, btts_cf, u25cf
   *
   * @param {object} raw
   * @returns {object}  derivadas calculadas (null quando inputs ausentes)
   */
  function computeDerivadas(raw) {
    const {
      exg_h, exg_a,
      ppg_h, ppg_a,
      avg_sc_h, avg_sc_a,
      btts_h, btts_a,
      under25_h, under25_a,
    } = raw;

    // exg_tot: apenas se AMBOS disponíveis
    const exg_tot = (exg_h != null && exg_a != null) ? exg_h + exg_a : null;

    // ppg_avg e ppg_min
    const ppg_avg = (ppg_h != null && ppg_a != null) ? (ppg_h + ppg_a) / 2 : null;
    const ppg_min = (ppg_h != null && ppg_a != null) ? Math.min(ppg_h, ppg_a) : null;

    // af_avg (média de ataque combinada)
    const af_avg = (avg_sc_h != null && avg_sc_a != null) ? (avg_sc_h + avg_sc_a) / 2 : null;

    // btts_cf
    const btts_cf = (btts_h != null && btts_a != null) ? (btts_h + btts_a) / 2 : null;

    // u25cf
    const u25cf = (under25_h != null && under25_a != null) ? (under25_h + under25_a) / 2 : null;

    return { exg_tot, ppg_avg, ppg_min, af_avg, btts_cf, u25cf };
  }

  /**
   * computeNormalizadas(d)
   * Normaliza as variáveis conforme tabela §3.3.
   *
   * @param {object} raw       — variáveis brutas
   * @param {object} derivadas — exg_tot, ppg_avg, af_avg, h2h_goals …
   * @returns {object}
   */
  function computeNormalizadas(raw, derivadas) {
    const { h2h_goals, avg_corners, avg_shots, avg_sot, avg_cards } = raw;
    const { exg_tot, ppg_avg, af_avg } = derivadas;

    return {
      ppg_n:   n(ppg_avg,    NORM_LIMITS.ppg_n.min,   NORM_LIMITS.ppg_n.max),
      af_n:    n(af_avg,     NORM_LIMITS.af_n.min,    NORM_LIMITS.af_n.max),
      exg_n:   n(exg_tot,    NORM_LIMITS.exg_n.min,   NORM_LIMITS.exg_n.max),
      h2h_nv:  n(h2h_goals,  NORM_LIMITS.h2h_nv.min,  NORM_LIMITS.h2h_nv.max),
      cant_n:  n(avg_corners, NORM_LIMITS.cant_n.min,  NORM_LIMITS.cant_n.max),
      shots_n: n(avg_shots,  NORM_LIMITS.shots_n.min, NORM_LIMITS.shots_n.max),
      cards_n: n(avg_cards,  NORM_LIMITS.cards_n.min, NORM_LIMITS.cards_n.max),
      sot_n:   n(avg_sot,    NORM_LIMITS.sot_n.min,   NORM_LIMITS.sot_n.max),
    };
  }


  // ═══════════════════════════════════════════════════════════════
  // HELPERS INTERNOS
  // ═══════════════════════════════════════════════════════════════

  /**
   * _v(v, fallback)
   * Retorna v se não nulo, senão fallback.
   * Usado na documentação com notação "|50" (ex: exg_n|50).
   *
   * @param {number|null} v
   * @param {number}      fallback
   * @returns {number}
   */
  function _v(v, fallback) {
    return (v !== null && v !== undefined) ? v : fallback;
  }

  /**
   * _o15cf(raw, derivadas)
   * Calcula o15cf — confidence fator Over 1.5.
   * Aparece nas fórmulas §4.1 e §4.2 mas não é documentado separadamente.
   * Interpretado como: média(over15_g, btts_cf) — proxy de confiança geral de gols.
   *
   * @returns {number|null}
   */
  function _o15cf(raw, derivadas) {
    return ws([[raw.over15_g, 1], [derivadas.btts_cf, 1]]);
  }

  /**
   * _o25cf(raw, derivadas)
   * o25cf — confidence fator Over 2.5.
   * Interpretado como: média(over25_g, af_avg_n×100).
   *
   * @returns {number|null}
   */
  function _o25cf(raw, derivadas) {
    return ws([[raw.over25_g, 1], [derivadas.af_avg != null ? n(derivadas.af_avg, 0, 4) : null, 1]]);
  }


  // ═══════════════════════════════════════════════════════════════
  // 4. SCORE ENGINE por mercado  §4.1–4.10
  // ═══════════════════════════════════════════════════════════════

  /**
   * scoreOver15(raw, d, norm, poisson)
   * §4.1 — Over 1.5 Gols
   *
   * Com xG (exg_n != null):
   *   ws([(over15_g,30),(o15cf,18),(h2h_nv,12),(ppg_n,12),(af_n,8),(exg_n,15),(poisson_o15,5)])
   *
   * Sem xG:
   *   ws([(over15_g,35),(o15cf,22),(h2h_nv,15),(ppg_n,15),(af_n,13)])
   */
  function scoreOver15(raw, d, norm, poiss) {
    const o15cf_val = _o15cf(raw, d);

    if (norm.exg_n !== null) {
      return ws([
        [raw.over15_g,        30],
        [o15cf_val,           18],
        [norm.h2h_nv,         12],
        [norm.ppg_n,          12],
        [norm.af_n,            8],
        [norm.exg_n,          15],
        [poiss ? poiss.o15 : null, 5],
      ]);
    } else {
      return ws([
        [raw.over15_g,   35],
        [o15cf_val,      22],
        [norm.h2h_nv,    15],
        [norm.ppg_n,     15],
        [norm.af_n,      13],
      ]);
    }
  }

  /**
   * scoreOver25(raw, d, norm, poisson)
   * §4.2 — Over 2.5 Gols
   *
   * Com xG:
   *   ws([(over25_g,28),(o25cf,18),(h2h_nv,12),(ppg_n,12),(af_n,8),(exg_n,17),(poisson_o25,5)])
   *
   * Sem xG:
   *   ws([(over25_g,35),(o25cf,22),(h2h_nv,15),(ppg_n,15),(af_n,13)])
   */
  function scoreOver25(raw, d, norm, poiss) {
    const o25cf_val = _o25cf(raw, d);

    if (norm.exg_n !== null) {
      return ws([
        [raw.over25_g,             28],
        [o25cf_val,                18],
        [norm.h2h_nv,              12],
        [norm.ppg_n,               12],
        [norm.af_n,                 8],
        [norm.exg_n,               17],
        [poiss ? poiss.o25 : null,  5],
      ]);
    } else {
      return ws([
        [raw.over25_g,  35],
        [o25cf_val,     22],
        [norm.h2h_nv,   15],
        [norm.ppg_n,    15],
        [norm.af_n,     13],
      ]);
    }
  }

  /**
   * scoreBTTS(raw, d, norm, poisson)
   * §4.3 — BTTS (Ambas Marcam)
   *
   * ws([(btts_cf,40),(h2h_nv,15),(ppg_n,15),(af_n,15),(over15_g,10),(exg_n|50,5)])
   */
  function scoreBTTS(raw, d, norm) {
    return ws([
      [d.btts_cf,         40],
      [norm.h2h_nv,       15],
      [norm.ppg_n,        15],
      [norm.af_n,         15],
      [raw.over15_g,      10],
      [_v(norm.exg_n, 50), 5],
    ]);
  }

  /**
   * scoreOver05HT(raw, d, norm)
   * §4.4 — Over 0.5 HT
   *
   * Com over05_ht:
   *   ws([(over05_ht,45),(over15_ht|50,15),(ppg_n,15),(af_n,15),(sot_n|50,10)])
   *
   * Sem over05_ht:
   *   ws([(ppg_n,40),(af_n,30),(over15_g|50,20),(sot_n|50,10)])
   */
  function scoreOver05HT(raw, d, norm) {
    if (raw.over05_ht != null) {
      return ws([
        [raw.over05_ht,             45],
        [_v(raw.over15_ht, 50),     15],
        [norm.ppg_n,                15],
        [norm.af_n,                 15],
        [_v(norm.sot_n, 50),        10],
      ]);
    } else {
      return ws([
        [norm.ppg_n,                40],
        [norm.af_n,                 30],
        [_v(raw.over15_g, 50),      20],
        [_v(norm.sot_n, 50),        10],
      ]);
    }
  }

  /**
   * scoreUnder45(raw, d, norm, poisson)
   * §4.5 — Under 4.5 Gols
   *
   * avg_gl = média gols totais por jogo — proxy via af_avg*2 (ambos os times)
   *
   * Com Poisson:
   *   ws([(poisson_u45,35),(u25cf|50,25),(100-exg_n|50,20),(avg_gl|50,10),(50,10)])
   *
   * Sem Poisson:
   *   ws([(u25cf|50,40),(100-ppg_n|50,30),(50,30)])
   */
  function scoreUnder45(raw, d, norm, poiss) {
    // avg_gl: estimativa de gols totais — usamos af_avg*2 (média das médias de gols de cada time)
    const avg_gl = d.af_avg != null ? Math.min(100, d.af_avg * 2 * (100 / 4)) : null;

    if (poiss !== null) {
      return ws([
        [poiss.u45,                     35],
        [_v(d.u25cf, 50),               25],
        [100 - _v(norm.exg_n, 50),      20],
        [_v(avg_gl, 50),                10],
        [50,                            10],
      ]);
    } else {
      return ws([
        [_v(d.u25cf, 50),               40],
        [100 - _v(norm.ppg_n, 50),      30],
        [50,                            30],
      ]);
    }
  }

  /**
   * scoreUnder35(raw, d, norm, poisson)
   * §4.6 — Under 3.5 Gols
   *
   * Com Poisson:
   *   ws([(poisson_u35,45),(u25cf|50,20),(100-exg_n|50,25),(50,10)])
   *
   * Sem Poisson:
   *   ws([(u25cf|50,50),(100-ppg_n|50,30),(50,20)])
   */
  function scoreUnder35(raw, d, norm, poiss) {
    if (poiss !== null) {
      return ws([
        [poiss.u35,                     45],
        [_v(d.u25cf, 50),               20],
        [100 - _v(norm.exg_n, 50),      25],
        [50,                            10],
      ]);
    } else {
      return ws([
        [_v(d.u25cf, 50),               50],
        [100 - _v(norm.ppg_n, 50),      30],
        [50,                            20],
      ]);
    }
  }

  /**
   * scoreEsc75(raw, d, norm)
   * §4.7 — Escanteios Over 7.5
   *
   * ws([(cant_n,40),(over75_c,30),(shots_n,15),(over65_c|50,10),(ppg_n,5)])
   */
  function scoreEsc75(raw, d, norm) {
    return ws([
      [norm.cant_n,               40],
      [raw.over75_c,              30],
      [norm.shots_n,              15],
      [_v(raw.over65_c, 50),      10],
      [norm.ppg_n,                 5],
    ]);
  }

  /**
   * scoreEsc85(raw, d, norm)
   * §4.8 — Escanteios Over 8.5
   *
   * ws([(cant_n,38),(over85_c,32),(shots_n,15),(over75_c,10),(ppg_n,5)])
   */
  function scoreEsc85(raw, d, norm) {
    return ws([
      [norm.cant_n,   38],
      [raw.over85_c,  32],
      [norm.shots_n,  15],
      [raw.over75_c,  10],
      [norm.ppg_n,     5],
    ]);
  }

  /**
   * scoreCards25(raw, d, norm)
   * §4.9 — Cartões Over 2.5
   *
   * ws([(over25_cards,45),(cards_n,35),(ppg_n,10),(50,10)])
   */
  function scoreCards25(raw, d, norm) {
    return ws([
      [raw.over25_cards,  45],
      [norm.cards_n,      35],
      [norm.ppg_n,        10],
      [50,                10],
    ]);
  }

  /**
   * scoreCards35(raw, d, norm)
   * §4.10 — Cartões Over 3.5
   *
   * ws([(over35_cards,50),(cards_n,30),(ppg_n,10),(50,10)])
   */
  function scoreCards35(raw, d, norm) {
    return ws([
      [raw.over35_cards,  50],
      [norm.cards_n,      30],
      [norm.ppg_n,        10],
      [50,                10],
    ]);
  }

  function scoreCards55(raw, d, norm) {
    return ws([
      [raw.over45_cards,  48],
      [norm.cards_n,      32],
      [raw.over35_cards,  10],
      [norm.ppg_n,        10],
    ]);
  }

  /**
   * _rfProbValida(home_prob, draw_prob, away_prob)
   * Detecta se as probabilidades da API são reais ou placeholders.
   *
   * Placeholders conhecidos da API-Football quando dados são indisponíveis:
   *   { 0, 10, 33, 35, 45, 50 }
   *
   * Regras de invalidação:
   *   1. Todos os três valores pertencem ao conjunto de placeholders
   *   2. Soma < 90 (dados incompletos)
   *   3. Soma > 110 (erro de normalização)
   *
   * @returns {boolean}
   */
  function _rfProbValida(home_prob, draw_prob, away_prob) {
    if (home_prob === null || home_prob === undefined) return false;
    if (draw_prob === null || draw_prob === undefined) return false;
    if (away_prob === null || away_prob === undefined) return false;

    const PLACEHOLDERS = new Set([0, 10, 33, 35, 45, 50]);
    const todos_placeholder = [home_prob, draw_prob, away_prob].every(v => PLACEHOLDERS.has(Number(v)));
    if (todos_placeholder) return false;

    const soma = Number(home_prob) + Number(draw_prob) + Number(away_prob);
    if (soma < 90 || soma > 110) return false;

    return true;
  }

  /**
   * _rfFormScore(v)
   * Retorna v se for número finito, senão null.
   */
  function _rfFormScore(v) {
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) return Number(v);
    return null;
  }

  /**
   * scoreResultadoFinal(raw, d, norm)
   * Lógica PackBall v3.0 — Vitória Casa / Vitória Fora (Vitória Seca).
   *
   * ── Independência da API ─────────────────────────────────────────
   * A lógica NÃO depende obrigatoriamente de win_home/win_away.
   * Quando a API retorna placeholder, esses campos são ignorados como
   * bloqueio e contribuem com 0 no score.
   * Quando a API retorna probabilidade real e válida, eles entram no
   * score com peso alto (30%).
   *
   * ── Critérios primários (obrigatórios, independentes da API) ─────
   * Vitória Casa:
   *   form_gap_h >= 8        (mandante com forma melhor)
   *   home_home_perf >= 55   (mandante razoável em casa)
   *   away_away_perf <= 55   (visitante fraco fora)
   *   avg_sc_h >= 1.2        (ataque mínimo do mandante)
   *   draw_risk <= 40        (empate não dominante)
   *
   * Vitória Fora:
   *   form_gap_a >= 8
   *   away_away_perf >= 55
   *   home_home_perf <= 55
   *   avg_sc_a >= 1.2
   *   draw_risk <= 40
   *
   * ── Score ────────────────────────────────────────────────────────
   * Com prob. API válida (peso 30%):
   *   score = prob*0.30 + form_gap*0.22 + local_perf*0.20
   *         + (100-draw_risk)*0.15 + (100-opp_perf)*0.08 + atk_bonus*0.05
   *
   * Sem prob. API (peso redistribuído):
   *   score = form_gap*0.32 + local_perf*0.28 + (100-draw_risk)*0.20
   *         + (100-opp_perf)*0.12 + atk_bonus*0.08
   *
   * ── Classificação (apenas Elite/Alta/Boa Entrada) ─────────────────
   *   raw >= 75 → Elite       (A+, finalScore = max(raw, 88))
   *   raw >= 65 → Alta        (A,  finalScore = max(raw, 82))
   *   raw >= 56 → Boa Entrada (A,  finalScore = max(raw, 76))
   *   raw < 56  → descartado
   *
   * @returns {{ score, market, side, pickType, rfLabel }}
   */
  function scoreResultadoFinal(raw, d, norm) {

    // ── Leitura de variáveis ──────────────────────────────────────
    const _n = v => (v !== null && v !== undefined && Number.isFinite(Number(v))) ? Number(v) : null;

    const home_prob   = _n(raw.win_home);
    const away_prob   = _n(raw.win_away);
    const draw_prob_api = _n(raw.win_draw);

    // draw_risk: usa win_draw da API se válido, senão estima via form
    const prob_valida = _rfProbValida(home_prob, draw_prob_api, away_prob);

    const home_form   = _rfFormScore(raw.home_form_score);
    const away_form   = _rfFormScore(raw.away_form_score);

    const home_home_p = _n(raw.home_home_perf);
    const away_away_p = _n(raw.away_away_perf);

    const avg_sc_h    = _n(raw.avg_sc_h);
    const avg_sc_a    = _n(raw.avg_sc_a);

    const home_conc   = _n(raw.home_avg_conc_home);
    const away_conc   = _n(raw.away_avg_conc_away);

    const odds_h      = _n(raw.odds_h);
    const odds_a      = _n(raw.odds_a);

    // ── draw_risk ─────────────────────────────────────────────────
    // Com prob válida: usa diretamente
    // Sem prob válida: estima via form (times equilibrados → maior risco)
    let draw_risk = null;
    if (prob_valida && draw_prob_api !== null) {
      draw_risk = draw_prob_api;
    } else if (home_form !== null && away_form !== null) {
      // Times muito equilibrados em forma → draw_risk alto
      const gap = Math.abs(home_form - away_form);
      draw_risk = Math.max(20, 50 - gap * 0.4);
    }

    // ── atk_bonus ─────────────────────────────────────────────────
    // Bônus de força ofensiva vs fragilidade defensiva adversária
    function _atkBonus(atk, def_adv) {
      if (atk === null && def_adv === null) return null;
      let b = 0;
      if (atk !== null)     b += Math.min(100, atk * 40);      // 2.5 gols → 100
      if (def_adv !== null) b += Math.min(100, def_adv * 35);  // >1.4 gols sofridos → bom
      return b / ((atk !== null ? 1 : 0) + (def_adv !== null ? 1 : 0));
    }

    // ── Score function ────────────────────────────────────────────
    function _score(prob, fg, lp, dr, op, atk_b) {
      const dr_val = dr !== null ? dr : 33;   // fallback conservador
      const op_val = op !== null ? op : 50;
      const fg_val = fg !== null ? fg : 0;
      const lp_val = lp !== null ? lp : 50;
      const ab_val = atk_b !== null ? atk_b : 50;

      let s;
      if (prob !== null && prob_valida) {
        s = prob   * 0.30
          + fg_val * 0.22
          + lp_val * 0.20
          + (100 - dr_val) * 0.15
          + (100 - op_val) * 0.08
          + ab_val * 0.05;
      } else {
        s = fg_val * 0.32
          + lp_val * 0.28
          + (100 - dr_val) * 0.20
          + (100 - op_val) * 0.12
          + ab_val * 0.08;
      }
      return Math.round(s * 10) / 10;
    }

    // ── Classificação ─────────────────────────────────────────────
    function _classify(raw_score) {
      if (raw_score >= 75) return { label: 'Elite',       grade: 'A+', finalScore: Math.max(raw_score, 88) };
      if (raw_score >= 65) return { label: 'Alta',        grade: 'A',  finalScore: Math.max(raw_score, 82) };
      if (raw_score >= 56) return { label: 'Boa Entrada', grade: 'A',  finalScore: Math.max(raw_score, 76) };
      return null;
    }

    // ── Bloqueio global: draw_risk >= 40 ─────────────────────────
    if (draw_risk !== null && draw_risk >= 40) {
      return { score: null, market: null, side: null, pickType: null };
    }

    // ── Vitória Casa ──────────────────────────────────────────────
    const form_gap_h = (home_form !== null && away_form !== null) ? home_form - away_form : null;

    const casa_criterios = [
      form_gap_h === null  || form_gap_h  >= 8,
      home_home_p === null || home_home_p >= 55,
      away_away_p === null || away_away_p <= 55,
      avg_sc_h === null    || avg_sc_h    >= 1.2,
    ];
    const casa_has_data = form_gap_h !== null || home_home_p !== null;
    const casa_ok = casa_criterios.every(Boolean) && casa_has_data;

    if (casa_ok) {
      const atk_b = _atkBonus(avg_sc_h, away_conc);
      const raw_score = _score(home_prob, form_gap_h, home_home_p, draw_risk, away_away_p, atk_b);
      const cls = _classify(raw_score);
      if (cls) {
        return {
          score:    Math.min(100, cls.finalScore),
          market:   'Resultado Final (1X2) - Vitória Casa',
          side:     'home',
          pickType: 'win',
          rfLabel:  cls.label,
          prob_valida,
        };
      }
    }

    // ── Vitória Fora ──────────────────────────────────────────────
    const form_gap_a = (home_form !== null && away_form !== null) ? away_form - home_form : null;

    const fora_criterios = [
      form_gap_a === null  || form_gap_a  >= 8,
      away_away_p === null || away_away_p >= 55,
      home_home_p === null || home_home_p <= 55,
      avg_sc_a === null    || avg_sc_a    >= 1.2,
    ];
    const fora_has_data = form_gap_a !== null || away_away_p !== null;
    const fora_ok = fora_criterios.every(Boolean) && fora_has_data;

    if (fora_ok) {
      const atk_b = _atkBonus(avg_sc_a, home_conc);
      const raw_score = _score(away_prob, form_gap_a, away_away_p, draw_risk, home_home_p, atk_b);
      const cls = _classify(raw_score);
      if (cls) {
        return {
          score:    Math.min(100, cls.finalScore),
          market:   'Resultado Final (1X2) - Vitória Visitante',
          side:     'away',
          pickType: 'win',
          rfLabel:  cls.label,
          prob_valida,
        };
      }
    }

    return { score: null, market: null, side: null, pickType: null };
  }


  /**
   * scoreDNB(raw, d, norm)
   * Lógica PackBall v3.0 — Empate Anula Aposta (DNB) Casa e Fora.
   *
   * ── Conceito ─────────────────────────────────────────────────────
   * Mercado intermediário entre Vitória Seca e Dupla Chance.
   * Entra quando o time tem boa chance de vencer mas o empate
   * ainda é risco relevante. O empate devolve a aposta.
   *
   * ── Critérios DNB Casa ───────────────────────────────────────────
   *   form_gap_h >= 6
   *   home_home_perf >= 65
   *   away_away_perf <= 62
   *   avg_sc_h >= 1.3
   *   away_avg_conc_away >= 1.1   (se disponível)
   *   away_prob baixa             (se prob válida)
   *
   * ── Critérios DNB Fora ───────────────────────────────────────────
   *   form_gap_a >= 6
   *   away_away_perf >= 62
   *   home_home_perf <= 62
   *   avg_sc_a >= 1.2
   *   home_avg_conc_home >= 1.1   (se disponível)
   *   home_prob baixa             (se prob válida)
   *
   * ── Score ────────────────────────────────────────────────────────
   * Com prob. válida:
   *   score = prob*0.28 + form_gap*0.24 + local_perf*0.22
   *         + (100-draw_risk)*0.16 + (100-opp_perf)*0.10
   *
   * Sem prob. válida:
   *   score = form_gap*0.34 + local_perf*0.30 + (100-draw_risk)*0.22
   *         + (100-opp_perf)*0.14
   *
   * Penalidades: -8 se draw_risk >= 32; -5 se form_gap < 8
   *
   * ── Classificação ────────────────────────────────────────────────
   *   raw >= 72 → Elite       (A+, finalScore = max(raw, 88))
   *   raw >= 63 → Alta        (A,  finalScore = max(raw, 82))
   *   raw >= 55 → Boa Entrada (A,  finalScore = max(raw, 76))
   *   raw <  55 → descartado
   *
   * ── Hierarquia ───────────────────────────────────────────────────
   *   RF  (Vitória) → principal quando existe
   *   DNB → alternativa conservadora ou principal se RF não passa
   *   DC  → alternativa ultra segura
   *
   * @returns {{ score, market, side, pickType, dnbLabel }}
   */
  function scoreDNB(raw, d, norm) {
    const _n = v => (v !== null && v !== undefined && Number.isFinite(Number(v))) ? Number(v) : null;

    const home_prob     = _n(raw.win_home);
    const away_prob     = _n(raw.win_away);
    const draw_prob_api = _n(raw.win_draw);
    const pv            = _rfProbValida(home_prob, draw_prob_api, away_prob);

    const home_form     = _rfFormScore(raw.home_form_score);
    const away_form     = _rfFormScore(raw.away_form_score);

    const home_home_p   = _n(raw.home_home_perf);
    const away_away_p   = _n(raw.away_away_perf);

    const avg_sc_h      = _n(raw.avg_sc_h);
    const avg_sc_a      = _n(raw.avg_sc_a);
    const home_conc     = _n(raw.home_avg_conc_home);
    const away_conc     = _n(raw.away_avg_conc_away);

    // draw_risk: usa prob. API se válida, senão estima via form
    let draw_risk = null;
    if (pv && draw_prob_api !== null) {
      draw_risk = draw_prob_api;
    } else if (home_form !== null && away_form !== null) {
      const gap = Math.abs(home_form - away_form);
      draw_risk = Math.max(18, 48 - gap * 0.4);
    }

    // Prob só entra se válida — senão 50 (neutro)
    const away_p_score = (pv && away_prob !== null) ? away_prob : 50;
    const home_p_score = (pv && home_prob !== null) ? home_prob : 50;

    // ── Score function ────────────────────────────────────────────
    function _score(prob, fg, lp, dr, op) {
      const dr_v = dr  !== null ? dr  : 30;
      const op_v = op  !== null ? op  : 50;
      const fg_v = fg  !== null ? fg  : 0;
      const lp_v = lp  !== null ? lp  : 50;
      let s;
      if (prob !== null && pv) {
        s = prob  * 0.28
          + fg_v  * 0.24
          + lp_v  * 0.22
          + (100 - dr_v) * 0.16
          + (100 - op_v) * 0.10;
      } else {
        s = fg_v  * 0.34
          + lp_v  * 0.30
          + (100 - dr_v) * 0.22
          + (100 - op_v) * 0.14;
      }
      if (draw_risk !== null && draw_risk >= 32) s -= 8;
      if (fg !== null && fg < 8)                 s -= 5;
      return Math.min(100, Math.round(s * 10) / 10);
    }

    // ── Classificação ─────────────────────────────────────────────
    function _classify(s) {
      if (s >= 72) return { label: 'Elite',       grade: 'A+', finalScore: Math.max(s, 88) };
      if (s >= 63) return { label: 'Alta',        grade: 'A',  finalScore: Math.max(s, 82) };
      if (s >= 55) return { label: 'Boa Entrada', grade: 'A',  finalScore: Math.max(s, 76) };
      return null;
    }

    // ── DNB Casa ──────────────────────────────────────────────────
    const form_gap_h = (home_form !== null && away_form !== null) ? home_form - away_form : null;

    const casa_ok = all([
      form_gap_h === null  || form_gap_h  >= 6,
      home_home_p === null || home_home_p >= 65,
      away_away_p === null || away_away_p <= 62,
      avg_sc_h === null    || avg_sc_h    >= 1.3,
      away_conc === null   || away_conc   >= 1.1,
      !pv || away_p_score <= 40,   // prob válida → visitante não pode ter prob alta
    ]) && (form_gap_h !== null || home_home_p !== null);

    if (casa_ok) {
      const s = _score(home_prob, form_gap_h, home_home_p, draw_risk, away_away_p);
      const cls = _classify(s);
      if (cls) {
        return {
          score:    Math.min(100, cls.finalScore),
          market:   'Resultado Final (1X2) - Casa DNB',
          side:     'home',
          pickType: 'dnb',
          dnbLabel: cls.label,
          prob_valida: pv,
        };
      }
    }

    // ── DNB Fora ──────────────────────────────────────────────────
    const form_gap_a = (home_form !== null && away_form !== null) ? away_form - home_form : null;

    const fora_ok = all([
      form_gap_a === null  || form_gap_a  >= 6,
      away_away_p === null || away_away_p >= 62,
      home_home_p === null || home_home_p <= 62,
      avg_sc_a === null    || avg_sc_a    >= 1.2,
      home_conc === null   || home_conc   >= 1.1,
      !pv || home_p_score <= 40,
    ]) && (form_gap_a !== null || away_away_p !== null);

    if (fora_ok) {
      const s = _score(away_prob, form_gap_a, away_away_p, draw_risk, home_home_p);
      const cls = _classify(s);
      if (cls) {
        return {
          score:    Math.min(100, cls.finalScore),
          market:   'Resultado Final (1X2) - Visitante DNB',
          side:     'away',
          pickType: 'dnb',
          dnbLabel: cls.label,
          prob_valida: pv,
        };
      }
    }

    return { score: null, market: null, side: null, pickType: null };
  }

  // helper interno — verifica se todos os booleans são true
  function all(arr) { return arr.every(Boolean); }


  /**
   * scoreDuplaChance(raw, d, norm)
   * Lógica PackBall v3.0 — Dupla Chance 1X e X2.
   *
   * ── Conceito ─────────────────────────────────────────────────────
   * Não prevê vitória — prevê quem provavelmente NÃO PERDE.
   * Filtros menos rígidos que Vitória Seca, mas protegem contra zebra.
   *
   * ── Score 1X (Casa ou Empate) ────────────────────────────────────
   *   score_1x = home_form*0.25 + home_home_perf*0.25
   *            + (100-away_away_perf)*0.15 + (100-away_prob)*0.15
   *            + avg_sc_h*5 - avg_sc_a*4 - home_conc*4
   *
   * ── Score X2 (Fora ou Empate) ────────────────────────────────────
   *   score_x2 = away_form*0.25 + away_away_perf*0.25
   *            + (100-home_home_perf)*0.15 + (100-home_prob)*0.15
   *            + avg_sc_a*5 - avg_sc_h*4 - away_conc*4
   *
   * ── Elegibilidade ────────────────────────────────────────────────
   *   score >= 70 E diferença >= 5 em relação ao lado oposto
   *
   * ── Classificação ────────────────────────────────────────────────
   *   >= 85 → Elite       (A+, finalScore = max(raw, 88))
   *   >= 78 → Alta        (A,  finalScore = max(raw, 82))
   *   >= 70 → Boa Entrada (A,  finalScore = max(raw, 76))
   *   <  70 → descartado
   *
   * ── Independência da API ─────────────────────────────────────────
   *   Usa _rfProbValida() para detectar placeholder.
   *   Se placeholder: away_prob/home_prob contribuem com 0 no score.
   *
   * @returns {{ score, market, side, pickType, dcLabel }}
   */
  function scoreDuplaChance(raw, d, norm) {
    const _n = v => (v !== null && v !== undefined && Number.isFinite(Number(v))) ? Number(v) : null;

    const home_prob     = _n(raw.win_home);
    const away_prob     = _n(raw.win_away);
    const draw_prob_api = _n(raw.win_draw);
    const pv            = _rfProbValida(home_prob, draw_prob_api, away_prob);

    const home_form     = _rfFormScore(raw.home_form_score);
    const away_form     = _rfFormScore(raw.away_form_score);

    const home_home_p   = _n(raw.home_home_perf);
    const away_away_p   = _n(raw.away_away_perf);

    const avg_sc_h      = _n(raw.avg_sc_h);
    const avg_sc_a      = _n(raw.avg_sc_a);
    const home_conc     = _n(raw.home_avg_conc_home);
    const away_conc     = _n(raw.away_avg_conc_away);

    // Prob só entra no score se for válida — senão contribui com 50 (neutro)
    const away_p_score  = (pv && away_prob !== null) ? away_prob : 50;
    const home_p_score  = (pv && home_prob !== null) ? home_prob : 50;

    // ── Score 1X ──────────────────────────────────────────────────
    let score_1x = 0;
    score_1x += (home_form     ?? 50) * 0.25;
    score_1x += (home_home_p   ?? 50) * 0.25;
    score_1x += (100 - (away_away_p  ?? 50)) * 0.15;
    score_1x += (100 - away_p_score) * 0.15;
    score_1x += (avg_sc_h  ?? 1.2) * 5;
    score_1x -= (avg_sc_a  ?? 1.0) * 4;
    score_1x -= (home_conc ?? 1.0) * 4;
    score_1x  = Math.min(100, Math.round(score_1x * 10) / 10);

    // ── Score X2 ──────────────────────────────────────────────────
    let score_x2 = 0;
    score_x2 += (away_form     ?? 50) * 0.25;
    score_x2 += (away_away_p   ?? 50) * 0.25;
    score_x2 += (100 - (home_home_p  ?? 50)) * 0.15;
    score_x2 += (100 - home_p_score) * 0.15;
    score_x2 += (avg_sc_a  ?? 1.2) * 5;
    score_x2 -= (avg_sc_h  ?? 1.0) * 4;
    score_x2 -= (away_conc ?? 1.0) * 4;
    score_x2  = Math.min(100, Math.round(score_x2 * 10) / 10);

    // ── Classificação ─────────────────────────────────────────────
    function _classify(s) {
      if (s >= 85) return { label: 'Elite',       grade: 'A+', finalScore: Math.max(s, 88) };
      if (s >= 78) return { label: 'Alta',        grade: 'A',  finalScore: Math.max(s, 82) };
      if (s >= 70) return { label: 'Boa Entrada', grade: 'A',  finalScore: Math.max(s, 76) };
      return null;
    }

    // ── Elegibilidade: score >= 70 e diferença >= 5 ───────────────
    const eligible_1x = score_1x >= 70 && (score_1x - score_x2) >= 5;
    const eligible_x2 = score_x2 >= 70 && (score_x2 - score_1x) >= 5;

    // Prioriza o de maior score
    if (eligible_1x && (!eligible_x2 || score_1x >= score_x2)) {
      const cls = _classify(score_1x);
      if (cls) {
        return {
          score:    Math.min(100, cls.finalScore),
          market:   'Resultado Final (1X2) - Dupla Chance 1X',
          side:     'home',
          pickType: 'dc',
          dcLabel:  cls.label,
          prob_valida: pv,
        };
      }
    }

    if (eligible_x2) {
      const cls = _classify(score_x2);
      if (cls) {
        return {
          score:    Math.min(100, cls.finalScore),
          market:   'Resultado Final (1X2) - Dupla Chance X2',
          side:     'away',
          pickType: 'dc',
          dcLabel:  cls.label,
          prob_valida: pv,
        };
      }
    }

    return { score: null, market: null, side: null, pickType: null };
  }



  // ═══════════════════════════════════════════════════════════════
  // 5. FILTRO 3 VIAS — Over 1.5 (modo API / coletar.py)  §6
  // ═══════════════════════════════════════════════════════════════

  /**
   * filtroOver15(raw, d)
   * Retorna true se o jogo passar em ao menos UMA das 4 vias.
   * Thresholds do coletar.py (modo API).
   *
   * Via 1: exg_tot != null AND exg_tot >= 4.5
   * Via 2: exg_tot >= 2.0 AND ppg_min >= 0.7
   * Via 3: exg_tot = null AND over15_g >= 90 AND ppg_avg >= 1.5
   * Via 4: over15_g >= 85  (exclusiva do coletar.py)
   *
   * @param {object} raw
   * @param {object} d   — derivadas
   * @returns {{ passed: boolean, via: number|null }}
   */
  // ═══════════════════════════════════════════════════════════════
  // 5. FILTRO 3 VIAS — Over 1.5 (modo API / coletar.py)  §6
  // ═══════════════════════════════════════════════════════════════

  /**
   * filtroOver15(raw, d)
   * Retorna true se o jogo passar em ao menos UMA das 4 vias.
   * Thresholds do coletar.py (modo API).
   *
   * Via 1: exg_tot != null AND exg_tot >= 4.5
   * Via 2: exg_tot >= 2.0 AND ppg_min >= 0.7
   * Via 3: exg_tot = null AND over15_g >= 90 AND ppg_avg >= 1.5
   * Via 4: over15_g >= 85  (exclusiva do coletar.py)
   *
   * @param {object} raw
   * @param {object} d   — derivadas
   * @returns {{ passed: boolean, via: number|null }}
   */
  function filtroOver15(raw, d) {
    const { over15_g }     = raw;
    const { exg_tot, ppg_min, ppg_avg } = d;

    // Via 1 — xG alto
    if (exg_tot !== null && exg_tot >= 4.5) {
      return { passed: true, via: 1 };
    }

    // Via 2 — Equilíbrio
    if (exg_tot !== null && exg_tot >= 2.0 && ppg_min !== null && ppg_min >= 0.7) {
      return { passed: true, via: 2 };
    }

    // Via 3 — Sem xG
    if (exg_tot === null && over15_g != null && over15_g >= 90 && ppg_avg !== null && ppg_avg >= 1.5) {
      return { passed: true, via: 3 };
    }

    // Via 4 — Predictions (exclusiva modo API)
    if (over15_g != null && over15_g >= 85) {
      return { passed: true, via: 4 };
    }

    return { passed: false, via: null };
  }


  // ═══════════════════════════════════════════════════════════════
  // 6. FILTRO UNDER 3.5  §4.6
  // ═══════════════════════════════════════════════════════════════

  /**
   * filtroUnder35(raw, d, s_u35, poiss)
   * O jogo passa se TODAS as condições forem verdadeiras:
   *   1. s_u35 >= 75
   *   2. over25_g <= 55 AND h2h_goals <= 3.0 AND btts_cf <= 75
   *   3a. (com xG) poisson_u35 >= 78 AND exg_tot <= 2.5
   *   3b. (sem xG) exg_tot = null AND u25cf >= 65 AND ppg_avg <= 1.6
   *
   * @param {object}      raw
   * @param {object}      d      — derivadas
   * @param {number|null} s_u35  — score Under 3.5
   * @param {object|null} poiss  — probabilidades Poisson
   * @returns {boolean}
   */
  function filtroUnder35(raw, d, s_u35, poiss) {
    if (s_u35 === null || s_u35 < 75) return false;

    // Condição 2 — blockers
    const { over25_g, h2h_goals } = raw;
    const { btts_cf }             = d;

    if (over25_g != null && over25_g > 55)  return false;
    if (h2h_goals != null && h2h_goals > 3.0) return false;
    if (btts_cf != null && btts_cf > 75)    return false;

    // Condição 3a — com xG
    if (d.exg_tot !== null) {
      if (!poiss || poiss.u35 < 78) return false;
      if (d.exg_tot > 2.5)         return false;
      return true;
    }

    // Condição 3b — sem xG
    if (d.u25cf === null || d.u25cf < 65)    return false;
    if (d.ppg_avg === null || d.ppg_avg > 1.6) return false;
    return true;
  }


  // ═══════════════════════════════════════════════════════════════
  // 7. GRADE e CONFIANÇA  §5.1
  // ═══════════════════════════════════════════════════════════════

  /**
   * getGrade(score)
   * Converte score numérico (0–100) em grade.
   * Thresholds v1:
   *   A+: >= 88  |  A: >= 80  |  B: >= 70  |  C: >= 60  |  D: < 60
   *
   * @param {number|null} score
   * @returns {string}  'A+' | 'A' | 'B' | 'C' | 'D'
   */
  function getGrade(score) {
    if (score === null || score === undefined) return 'D';
    if (score >= GRADE_THRESHOLDS['A+']) return 'A+';
    if (score >= GRADE_THRESHOLDS['A'])  return 'A';
    if (score >= GRADE_THRESHOLDS['B'])  return 'B';
    if (score >= GRADE_THRESHOLDS['C'])  return 'C';
    return 'D';
  }

  /**
   * getConfidence(grade)
   * Converte grade em label de confiança exibido na UI.
   *
   * @param {string} grade
   * @returns {string}  'Muito Baixo' | 'Baixo' | 'Médio' | 'Alto' | 'Muito Alto'
   */
  function getConfidence(grade) {
    return CONFIDENCE_LABELS[grade] || 'Muito Alto';
  }


  // ═══════════════════════════════════════════════════════════════
  // 8. SELEÇÃO DE BEST_MKT  §5.2
  // ═══════════════════════════════════════════════════════════════

  /**
   * selectBestMkt(scores, filters)
   * Escolhe o mercado com maior score entre os elegíveis.
   *
   * Documentação §5.2:
   *   candidatos = [
   *     ('Over 1.5',   s15,      passou_over15),
   *     ('Over 2.5',   s25,      True),
   *     ('BTTS',       s_btts,   True),
   *     ('Over 0.5 HT',s_05ht,   True),
   *     ('Under 4.5',  s_u45,    True),
   *     ('Under 3.5',  s_u35,    under35_passou),
   *     ('Esc 7.5',    s_esc75,  True),
   *     ('Cart 2.5',   s_cards25,True),
   *   ]
   *   best = max(candidatos, key=lambda x: x[1] if x[2] else 0)
   *
   * V1 COMPAT: passed_filtro (over15_passed) afeta APENAS a elegibilidade
   * do Over 1.5. Todos os outros mercados têm eligible=true.
   * O resultado do selectBestMkt (best_mkt) é válido para snapshot
   * independentemente do over15_passed — se outro mercado venceu, é esse
   * que vai para o banco, sem nenhuma barreira adicional.
   *
   * Nota: a documentação lista 8 candidatos (inclui Over 1.5 e Under 3.5
   * com filtros, mas não inclui Esc 8.5 e Cart 3.5 explicitamente).
   * Esc 8.5 e Cart 3.5 são scores calculados mas não estão nos candidatos
   * do best_mkt segundo §5.2 — mantemos a lista exata da documentação.
   *
   * @param {object}  scores   — { over15, over25, btts, over05ht, under45, under35, esc75, cards25 … }
   * @param {object}  filters  — { over15_passed, under35_passed }
   * @returns {{ market:string, score:number, grade:string, confidence:string }|null}
   */
  function selectBestMkt(scores, filters) {
    const candidatos = [
      { market: filters.resultadoFinal_market || 'Resultado Final (1X2)', score: scores.resultadoFinal, eligible: true },
      { market: filters.dnb_market || 'Resultado Final (1X2) - DNB', score: scores.dnb, eligible: scores.dnb !== null },
      { market: filters.duplaChance_market || 'Resultado Final (1X2) - Dupla Chance', score: scores.duplaChance, eligible: scores.duplaChance !== null },
      { market: 'Over 1.5 gols', score: scores.over15, eligible: filters.over15_passed  },
      { market: 'Over 2.5 gols', score: scores.over25, eligible: true                   },
      { market: 'BTTS',        score: scores.btts,    eligible: true                   },
      { market: 'Over 0.5 HT', score: scores.over05ht,eligible: true                   },
      { market: 'Under 4.5 gols', score: scores.under45, eligible: true                   },
      { market: 'Under 3.5 gols', score: scores.under35, eligible: filters.under35_passed },
      { market: 'Over 7.5 cantos', score: scores.esc75, eligible: true                   },
      { market: 'Over 8.5 cantos', score: scores.esc85, eligible: true                   },
      { market: 'Over 2.5 cartão', score: scores.cards25, eligible: true                 },
      { market: 'Over 3.5 cartão', score: scores.cards35, eligible: true                 },
      { market: 'Over 5.5 cartão', score: scores.cards55, eligible: true                 },
    ];

    let best = null;

    for (const c of candidatos) {
      if (c.score === null) continue;
      const effectiveScore = c.eligible ? c.score : 0;
      if (best === null || effectiveScore > best.effectiveScore) {
        best = {
          market:         c.market,
          score:          c.score,
          effectiveScore: effectiveScore,
          eligible:       c.eligible,
        };
      }
    }

    if (!best) return null;

    const grade      = getGrade(best.score);
    const confidence = getConfidence(grade);

    return {
      market:     best.market,
      score:      best.score,
      grade:      grade,
      confidence: confidence,
      eligible:   best.eligible,
    };
  }

  function buildMainMarkets(scores, grades, odds, evs, filters) {
    const candidatos = [
      { key: 'resultadoFinal', market: filters.resultadoFinal_market || 'Resultado Final (1X2)' },
      { key: 'dnb',            market: filters.dnb_market            || 'Resultado Final (1X2) - DNB' },
      { key: 'duplaChance',    market: filters.duplaChance_market    || 'Resultado Final (1X2) - Dupla Chance' },
      { key: 'over15', market: 'Over 1.5 gols' },
      { key: 'over25', market: 'Over 2.5 gols' },
      { key: 'btts', market: 'BTTS' },
      { key: 'over05ht', market: 'Over 0.5 HT' },
      { key: 'under45', market: 'Under 4.5 gols' },
      { key: 'under35', market: 'Under 3.5 gols' },
      { key: 'esc75', market: 'Over 7.5 cantos' },
      { key: 'esc85', market: 'Over 8.5 cantos' },
      { key: 'cards25', market: 'Over 2.5 cartão' },
      { key: 'cards35', market: 'Over 3.5 cartão' },
      { key: 'cards55', market: 'Over 5.5 cartão' },
    ];

    return candidatos
      .map(c => {
        const score = scores[c.key];
        if (score === null || score === undefined || !Number.isFinite(Number(score))) return null;
        const grade = grades[c.key] || getGrade(score);
        return {
          key: c.key,
          market: c.market,
          score,
          grade,
          confidence: getConfidence(grade),
          odd: odds[c.key] ?? null,
          ev: evs[c.key] ?? null,
        };
      })
      .filter(Boolean);
  }


  // ═══════════════════════════════════════════════════════════════
  // 9. EXPECTED VALUE
  // ═══════════════════════════════════════════════════════════════

  /**
   * computeEV(probability, odd)
   * EV = (prob/100 × odd − 1) × 100
   * Retorna null se probability ou odd forem nulos.
   *
   * @param {number|null} probability  — 0–100
   * @param {number|null} odd
   * @returns {number|null}            EV em % (pode ser negativo)
   */
  function computeEV(probability, odd) {
    if (probability === null || probability === undefined) return null;
    if (odd === null || odd === undefined || odd <= 0)    return null;
    return Math.round(((probability / 100) * odd - 1) * 100 * 10) / 10;
  }

  function _finite(v) {
    return v !== null && v !== undefined && Number.isFinite(Number(v));
  }

  function _hasAll(raw, fields) {
    return fields.every(f => _finite(raw[f]));
  }

  function _signalCount(raw, fields) {
    return fields.reduce((n, f) => n + (_finite(raw[f]) ? 1 : 0), 0);
  }

  function _fairOdd(score) {
    return _finite(score) && Number(score) > 0 ? 100 / Number(score) : null;
  }

  function _marketKeyFromName(market) {
    return _mktKey(market);
  }

  function premiumMarketAudit(key, market, raw, score, odd, ev, filters) {
    const gradeByScore = getGrade(score);
    const reasons = [];
    if (!GRADES_OFICIAIS.has(gradeByScore)) reasons.push('score abaixo de A');
    if (!_finite(score)) reasons.push('probabilidade ausente');
    if (!_finite(odd) || Number(odd) <= 1) reasons.push('odd de mercado ausente');
    if (!_finite(ev)) reasons.push('EV ausente');

    const fairOdd = _fairOdd(score);
    if (!_finite(fairOdd)) reasons.push('odd justa ausente');
    if (_finite(odd) && _finite(fairOdd) && Number(odd) < fairOdd) {
      reasons.push('sem margem de seguranca');
    }

    let signals = 0;
    let marketOk = true;

    if (key === 'over15') {
      marketOk = !!filters.over15_passed && _hasAll(raw, ['ppg_h', 'ppg_a', 'avg_sc_h', 'avg_sc_a']);
      signals = _signalCount(raw, ['over15_g', 'ppg_h', 'ppg_a', 'avg_sc_h', 'avg_sc_a', 'h2h_goals', 'exg_h', 'exg_a']);
    } else if (key === 'over25') {
      marketOk = _hasAll(raw, ['over25_g', 'ppg_h', 'ppg_a', 'avg_sc_h', 'avg_sc_a']);
      signals = _signalCount(raw, ['over25_g', 'ppg_h', 'ppg_a', 'avg_sc_h', 'avg_sc_a', 'h2h_goals', 'exg_h', 'exg_a']);
    } else if (key === 'btts') {
      marketOk = _hasAll(raw, ['btts_h', 'btts_a', 'avg_sc_h', 'avg_sc_a']);
      signals = _signalCount(raw, ['btts_h', 'btts_a', 'avg_sc_h', 'avg_sc_a', 'h2h_goals', 'over15_g']);
    } else if (key === 'over05ht') {
      marketOk = _hasAll(raw, ['over05_ht', 'over15_ht', 'ppg_h', 'ppg_a']);
      signals = _signalCount(raw, ['over05_ht', 'over15_ht', 'ppg_h', 'ppg_a', 'avg_sc_h', 'avg_sc_a', 'avg_sot']);
    } else if (key === 'under45') {
      marketOk = _hasAll(raw, ['ppg_h', 'ppg_a']) && (_finite(raw.under25_h) || _finite(raw.exg_h));
      signals = _signalCount(raw, ['under25_h', 'under25_a', 'ppg_h', 'ppg_a', 'exg_h', 'exg_a', 'h2h_goals']);
    } else if (key === 'under35') {
      marketOk = !!filters.under35_passed && _hasAll(raw, ['ppg_h', 'ppg_a']);
      signals = _signalCount(raw, ['under25_h', 'under25_a', 'ppg_h', 'ppg_a', 'exg_h', 'exg_a', 'h2h_goals', 'over25_g']);
    } else if (key === 'esc75' || key === 'esc85') {
      const overField = key === 'esc85' ? 'over85_c' : 'over75_c';
      marketOk = _hasAll(raw, ['avg_corners', overField, 'avg_shots']);
      signals = _signalCount(raw, ['avg_corners', overField, 'over65_c', 'avg_shots']);
    } else if (key === 'cards25' || key === 'cards35' || key === 'cards55') {
      const overField = key === 'cards35' ? 'over35_cards' : key === 'cards55' ? 'over45_cards' : 'over25_cards';
      marketOk = _hasAll(raw, ['avg_cards', overField]);
      signals = _signalCount(raw, ['avg_cards', overField, 'over25_cards', 'over35_cards']);
    } else if (key === 'resultadoFinal') {
      marketOk = _hasAll(raw, ['odds_h', 'odds_a']) && (_finite(raw.win_home) || _hasAll(raw, ['ppg_h', 'ppg_a']));
      signals = _signalCount(raw, ['odds_h', 'odds_a', 'win_home', 'win_away', 'ppg_h', 'ppg_a', 'exg_h', 'exg_a', 'avg_sc_h', 'avg_sc_a']);
    }

    if (!marketOk) reasons.push('regra especifica do mercado nao cumprida');

    const officialGrade = gradeByScore;
    return {
      market,
      key,
      raw_grade: gradeByScore,
      official_grade: officialGrade,
      is_premium: GRADES_OFICIAIS.has(officialGrade),
      fair_odd: fairOdd !== null ? Math.round(fairOdd * 100) / 100 : null,
      safety_margin: (_finite(odd) && _finite(fairOdd)) ? Math.round(((Number(odd) / fairOdd) - 1) * 1000) / 10 : null,
      reasons,
    };
  }

  function applyPremiumAudit(raw, scores, grades, odds, evs, filters, best) {
    const audits = {};
    for (const [key, score] of Object.entries(scores)) {
      const market = key === 'resultadoFinal'
        ? (filters.resultadoFinal_market || 'Resultado Final (1X2)')
        : Object.entries(_MKT_TO_KEY).find(([, v]) => v === key)?.[0] || key;
      const audit = premiumMarketAudit(key, market, raw, score, odds[key], evs[key], filters);
      audits[key] = audit;
    }

    if (!best) return { audits, bestAudit: null };
    const bestKey = _marketKeyFromName(best.market);
    const bestAudit = bestKey ? audits[bestKey] : null;
    return { audits, bestAudit };
  }


  // ═══════════════════════════════════════════════════════════════
  // 10. PIPELINE COMPLETO — processFixture(raw)
  // ═══════════════════════════════════════════════════════════════

  /**
   * processFixture(raw)
   * Executa o pipeline completo do PackBall v3.0 para um único jogo.
   *
   * Entrada (raw):
   * ─────────────
   * Identificação:
   *   fixture_id, home_team, away_team, league_name, match_date, hour
   *
   * Variáveis brutas (seção 3.1):
   *   over15_g, over25_g         — % predictions API
   *   exg_h, exg_a               — xG por time
   *   ppg_h, ppg_a               — PPG por time
   *   h2h_goals                  — média gols H2H
   *   avg_sc_h, avg_sc_a         — média gols marcados
   *   btts_h, btts_a             — % BTTS por time
   *   over05_ht, over15_ht       — % gol HT
   *   avg_corners                — média cantos
   *   over65_c, over75_c, over85_c — % cantos
   *   avg_cards                  — média cartões
   *   over25_cards, over35_cards — % cartões
   *   avg_shots, avg_sot         — finalizações
   *   under25_h, under25_a       — % Under 2.5 por time
   *
   * Odds (uma por mercado, null se indisponível):
   *   odd_o15, odd_o25, odd_btts, odd_05ht
   *   odd_u35, odd_u45, odd_esc75, odd_esc85
   *   odd_c25, odd_c35
   *
   * Odds justas (calculadas pelo modelo, para EV):
   *   odd_justa_15, odd_justa_25, odd_justa_btts
   *   odd_justa_05ht, odd_justa_esc85, odd_justa_cart25
   *
   * Saída:
   * ──────
   *   fixture_id, home_team, away_team, league_name, match_date, hour
   *   derivadas: { exg_tot, ppg_avg, ppg_min, af_avg, btts_cf, u25cf }
   *   normalizadas: { ppg_n, af_n, exg_n, h2h_nv, cant_n, shots_n, cards_n, sot_n }
   *   poisson: { o15, o25, u35, u45 } | null
   *   scores:  { over15, over25, btts, over05ht, under45, under35, esc75, esc85, cards25, cards35 }
   *   grades:  { over15, over25, btts, over05ht, under45, under35, esc75, esc85, cards25, cards35 }
   *   odds:    { over15, over25, btts, over05ht, under45, under35, esc75, esc85, cards25, cards35 }
   *   evs:     { over15, over25, btts, over05ht, under45, under35, esc75, esc85, cards25, cards35 }
   *   filters: { over15_passed, over15_via, under35_passed }
   *   best_mkt, best_score, best_grade, best_confidence, best_odd, best_ev
   *   is_official: boolean  — true se best_grade em ['A+', 'A']
   *
   * @param {object} raw
   * @returns {object}
   */
  function processFixture(raw) {

    // ── Etapa 1: Derivadas ─────────────────────────────────────
    const d     = computeDerivadas(raw);

    // ── Etapa 2: Normalizadas ──────────────────────────────────
    const norm  = computeNormalizadas(raw, d);

    // ── Etapa 3: Poisson ───────────────────────────────────────
    const poiss = poissonProbs(d.exg_tot);

    // ── Etapa 4: Scores por mercado ────────────────────────────
    const s15      = scoreOver15(raw, d, norm, poiss);
    const s25      = scoreOver25(raw, d, norm, poiss);
    const s_btts   = scoreBTTS(raw, d, norm);
    const s_05ht   = scoreOver05HT(raw, d, norm);
    const s_u45    = scoreUnder45(raw, d, norm, poiss);
    const s_u35    = scoreUnder35(raw, d, norm, poiss);
    const s_esc75  = scoreEsc75(raw, d, norm);
    const s_esc85  = scoreEsc85(raw, d, norm);
    const s_c25    = scoreCards25(raw, d, norm);
    const s_c35    = scoreCards35(raw, d, norm);
    const s_c55    = scoreCards55(raw, d, norm);
    const rf       = scoreResultadoFinal(raw, d, norm);
    const dnb      = scoreDNB(raw, d, norm);
    const dc       = scoreDuplaChance(raw, d, norm);

    // ── Etapa 5: Filtros ───────────────────────────────────────
    const filtro15   = filtroOver15(raw, d);
    const under35_ok = filtroUnder35(raw, d, s_u35, poiss);

    // ── Etapa 6: Grades ────────────────────────────────────────
    // RF e DC são campos separados — nunca competem.
    // RF (Vitória) é sempre o principal quando existe.
    // DC (Dupla Chance) é sempre alternativa de segurança.
    const scores = {
      resultadoFinal: rf.score ?? null,
      dnb:            dnb.score ?? null,
      duplaChance:    dc.score ?? null,
      over15:  s15,
      over25:  s25,
      btts:    s_btts,
      over05ht: s_05ht,
      under45: s_u45,
      under35: s_u35,
      esc75:   s_esc75,
      esc85:   s_esc85,
      cards25: s_c25,
      cards35: s_c35,
      cards55: s_c55,
    };

    const grades = {};
    for (const [mkt, sc] of Object.entries(scores)) {
      grades[mkt] = getGrade(sc);
    }
    const raw_grades = Object.assign({}, grades);

    // ── Etapa 7: Odds coletadas ────────────────────────────────
    const odds = {
      resultadoFinal: rf.side === 'home' ? (raw.odds_h ?? null)
                    : rf.side === 'away' ? (raw.odds_a ?? null)
                    : null,
      dnb:           dnb.side === 'home' ? (raw.odds_h ?? null)
                    : dnb.side === 'away' ? (raw.odds_a ?? null)
                    : null,
      duplaChance:   dc.side === 'home' ? (raw.odds_h ?? null)
                    : dc.side === 'away' ? (raw.odds_a ?? null)
                    : null,
      over15:   raw.odd_o15   ?? null,
      over25:   raw.odd_o25   ?? null,
      btts:     raw.odd_btts  ?? null,
      over05ht: raw.odd_05ht  ?? null,
      under45:  raw.odd_u45   ?? null,
      under35:  raw.odd_u35   ?? null,
      esc75:    raw.odd_esc75 ?? null,
      esc85:    raw.odd_esc85 ?? null,
      cards25:  raw.odd_c25   ?? null,
      cards35:  raw.odd_c35   ?? null,
      cards55:  raw.odd_c55   ?? null,
    };

    // ── Etapa 8: EV por mercado ────────────────────────────────
    // Usa probability = score (escala 0–100) e odd coletada
    const evs = {};
    for (const [mkt, sc] of Object.entries(scores)) {
      evs[mkt] = computeEV(sc, odds[mkt]);
    }

    // ── Etapa 9: Best_mkt ──────────────────────────────────────
    const filters = {
      over15_passed: filtro15.passed,
      over15_via:    filtro15.via,
      under35_passed: under35_ok,
      resultadoFinal_market: rf.market  ?? null,
      dnb_market:            dnb.market ?? null,
      dnb_side:              dnb.side   ?? null,
      duplaChance_market:    dc.market  ?? null,
      duplaChance_side:      dc.side    ?? null,
    };

    const best = selectBestMkt(scores, filters);
    const premiumAudit = applyPremiumAudit(raw, scores, grades, odds, evs, filters, best);

    const best_mkt        = best ? best.market     : null;
    const best_score      = best ? best.score      : null;
    const best_grade      = best ? best.grade : 'D';
    const best_confidence = getConfidence(best_grade);
    const best_odd        = best ? (odds[_mktKey(best.market)] ?? null) : null;
    const best_ev         = best ? computeEV(best.score, best_odd) : null;
    const is_official     = GRADES_OFICIAIS.has(best_grade);
    const main_markets    = buildMainMarkets(scores, grades, odds, evs, filters);

    return {
      // Identificação
      fixture_id:   raw.fixture_id   ?? null,
      home_team:    raw.home_team    ?? '',
      away_team:    raw.away_team    ?? '',
      jogo:         raw.home_team && raw.away_team
                      ? `${raw.home_team} vs ${raw.away_team}`
                      : '',
      league_name:  raw.league_name  ?? '',
      match_date:   raw.match_date   ?? null,
      hour:         raw.hour         ?? null,

      // Dados de cálculo intermediário
      derivadas:   d,
      normalizadas: norm,
      poisson:     poiss,

      // Scores, grades, odds, EVs por mercado
      scores,
      raw_grades,
      grades,
      odds,
      evs,

      // Filtros
      filters,

      // DNB — alternativa conservadora (independente do RF)
      dnb_market:   dnb.market  ?? null,
      dnb_score:    dnb.score   ?? null,
      dnb_side:     dnb.side    ?? null,
      dnb_label:    dnb.dnbLabel ?? null,
      dnb_odd:      dnb.side === 'home' ? (raw.odds_h ?? null)
                  : dnb.side === 'away' ? (raw.odds_a ?? null)
                  : null,

      // Dupla Chance — alternativa de segurança (independente do RF)
      dc_market:    dc.market  ?? null,
      dc_score:     dc.score   ?? null,
      dc_side:      dc.side    ?? null,
      dc_label:     dc.dcLabel ?? null,
      dc_odd:       dc.side === 'home' ? (raw.odds_h ?? null)
                  : dc.side === 'away' ? (raw.odds_a ?? null)
                  : null,

      // Melhor mercado (best_mkt)
      best_mkt,
      best_score,
      best_grade,
      best_confidence,
      best_odd,
      best_ev,
      main_markets,
      premium_audit: premiumAudit.audits,
      best_premium_audit: premiumAudit.bestAudit,
      is_official,   // true se A+ ou A — entra em Melhores Previsões
    };
  }


  // ═══════════════════════════════════════════════════════════════
  // HELPER: mapeamento market → chave interna de odds/evs
  // ═══════════════════════════════════════════════════════════════

  const _MKT_TO_KEY = {
    'Resultado Final (1X2)': 'resultadoFinal',
    'Resultado Final (1X2) - Casa DNB':        'dnb',
    'Resultado Final (1X2) - Visitante DNB':   'dnb',
    'Casa DNB':        'dnb',
    'Visitante DNB':   'dnb',
    'Resultado Final (1X2) - Dupla Chance 1X': 'duplaChance',
    'Resultado Final (1X2) - Dupla Chance X2': 'duplaChance',
    'Dupla Chance 1X': 'duplaChance',
    'Dupla Chance X2': 'duplaChance',
    'Over 1.5 gols': 'over15',
    'Over 2.5 gols': 'over25',
    'Over 1.5':    'over15',
    'Over 2.5':    'over25',
    'BTTS':        'btts',
    'Over 0.5 HT': 'over05ht',
    'Under 4.5 gols': 'under45',
    'Under 3.5 gols': 'under35',
    'Under 4.5':   'under45',
    'Under 3.5':   'under35',
    'Over 7.5 cantos': 'esc75',
    'Over 8.5 cantos': 'esc85',
    'Esc 7.5':     'esc75',
    'Esc 8.5':     'esc85',
    'Over 2.5 cartão': 'cards25',
    'Over 3.5 cartão': 'cards35',
    'Over 5.5 cartão': 'cards55',
    'Cart 2.5':    'cards25',
    'Cart 3.5':    'cards35',
    'Cart 5.5':    'cards55',
  };

  function _mktKey(market) {
    if (String(market || '').startsWith('Resultado Final (1X2)')) {
      if (market.includes('Dupla Chance')) return 'duplaChance';
      if (market.includes('DNB'))         return 'dnb';
      return 'resultadoFinal';
    }
    return _MKT_TO_KEY[market] ?? null;
  }


  // ═══════════════════════════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════════════════════════

  return {
    // Funções matemáticas base
    n,
    ws,
    poissonProbs,

    // Pipeline de cálculo
    computeDerivadas,
    computeNormalizadas,

    // Score engine por mercado
    scoreOver15,
    scoreOver25,
    scoreBTTS,
    scoreOver05HT,
    scoreUnder45,
    scoreUnder35,
    scoreEsc75,
    scoreEsc85,
    scoreCards25,
    scoreCards35,
    scoreCards55,

    // Filtros
    filtroOver15,
    filtroUnder35,

    // Grade e confiança
    getGrade,
    getConfidence,

    // Seleção de melhor mercado
    selectBestMkt,
    buildMainMarkets,

    // Expected Value
    computeEV,

    // Pipeline completo (entry point principal)
    processFixture,

    // Utilitários
    GRADE_THRESHOLDS,
    CONFIDENCE_LABELS,
    GRADES_OFICIAIS,
    NORM_LIMITS,
    MKT_TO_KEY: _MKT_TO_KEY,
  };

})();


// ─────────────────────────────────────────────────────────────────
// Compatibilidade: expõe como módulo ES6 E como global
// ─────────────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PredictionEngine;  // Node.js / Jest
}
// Browsers e Deno já têm acesso via window.PredictionEngine (IIFE)
