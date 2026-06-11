/**
 * WinMetrics Analytics — Alternative Line Resolver
 * ──────────────────────────────────────────────────
 * Quando o mercado principal (ex: Esc 7.5) não tem odd disponível na API,
 * tenta encontrar uma linha próxima e viável (ex: Esc 9.5).
 *
 * Aplica-se APENAS a:
 *   - Escanteios: Over 7.5 / 8.5 / 9.5 / 10.5
 *   - Cartões:    Over 2.5 / 3.5 / 4.5 / 5.5
 *
 * Regras (conforme especificação):
 *   1. Se usar linha alternativa, o nome do palpite muda junto (Esc 9.5, não Esc 7.5).
 *   2. Só aceita linha alternativa se:
 *      - score original >= 75
 *      - linha alternativa não estiver mais de 2 pontos acima da original
 *      - odd da linha alternativa existir
 *      - EV for positivo ou próximo de zero (>= -3%)
 *   3. Salva metadados: original_market, final_market, original_line, final_line,
 *      odd_used, is_alternative_line = true
 *   4. NÃO altera Prediction Engine nem fórmulas base.
 *   5. Altera apenas raw.odd_* antes de chamar processFixture().
 *
 * Uso:
 *   const resolver = require('./alternative_line_resolver');
 *   const { raw: patchedRaw, altLines } = resolver.resolveAlternativeLines(raw, apiOddsResponse, scores);
 *
 * @module alternative_line_resolver
 */

'use strict';

// ─────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO DE LINHAS CANDIDATAS
// ─────────────────────────────────────────────────────────────────

/**
 * Para cada mercado principal, define:
 *   - rawOddField: campo no objeto `raw` que recebe a odd
 *   - marketLabel: label exibido ao usuário (muda junto com a linha)
 *   - originalLine: valor numérico da linha principal
 *   - candidates: linhas alternativas em ordem de preferência (mais próxima primeiro)
 *   - marketNames: nomes de mercado na API para busca
 *   - type: 'corners' | 'cards'
 */
const ALT_LINE_CONFIG = {
  // ── Escanteios ───────────────────────────────────────────────
  esc75: {
    type:         'corners',
    rawOddField:  'odd_esc75',
    marketLabel:  'Esc 7.5',
    originalLine: 7.5,
    marketNames:  ['Asian Corners', 'Total Corners', 'Corners Over/Under', 'Corner Line'],
    candidates: [
      { line: 8.5,  label: 'Esc 8.5',  rawOddField: 'odd_esc85_alt'  },
      { line: 9.5,  label: 'Esc 9.5',  rawOddField: 'odd_esc95_alt'  },
      { line: 10.5, label: 'Esc 10.5', rawOddField: 'odd_esc105_alt' },
    ],
  },
  esc85: {
    type:         'corners',
    rawOddField:  'odd_esc85',
    marketLabel:  'Esc 8.5',
    originalLine: 8.5,
    marketNames:  ['Asian Corners', 'Total Corners', 'Corners Over/Under', 'Corner Line'],
    candidates: [
      { line: 9.5,  label: 'Esc 9.5',  rawOddField: 'odd_esc95_alt'  },
      { line: 10.5, label: 'Esc 10.5', rawOddField: 'odd_esc105_alt' },
    ],
  },
  // ── Cartões ──────────────────────────────────────────────────
  cards25: {
    type:         'cards',
    rawOddField:  'odd_c25',
    marketLabel:  'Cart 2.5',
    originalLine: 2.5,
    marketNames:  ['Total Cards', 'Booking Points', 'Cards Over/Under', 'Total Bookings'],
    candidates: [
      { line: 3.5,  label: 'Cart 3.5',  rawOddField: 'odd_c35_alt'  },
      { line: 4.5,  label: 'Cart 4.5',  rawOddField: 'odd_c45_alt'  },
      { line: 5.5,  label: 'Cart 5.5',  rawOddField: 'odd_c55_alt'  },
    ],
  },
  cards35: {
    type:         'cards',
    rawOddField:  'odd_c35',
    marketLabel:  'Cart 3.5',
    originalLine: 3.5,
    marketNames:  ['Total Cards', 'Booking Points', 'Cards Over/Under', 'Total Bookings'],
    candidates: [
      { line: 4.5,  label: 'Cart 4.5',  rawOddField: 'odd_c45_alt'  },
      { line: 5.5,  label: 'Cart 5.5',  rawOddField: 'odd_c55_alt'  },
    ],
  },
};

// Limite máximo de diferença de pontos entre linha original e alternativa
const MAX_LINE_GAP = 2.0;

// Score mínimo para aceitar linha alternativa
const MIN_SCORE_FOR_ALT = 75;

// EV mínimo aceito (negativo tolerado até -3%)
const MIN_EV_FOR_ALT = -3;


// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

