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
    sot_n:   { min: 0, max: 10 },
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
   * scoreOver15(raw, d, norm, poiss)
   * §4.1 — Over 1.5 Gols
   *
   * Com xG:
   *   ws([(over15_g,30),(o15cf,18),(h2h_nv,12),(ppg_n,12),(af_n,8),(exg_n,15),(poisson_o15,5)])
   *
   * Sem xG:
   *   ws([(over15_g,35),(o15cf,22),(h2h_nv,15),(ppg_n,15),(af_n,13)])
   */
  function scoreOver15(raw, d, norm, poiss) {
    const o15cf_val = _o15cf(raw, d);

    if (norm.exg_n !== null) {
      return ws([
        [raw.over15_g,             30],
        [o15cf_val,                18],
        [norm.h2h_nv,              12],
        [norm.ppg_n,               12],
        [norm.af_n,                 8],
        [norm.exg_n,               15],
        [poiss ? poiss.o15 : null,  5],
      ]);
    } else {
      return ws([
        [raw.over15_g, 35],
        [o15cf_val,    22],
        [norm.h2h_nv,  15],
        [norm.ppg_n,   15],
        [norm.af_n,    13],
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
   * scoreBTTS(raw, d, norm)
   * §4.3 — BTTS (Ambas Marcam)
   *
   * ws([(btts_cf,40),(h2h_nv,15),(ppg_n,15),(af_n,15),(over15_g,10),(exg_n|50,5)])
   */
  function scoreBTTS(raw, d, norm) {
    return ws([
      [d.btts_cf,                40],
      [norm.h2h_nv,              15],
      [norm.ppg_n,               15],
      [norm.af_n,                15],
      [raw.over15_g,             10],
      [_v(norm.exg_n, 50),        5],
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

  // ═══════════════════════════════════════════════════════════════
  // 5. FILTRO 3 VIAS — Over 1.5 (modo API / coletar.py)  §6
  // ═══════════════════════════════════════════════════════════════

  /**
   * filtroOver15(raw, d)
   * Retorna true se o jogo passar em ao menos UMA das 3 vias.
   *
   * Via 1: exg_tot != null AND exg_tot >= 4.5
   * Via 2: exg_tot >= 2.0 AND ppg_min >= 1.0
   * Via 3: exg_tot = null AND over15_g >= 90 AND ppg_avg >= 2.0
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
    if (exg_tot !== null && exg_tot >= 2.0 && ppg_min !== null && ppg_min >= 1.0) {
      return { passed: true, via: 2 };
    }

    // Via 3 — Sem xG
    if (exg_tot === null && over15_g != null && over15_g >= 90 && ppg_avg !== null && ppg_avg >= 2.0) {
      return { passed: true, via: 3 };
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
      { market: 'Over 1.5',   score: scores.over15,   eligible: filters.over15_passed  },
      { market: 'Over 2.5',   score: scores.over25,   eligible: true                   },
      { market: 'BTTS',       score: scores.btts,     eligible: true                   },
      { market: 'Over 0.5 HT',score: scores.over05ht, eligible: true                   },
      { market: 'Under 4.5',  score: scores.under45,  eligible: true                   },
      { market: 'Under 3.5',  score: scores.under35,  eligible: filters.under35_passed },
      { market: 'Esc 7.5',    score: scores.esc75,    eligible: true                   },
      { market: 'Cart 2.5',   score: scores.cards25,  eligible: true                   },
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
      { key: 'over15',   market: 'Over 1.5'    },
      { key: 'over25',   market: 'Over 2.5'    },
      { key: 'btts',     market: 'BTTS'        },
      { key: 'over05ht', market: 'Over 0.5 HT' },
      { key: 'under45',  market: 'Under 4.5'   },
      { key: 'under35',  market: 'Under 3.5'   },
      { key: 'esc75',    market: 'Esc 7.5'     },
      { key: 'esc85',    market: 'Esc 8.5'     },
      { key: 'cards25',  market: 'Cart 2.5'    },
      { key: 'cards35',  market: 'Cart 3.5'    },
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

    // ── Etapa 5: Filtros ───────────────────────────────────────
    const filtro15   = filtroOver15(raw, d);
    const under35_ok = filtroUnder35(raw, d, s_u35, poiss);

    // ── Etapa 6: Scores agrupados ──────────────────────────────
    const scores = {
      over15:   s15,
      over25:   s25,
      btts:     s_btts,
      over05ht: s_05ht,
      under45:  s_u45,
      under35:  s_u35,
      esc75:    s_esc75,
      esc85:    s_esc85,
      cards25:  s_c25,
      cards35:  s_c35,
    };

    // ── Etapa 7: Grades ────────────────────────────────────────
    const grades = {};
    for (const [mkt, sc] of Object.entries(scores)) {
      grades[mkt] = getGrade(sc);
    }
    // Over 1.5: grade D se não passou o filtro
    if (!filtro15.passed) grades.over15 = 'D';
    // Under 3.5: grade D se não passou o filtro
    if (!under35_ok) grades.under35 = 'D';

    // ── Etapa 8: Odds por mercado ──────────────────────────────
    const odds = {
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
    };

    // ── Etapa 9: EV por mercado ────────────────────────────────
    const evs = {};
    for (const [mkt, sc] of Object.entries(scores)) {
      evs[mkt] = computeEV(sc, odds[mkt]);
    }

    // ── Etapa 10: Filtros e best_mkt ──────────────────────────
    const filters = {
      over15_passed: filtro15.passed,
      over15_via:    filtro15.via,
      under35_passed: under35_ok,
    };

    const best = selectBestMkt(scores, filters);
    const main_markets = buildMainMarkets(scores, grades, odds, evs, filters);

    const best_mkt        = best ? best.market     : null;
    const best_score      = best ? best.score      : null;
    const best_grade      = best ? best.grade      : 'D';
    const best_confidence = getConfidence(best_grade);
    const best_odd        = best ? (odds[_mktKey(best.market)] ?? null) : null;
    const best_ev         = best ? computeEV(best.score, best_odd) : null;
    const is_official     = GRADES_OFICIAIS.has(best_grade);

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

      // Dados intermediários
      derivadas:    d,
      normalizadas: norm,
      poisson:      poiss,

      // Scores, grades, odds, EVs por mercado
      scores,
      grades,
      odds,
      evs,

      // Filtros
      filters,

      // Melhor mercado (best_mkt)
      best_mkt,
      best_score,
      best_grade,
      best_confidence,
      best_odd,
      best_ev,
      main_markets,
      is_official,  // true se A+ ou A — entra em Melhores Previsões
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPER: mapeamento market → chave interna de odds/evs
  // ═══════════════════════════════════════════════════════════════

  const _MKT_TO_KEY = {
    'Over 1.5':    'over15',
    'Over 2.5':    'over25',
    'BTTS':        'btts',
    'Over 0.5 HT': 'over05ht',
    'Under 4.5':   'under45',
    'Under 3.5':   'under35',
    'Esc 7.5':     'esc75',
    'Esc 8.5':     'esc85',
    'Cart 2.5':    'cards25',
    'Cart 3.5':    'cards35',
  };

  function _mktKey(market) {
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