/** Parse float seguro */
function _num(v) {
  const f = parseFloat(v);
  return isFinite(f) ? f : null;
}

/**
 * Calcula EV simplificado:
 *   EV = (prob/100 * odd - 1) * 100
 * onde prob = score (0–100).
 */
function _computeEV(score, odd) {
  if (score === null || score === undefined) return null;
  if (odd === null || odd === undefined || odd <= 1) return null;
  return ((score / 100) * odd - 1) * 100;
}

/**
 * Extrai odd de um conjunto de bets para uma linha específica.
 * Busca por "Over X.X" nos values do mercado.
 *
 * @param {Array}  bets        — array de bet objects do bookmaker
 * @param {Array}  marketNames — nomes alternativos do mercado
 * @param {number} lineValue   — ex: 9.5
 * @returns {number|null}
 */
function _extractOddForLine(bets, marketNames, lineValue) {
  if (!Array.isArray(bets)) return null;

  const targetValue = `over ${lineValue}`;
  const numStr      = String(lineValue);

  for (const bet of bets) {
    if (!bet || !bet.name) continue;
    const betNameLower = bet.name.toLowerCase();
    const nameMatch = marketNames.some(mn =>
      betNameLower.includes(mn.toLowerCase())
    );
    if (!nameMatch) continue;

    const values = bet.values || [];
    for (const v of values) {
      if (!v || v.value === null || v.value === undefined) continue;
      const val = String(v.value).toLowerCase().trim();

      // Exact: "Over 9.5"
      if (val === targetValue) return _num(v.odd);

      // Stripped: "Goals Over 9.5" → "over 9.5"
      const stripped = val
        .replace(/^goals\s+/, '')
        .replace(/^total\s+/, '')
        .replace(/^match\s+/, '')
        .trim();
      if (stripped === targetValue) return _num(v.odd);

      // Numeric match: contains "9.5" and "over"
      if (val.includes(numStr) && val.includes('over')) return _num(v.odd);
    }
  }
  return null;
}

/**
 * Extrai todos os bets do bookmaker preferencial (id=6 ou com mais bets).
 *
 * @param {object} oddsResponse — resposta bruta de /odds
 * @returns {Array} bets array
 */
function _getBetsFromOdds(oddsResponse) {
  if (!oddsResponse) return [];

  // Normaliza para array de items
  let items = [];
  if (oddsResponse?.response) {
    items = Array.isArray(oddsResponse.response)
      ? oddsResponse.response
      : [oddsResponse.response];
  } else if (Array.isArray(oddsResponse)) {
    items = oddsResponse;
  } else if (oddsResponse?.bookmakers) {
    items = [oddsResponse];
  }

  if (items.length === 0) return [];

  // Flatten bookmakers
  const allBm = items.flatMap(i => i?.bookmakers || []);
  if (allBm.length === 0) return [];

  // Prefere bookmaker id=6
  const chosen = allBm.find(b => Number(b.id) === 6)
    || allBm.reduce((best, bm) =>
      (bm.bets?.length || 0) > (best.bets?.length || 0) ? bm : best
    , allBm[0]);

  return chosen?.bets || [];
}


// ─────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────────

/**
 * resolveAlternativeLines(raw, oddsResponse, scores)
 *
 * Para cada mercado de Escanteios/Cartões sem odd disponível,
 * tenta encontrar uma linha alternativa viável.
 *
 * Não toca no Prediction Engine nem altera scores/grades.
 * Apenas preenche `raw.odd_*` com a odd alternativa e renomeia
 * os labels de mercado para refletir a linha real usada.
 *
 * @param {object} raw          — objeto raw após mapFixtureToPackBall()
 * @param {object} oddsResponse — resposta bruta de /odds (para buscar linhas extras)
 * @param {object} scores       — scores calculados pelo PredictionEngine (ou estimativa prévia)
 *                                { esc75, esc85, cards25, cards35, ... }
 *
 * @returns {{
 *   raw: object,           — raw (possivelmente com odds novas)
 *   labelOverrides: object,— { esc75: 'Esc 9.5', ... } — labels alternativos
 *   altLines: Array,       — registros de linhas alternativas usadas
 * }}
 */
function resolveAlternativeLines(raw, oddsResponse, scores) {
  // Cópia shallow para não mutar o original
  const patchedRaw   = Object.assign({}, raw);
  const labelOverrides = {};  // mktKey → novo label
  const altLines      = [];   // metadados para log/DB

  const bets = _getBetsFromOdds(oddsResponse);

  for (const [mktKey, config] of Object.entries(ALT_LINE_CONFIG)) {
    const currentOdd = patchedRaw[config.rawOddField];

    // Só age se a odd principal estiver ausente
    if (currentOdd !== null && currentOdd !== undefined) continue;

    // Verifica score mínimo
    const score = scores?.[mktKey];
    if (score === null || score === undefined || score < MIN_SCORE_FOR_ALT) {
      continue;
    }

    // Tenta cada candidato em ordem (mais próximo primeiro)
    for (const candidate of config.candidates) {
      // Regra: linha alternativa não pode estar mais de MAX_LINE_GAP acima
      const gap = candidate.line - config.originalLine;
      if (gap > MAX_LINE_GAP) break;  // candidatos estão em ordem crescente → para aqui

      const altOdd = _extractOddForLine(bets, config.marketNames, candidate.line);
      if (altOdd === null) continue;

      // Verifica EV
      const ev = _computeEV(score, altOdd);
      if (ev !== null && ev < MIN_EV_FOR_ALT) continue;

      // ── Linha alternativa aceita ──────────────────────────────
      // Injeta a odd no campo principal (o engine vai usá-la normalmente)
      patchedRaw[config.rawOddField] = altOdd;

      // Registra override de label (o palpite exibido muda junto)
      labelOverrides[mktKey] = candidate.label;

      // Metadados para log e gravação
      altLines.push({
        mkt_key:         mktKey,
        original_market: config.marketLabel,
        final_market:    candidate.label,
        original_line:   config.originalLine,
        final_line:      candidate.line,
        odd_used:        altOdd,
        score,
        ev:              ev !== null ? Math.round(ev * 10) / 10 : null,
        is_alternative_line: true,
      });

      break;  // usa só a primeira candidata válida
    }
  }

  return { raw: patchedRaw, labelOverrides, altLines };
}


// ─────────────────────────────────────────────────────────────────
// APPLY OVERRIDES: ajusta os labels no objeto result do Engine
// ─────────────────────────────────────────────────────────────────

/**
 * applyLabelOverrides(result, labelOverrides, altLines)
 *
 * Após o PredictionEngine.processFixture() rodar com as odds patchadas,
 * corrige os labels de mercado no result para refletir a linha real usada.
 *
 * Atualiza:
 *   - result.best_mkt  (se o best_mkt for um dos mercados alternativos)
 *   - result.altLines  (metadados adicionados ao result)
 *
 * NÃO altera scores, grades, odds numéricas nem EVs.
 *
 * @param {object} result        — saída de PredictionEngine.processFixture()
 * @param {object} labelOverrides— { mktKey: 'Novo Label' }
 * @param {Array}  altLines      — metadados das linhas alternativas
 * @returns {object} result com labels corrigidos
 */
function applyLabelOverrides(result, labelOverrides, altLines) {
  if (!labelOverrides || Object.keys(labelOverrides).length === 0) {
    return Object.assign({}, result, { altLines: [] });
  }

  // Mapeamento mktKey → label original → novo label
  const KEY_TO_ORIGINAL_LABEL = {
    esc75:   'Esc 7.5',
    esc85:   'Esc 8.5',
    cards25: 'Cart 2.5',
    cards35: 'Cart 3.5',
  };

  const patched = Object.assign({}, result);

  // Corrige best_mkt se necessário
  for (const [mktKey, newLabel] of Object.entries(labelOverrides)) {
    const originalLabel = KEY_TO_ORIGINAL_LABEL[mktKey];
    if (patched.best_mkt === originalLabel) {
      patched.best_mkt = newLabel;
    }
  }

  // Adiciona metadados ao result
  patched.altLines = altLines || [];

  return patched;
}


// ─────────────────────────────────────────────────────────────────
// LOGGER HELPER
// ─────────────────────────────────────────────────────────────────

/**
 * logAltLines(altLines, fixtureId, log)
 * Imprime no console as linhas alternativas usadas.
 *
 * @param {Array}  altLines  — de resolveAlternativeLines()
 * @param {number} fixtureId
 * @param {object} log       — objeto LOG com .info/.warn
 */
function logAltLines(altLines, fixtureId, log) {
  if (!altLines || altLines.length === 0) return;
  const logger = log || console;
  const info = (logger.info || logger.log).bind(logger);

  for (const alt of altLines) {
    info(
      `  [ALT LINE] fixture=${fixtureId}  ` +
      `${alt.original_market} (sem odd) → ${alt.final_market}  ` +
      `odd=${alt.odd_used}  score=${alt.score?.toFixed(1)}  ev=${alt.ev !== null ? (alt.ev >= 0 ? '+' : '') + alt.ev + '%' : 'n/a'}`
    );
  }
}


// ─────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    resolveAlternativeLines,
    applyLabelOverrides,
    logAltLines,

    // Expõe para testes
    _internal: {
      _num,
      _computeEV,
      _extractOddForLine,
      _getBetsFromOdds,
      ALT_LINE_CONFIG,
      MAX_LINE_GAP,
      MIN_SCORE_FOR_ALT,
      MIN_EV_FOR_ALT,
    },
  };
}
