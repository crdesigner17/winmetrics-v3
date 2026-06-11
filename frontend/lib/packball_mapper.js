/**
 * WinMetrics Analytics — PackBall Mapper v1
 * ──────────────────────────────────────────
 * Transforma respostas brutas da API-Football no objeto `raw`
 * exigido por PredictionEngine.processFixture() (prediction_engine_v1.js).
 *
 * Referência: Documentação Técnica WinMetrics — PackBall v3.0, seções 2–3.
 *
 * Endpoints cobertos (§2.1):
 *   /fixtures                — identificação, status, placar
 *   /teams/statistics        — PPG, gols médios, BTTS, Under 2.5 (home + away)
 *   /fixtures?team&last=10   — últimos 10 jogos de cada time (cantos, cartões, chutes, HT)
 *   /fixtures/statistics     — estatísticas por jogo individual
 *   /fixtures/headtohead     — H2H gols médios
 *   /predictions             — over15%, over25%
 *   /odds (bookmaker=6)      — odds de mercado
 *
 * Uso:
 *   const raw  = PackBallMapper.mapFixtureToPackBall(apiData);
 *   const errs = PackBallMapper.validatePackBallInput(raw);
 *   if (errs.critical.length === 0) {
 *     const result = PredictionEngine.processFixture(raw);
 *   }
 */

const PackBallMapper = (function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // CONSTANTES
  // ═══════════════════════════════════════════════════════════════

  // Nomes de mercado na API de odds (bookmaker=6, bet365-like)
  const ODD_MARKET_NAMES = {
    over15:    ['Goals Over/Under', 'Total Goals', 'Match Goals', 'Over/Under'],
    over25:    ['Goals Over/Under', 'Total Goals', 'Match Goals', 'Over/Under'],
    under35:   ['Goals Over/Under', 'Total Goals', 'Match Goals', 'Over/Under'],
    under45:   ['Goals Over/Under', 'Total Goals', 'Match Goals', 'Over/Under'],
    btts:      ['Both Teams Score', 'Both Teams To Score', 'BTTS', 'Both Teams to Score'],
    corners75: ['Asian Corners', 'Total Corners', 'Corners Over/Under', 'Corner Line'],
    corners85: ['Asian Corners', 'Total Corners', 'Corners Over/Under', 'Corner Line'],
    cards25:   ['Total Cards', 'Booking Points', 'Cards Over/Under', 'Total Bookings'],
    cards35:   ['Total Cards', 'Booking Points', 'Cards Over/Under', 'Total Bookings'],
  };

  // Nomes de estatística nos objetos /fixtures/statistics
  const STAT_NAMES = {
    corners:     ['Corner Kicks',  'Corners'],
    yellow_cards: ['Yellow Cards'],
    red_cards:    ['Red Cards'],
    total_shots:  ['Total Shots',  'Shots Total'],
    shots_on_goal:['Shots on Goal', 'Shots On Target'],
    ht_goals:     ['Goals'],  // derivado de score HT
  };

  // Últimos N jogos para cálculo de médias históricas
  const LAST_N = 10;

  // ═══════════════════════════════════════════════════════════════
  // HELPERS INTERNOS
  // ═══════════════════════════════════════════════════════════════

  /** Retorna null se v não for número finito */
  function _num(v) {
    const f = parseFloat(v);
    return isFinite(f) ? f : null;
  }

  /** Retorna null se v não for número finito ou for negativo */
  function _pos(v) {
    const f = _num(v);
    return (f !== null && f >= 0) ? f : null;
  }

  /** Extrai % de strings como "75%" → 75 */
  function _pct(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).replace('%', '').trim();
    const f = parseFloat(s);
    return isFinite(f) ? f : null;
  }

  /** Média segura de array de números, ignora nulos */
  function _avg(arr) {
    const valid = arr.filter(v => v !== null && v !== undefined && isFinite(v));
    if (valid.length === 0) return null;
    return valid.reduce((a, b) => a + b, 0) / valid.length;
  }

  /** Extrai valor de estatística por nome (array de { type, value }) */
  function _stat(statsArray, possibleNames) {
    if (!Array.isArray(statsArray)) return null;
    for (const name of possibleNames) {
      const item = statsArray.find(s =>
        s && s.type && s.type.toLowerCase().includes(name.toLowerCase())
      );
      if (item && item.value !== null && item.value !== undefined) {
        return _num(item.value);
      }
    }
    return null;
  }

  /**
   * Extrai odd de um array de odds por valor alvo.
   * /odds response: [ { bet: { name, values: [{ value, odd }] } } ]
   * Procura pela bet com name matching e value matching.
   */
  function _extractOdd(bets, marketNames, targetValue) {
    if (!Array.isArray(bets)) return null;
    const target = targetValue.toLowerCase().trim();
    // Pre-build normalised target variants
    // e.g. "Over 1.5" → also match "Goals Over 1.5", "Total Over 1.5", "1.5"
    const numPart = target.replace(/[^0-9.]/g, '');  // "1.5"
    const overUnder = target.startsWith('over') ? 'over' : target.startsWith('under') ? 'under' : null;

    for (const bet of bets) {
      if (!bet || !bet.name) continue;
      const betNameLower = bet.name.toLowerCase();
      const nameMatch = marketNames.some(mn => betNameLower.includes(mn.toLowerCase()));
      if (!nameMatch) continue;

      const values = bet.values || [];
      for (const v of values) {
        if (!v || v.value === null || v.value === undefined) continue;
        const val = String(v.value).toLowerCase().trim();

        // 1. Exact match
        if (val === target) { return _num(v.odd); }

        // 2. Strip common prefixes: "goals over 1.5" → "over 1.5"
        const stripped = val
          .replace(/^goals\s+/, '')
          .replace(/^total\s+/, '')
          .replace(/^match\s+/, '')
          .trim();
        if (stripped === target) { return _num(v.odd); }

        // 3. Numeric + direction: val contains same number and same over/under direction
        if (overUnder && numPart && val.includes(numPart) && val.includes(overUnder)) {
          return _num(v.odd);
        }
      }
    }
    return null;
  }

  /**
   * _calcPPG(teamStatsResponse)
   * PPG = (wins×3 + draws×1) / jogos_totais
   * Fonte: /teams/statistics → fixtures.wins/draws/loses (all / season)
   */
  function _calcPPG(teamStats) {
    if (!teamStats || !teamStats.fixtures) return null;
    const fx     = teamStats.fixtures;
    const played = _num(fx.played?.total);
    if (!played || played === 0) return null;
    const wins   = _num(fx.wins?.total)  || 0;
    const draws  = _num(fx.draws?.total) || 0;
    return (wins * 3 + draws) / played;
  }

  /**
   * _calcAvgGoals(teamStats)
   * Média de gols marcados por jogo (ataque) — goals.for.average.total
   * Também usada como proxy de xG.
   */
  function _calcAvgGoals(teamStats) {
    if (!teamStats || !teamStats.goals) return null;
    const avg = teamStats.goals.for?.average?.total;
    return _pos(avg);
  }

  /**
   * _calcBTTS(teamStats)
   * % jogos onde o time marcou E sofreu pelo menos 1 gol.
   * Aproximação: goals.for.total > 0 E goals.against.total > 0 por jogo médio.
   * Cálculo: usa fixtures played + goals scored/conceded para estimar %.
   *
   * Método mais preciso quando disponível: goals.for/against por resultado jogo a jogo.
   * Como a API não fornece BTTS direto, usamos a proxy:
   *   btts_rate ≈ (jogos_com_gol_pro * jogos_com_gol_contra) / played^2 × 100
   *
   * Nota: se a API retornar o campo direto (alguns endpoints retornam),
   * use-o diretamente.
   */
  function _calcBTTS(teamStats) {
    if (!teamStats || !teamStats.fixtures || !teamStats.goals) return null;

    const played   = _num(teamStats.fixtures.played?.total);
    if (!played || played === 0) return null;

    // Jogos em que o time marcou pelo menos 1
    const scored     = _num(teamStats.goals.for?.total?.total)   || 0;
    const conceded   = _num(teamStats.goals.against?.total?.total) || 0;

    // Estimativa conservadora: assume distribuição de Poisson por jogo
    // P(marcar >= 1) ≈ 1 - e^(-avg_scored)
    // P(sofrer >= 1)  ≈ 1 - e^(-avg_conceded)
    const avg_sc  = scored   / played;
    const avg_con = conceded / played;

    if (avg_sc === 0 || avg_con === 0) return 0;

    const p_score   = 1 - Math.exp(-avg_sc);
    const p_concede = 1 - Math.exp(-avg_con);
    return p_score * p_concede * 100;
  }

  /**
   * _calcUnder25Rate(teamStats)
   * % jogos do time onde total de gols do jogo foi ≤ 2.
   * Proxy: usa gols marcados + sofridos médio para estimar via Poisson.
   * P(total_gols ≤ 2) = P(X=0)+P(X=1)+P(X=2) com lambda = avg_for + avg_against
   */
  function _calcUnder25Rate(teamStats) {
    if (!teamStats || !teamStats.fixtures || !teamStats.goals) return null;

    const played = _num(teamStats.fixtures.played?.total);
    if (!played || played === 0) return null;

    const total_scored   = _num(teamStats.goals.for?.total?.total)    || 0;
    const total_conceded = _num(teamStats.goals.against?.total?.total) || 0;

    const lam = (total_scored + total_conceded) / played;  // lambda total de gols por jogo
    if (lam <= 0) return 90;  // muito defensivo → alta chance Under

    // Poisson acumulada P(X<=2)
    const e_lam = Math.exp(-lam);
    const p0    = e_lam;
    const p1    = e_lam * lam;
    const p2    = e_lam * (lam * lam) / 2;
    return (p0 + p1 + p2) * 100;
  }

  /**
   * _processHistoricGames(games, teamId)
   * Processa os últimos N jogos de um time para extrair:
   * - avg_corners, over65_c, over75_c, over85_c
   * - avg_cards, over25_cards, over35_cards
   * - avg_shots, avg_sot
   * - over05_ht, over15_ht
   *
   * Cada game em `games` deve ter:
   *   game.statistics — array de { team: {id}, statistics: [{type, value}] }
   *   game.score.halftime — { home, away }
   *
   * @param {Array}  games   — últimos N jogos do time (endpoint /fixtures?team&last=10)
   * @param {number} teamId  — ID do time para filtrar as stats corretas
   * @returns {object}
   */
  function _processHistoricGames(games, teamId) {
    if (!Array.isArray(games) || games.length === 0) {
      return {
        avg_corners: null, over65_c: null, over75_c: null, over85_c: null,
        avg_cards: null, over25_cards: null, over35_cards: null,
        avg_shots: null, avg_sot: null,
        over05_ht: null, over15_ht: null,
      };
    }

    const corners_list = [], cards_list = [], shots_list = [], sot_list = [];
    let ht_games_with_goal = 0, ht_games_with_2goals = 0;
    let valid = 0;

    for (const game of games) {
      if (!game) continue;

      // ── Estatísticas do jogo ─────────────────────────────────
      const statsForGame = game.statistics || [];

      // Cada item: { team: { id, name }, statistics: [{type, value}] }
      let totalCorners = 0, totalCards = 0, totalShots = 0, totalSOT = 0;
      let hasStats = false;

      for (const teamStats of statsForGame) {
        if (!teamStats || !Array.isArray(teamStats.statistics)) continue;
        const s = teamStats.statistics;
        totalCorners += _stat(s, STAT_NAMES.corners)      || 0;
        totalCards   += (_stat(s, STAT_NAMES.yellow_cards) || 0)
                      + (_stat(s, STAT_NAMES.red_cards)    || 0);
        totalShots   += _stat(s, STAT_NAMES.total_shots)   || 0;
        totalSOT     += _stat(s, STAT_NAMES.shots_on_goal) || 0;
        hasStats = true;
      }

      if (hasStats) {
        corners_list.push(totalCorners);
        cards_list.push(totalCards);
        shots_list.push(totalShots);
        sot_list.push(totalSOT);
      }

      // ── Gols no intervalo (HT) ───────────────────────────────
      const ht = game.score?.halftime;
      if (ht) {
        const ht_h = _num(ht.home) || 0;
        const ht_a = _num(ht.away) || 0;
        const ht_total = ht_h + ht_a;
        if (ht_total >= 1) ht_games_with_goal++;
        if (ht_total >= 2) ht_games_with_2goals++;
      }

      valid++;
    }

    const n = valid || 1;

    // Médias
    const avg_corners = _avg(corners_list);
    const avg_cards   = _avg(cards_list);
    const avg_shots   = _avg(shots_list);
    const avg_sot     = _avg(sot_list);

    // Taxas de cantos
    const over65_c = corners_list.length > 0
      ? (corners_list.filter(c => c > 6.5).length / corners_list.length) * 100 : null;
    const over75_c = corners_list.length > 0
      ? (corners_list.filter(c => c > 7.5).length / corners_list.length) * 100 : null;
    const over85_c = corners_list.length > 0
      ? (corners_list.filter(c => c > 8.5).length / corners_list.length) * 100 : null;

    // Taxas de cartões
    const over25_cards = cards_list.length > 0
      ? (cards_list.filter(c => c > 2.5).length / cards_list.length) * 100 : null;
    const over35_cards = cards_list.length > 0
      ? (cards_list.filter(c => c > 3.5).length / cards_list.length) * 100 : null;

    // HT
    const over05_ht = valid > 0 ? (ht_games_with_goal  / valid) * 100 : null;
    const over15_ht = valid > 0 ? (ht_games_with_2goals / valid) * 100 : null;

    return {
      avg_corners, over65_c, over75_c, over85_c,
      avg_cards, over25_cards, over35_cards,
      avg_shots, avg_sot,
      over05_ht, over15_ht,
    };
  }

  /**
   * _mergeHistoric(homeMetrics, awayMetrics)
   * Combina as métricas históricas dos dois times (média simples),
   * conforme documentação §3.1: "média dos dois times".
   */
  function _mergeHistoric(hm, am) {
    function avg2(a, b) {
      if (a === null && b === null) return null;
      if (a === null) return b;
      if (b === null) return a;
      return (a + b) / 2;
    }
    function rate2(hList, aList, threshold) {
      if (!hList && !aList) return null;
      const h = hList ? (hList.filter(v => v > threshold).length / hList.length) * 100 : null;
      const a = aList ? (aList.filter(v => v > threshold).length / aList.length) * 100 : null;
      return avg2(h, a);
    }
    return {
      avg_corners:   avg2(hm.avg_corners,   am.avg_corners),
      over65_c:      avg2(hm.over65_c,      am.over65_c),
      over75_c:      avg2(hm.over75_c,      am.over75_c),
      over85_c:      avg2(hm.over85_c,      am.over85_c),
      avg_cards:     avg2(hm.avg_cards,     am.avg_cards),
      over25_cards:  avg2(hm.over25_cards,  am.over25_cards),
      over35_cards:  avg2(hm.over35_cards,  am.over35_cards),
      avg_shots:     avg2(hm.avg_shots,     am.avg_shots),
      avg_sot:       avg2(hm.avg_sot,       am.avg_sot),
      over05_ht:     avg2(hm.over05_ht,     am.over05_ht),
      over15_ht:     avg2(hm.over15_ht,     am.over15_ht),
    };
  }

  /**
   * _calcH2HGoals(h2hGames)
   * Média de gols totais nos últimos N jogos H2H.
   * Endpoint: /fixtures/headtohead
   */
  function _calcH2HGoals(h2hGames) {
    if (!Array.isArray(h2hGames) || h2hGames.length === 0) return null;
    const recent = h2hGames.slice(0, LAST_N);
    const totals = recent.map(g => {
      const h = _num(g?.goals?.home);
      const a = _num(g?.goals?.away);
      if (h === null || a === null) return null;
      return h + a;
    }).filter(v => v !== null);
    return totals.length > 0 ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
  }

  // Igual ao V1 coletar.py — calcula % over15/over25/btts dos jogos H2H
  function _calcH2HStats(h2hGames) {
    if (!Array.isArray(h2hGames) || h2hGames.length === 0) {
      return { h2h_goals: null, h2h_over15: null, h2h_over25: null, h2h_btts: null };
    }
    const recent = h2hGames.slice(0, LAST_N);
    let goalsTotal = 0, o15 = 0, o25 = 0, bttsCount = 0, n = 0;
    for (const g of recent) {
      const gh = _num(g?.goals?.home);
      const ga = _num(g?.goals?.away);
      if (gh === null || ga === null) continue;
      const total = gh + ga;
      goalsTotal += total;
      if (total >= 2) o15++;
      if (total >= 3) o25++;
      if (gh > 0 && ga > 0) bttsCount++;
      n++;
    }
    if (n === 0) return { h2h_goals: null, h2h_over15: null, h2h_over25: null, h2h_btts: null };
    return {
      h2h_goals:  Math.round(goalsTotal / n * 100) / 100,
      h2h_over15: Math.round(o15 / n * 1000) / 10,
      h2h_over25: Math.round(o25 / n * 1000) / 10,
      h2h_btts:   Math.round(bttsCount / n * 1000) / 10,
    };
  }

  /**
   * _extractPredictionsOdds(predictionsResponse)
   * /predictions retorna percent.home, percent.draw, percent.away (1X2)
   * e também goals como "Over 1.5" / "Over 2.5" em alguns formatos.
   *
   * Estratégia robusta:
   *   over15_g: predictions.percent_goals_over15 ou predictions.goals.home (aprox)
   *   over25_g: predictions.percent_goals_over25 ou derivado
   *
   * A API-Football v3 retorna:
   *   response[0].predictions.goals.home  → "over 2.5" etc (string)
   *   response[0].predictions.percent     → { home, draw, away }
   *   response[0].predictions.win_or_draw → { home: "%", away: "%" }
   *
   * O campo mais confiável para over%:
   *   comparison.goals.home + comparison.goals.away → "NN%" cada um
   *   over15: média das % de gols esperados de ambos os times
   */
  function _extractPredictionsOdds(predictionsResp) {
    if (!predictionsResp || !predictionsResp.predictions) {
      return { over15_g: null, over25_g: null };
    }

    const pred = predictionsResp.predictions;
    let over15_g = null, over25_g = null;

    // ── Source 1: comparison.goals (% scoring probability per team)
    // API v3: comparison.goals = { home: "53%", away: "47%" }
    // These are P(team scores >= 1). Use them to estimate Over 1.5:
    //   P(Over 1.5) ≈ 1 - P(home_scores=0) - P(away_scores=0) + P(both_score=0)
    // Simplified proxy: use the raw comparison.goals fields as-is for over15/over25.
    const comp = predictionsResp.comparison;
    if (comp && comp.goals) {
      const ph = _pct(comp.goals.home);  // P(home scores >= 1) %
      const pa = _pct(comp.goals.away);  // P(away scores >= 1) %
      if (ph !== null && pa !== null) {
        // Over 1.5 proxy: both teams likely score (p_h * p_a) + either scoring 2+
        // Simplified: mean of both scoring probabilities scaled to over% range
        over15_g = Math.min(100, (ph + pa) / 2 * 1.4);  // scale up slightly
        over25_g = Math.min(100, (ph + pa) / 2 * 0.9);
      }
    }

    // ── Source 2: predictions.goals.home/away (string like "over 2.5")
    // Use to adjust if available
    if (pred.goals) {
      const goalsHint = String(pred.goals.home || pred.goals.away || '').toLowerCase();
      if (goalsHint.includes('over 2.5') || goalsHint.includes('over 3')) {
        // Strong over signal — boost
        if (over15_g !== null) over15_g = Math.min(100, over15_g * 1.1);
        if (over25_g !== null) over25_g = Math.min(100, over25_g * 1.2);
      } else if (goalsHint.includes('under 2.5') || goalsHint.includes('under 1.5')) {
        // Under signal — reduce
        if (over15_g !== null) over15_g = Math.max(0, over15_g * 0.75);
        if (over25_g !== null) over25_g = Math.max(0, over25_g * 0.6);
      }
    }

    // ── Source 3: percent home/away (1X2 win %) as final fallback
    if (over15_g === null && pred.percent) {
      const ph = _pct(pred.percent.home);
      const pa = _pct(pred.percent.away);
      if (ph !== null && pa !== null) {
        over15_g = Math.min(100, ph + pa);
        over25_g = over15_g * 0.65;
      }
    }

    return {
      over15_g: over15_g !== null ? Math.round(Math.min(100, Math.max(0, over15_g)) * 10) / 10 : null,
      over25_g: over25_g !== null ? Math.round(Math.min(100, Math.max(0, over25_g)) * 10) / 10 : null,
    };
  }

  /**
   * _extractAllOdds(oddsResponse)
   * Extrai todas as odds necessárias do response do /odds endpoint.
   *
   * Estrutura API-Football /odds:
   *   response[0].bookmakers → [{ id, name, bets: [{ id, name, values: [{value, odd}] }] }]
   *
   * Buscamos bookmaker=6 (bet365) preferencialmente, depois qualquer um.
   */
  function _extractAllOdds(oddsResponse) {
    const nullOdds = {
      odd_o15: null, odd_o25: null, odd_btts: null,
      odd_05ht: null, odd_u35: null, odd_u45: null,
      odd_esc75: null, odd_esc85: null,
      odd_c25: null, odd_c35: null,
      odd_justa_15: null, odd_justa_25: null, odd_justa_btts: null,
      odd_justa_05ht: null, odd_justa_esc85: null, odd_justa_cart25: null,
    };

    if (!oddsResponse) return nullOdds;

    // Handle all API response shapes:
    // Shape A: { response: [ { bookmakers: [...] } ] }   ← standard
    // Shape B: [ { bookmakers: [...] } ]                 ← already unwrapped
    // Shape C: { bookmakers: [...] }                     ← single item
    // Shape D: { response: [] }                          ← empty (no odds for fixture)
    let items = [];
    if (oddsResponse?.response) {
      items = Array.isArray(oddsResponse.response) ? oddsResponse.response : [oddsResponse.response];
    } else if (Array.isArray(oddsResponse)) {
      items = oddsResponse;
    } else if (oddsResponse?.bookmakers) {
      items = [oddsResponse];
    }

    if (items.length === 0) return nullOdds;

    // Flatten all bookmakers from all items
    const allBookmakers = [];
    for (const item of items) {
      const bms = item?.bookmakers || [];
      allBookmakers.push(...bms);
    }
    if (allBookmakers.length === 0) return nullOdds;

    // Priority: bookmaker id=6 (Bet365), then any with most bets
    // Use Number() to handle cases where the API returns id as string "6"
    let chosen = allBookmakers.find(b => Number(b.id) === 6);
    if (!chosen) {
      chosen = allBookmakers.reduce((best, bm) =>
        (bm.bets?.length || 0) > (best.bets?.length || 0) ? bm : best
      , allBookmakers[0]);
    }

    const bets = chosen?.bets || [];
    if (bets.length === 0) {
      if (process.env.DEBUG_ODDS === '1') {
        console.log(`[ODDS_TRACE] chosen bookmaker id=${chosen?.id} name="${chosen?.name}" has 0 bets → nullOdds`);
      }
      return nullOdds;
    }

    const extracted = {
      odd_o15:   _extractOdd(bets, ODD_MARKET_NAMES.over15,   'Over 1.5'),
      odd_o25:   _extractOdd(bets, ODD_MARKET_NAMES.over25,   'Over 2.5'),
      odd_btts:  _extractOdd(bets, ODD_MARKET_NAMES.btts,     'Yes'),
      odd_05ht:  null,  // raramente disponível
      odd_u35:   _extractOdd(bets, ODD_MARKET_NAMES.under35,  'Under 3.5'),
      odd_u45:   _extractOdd(bets, ODD_MARKET_NAMES.under45,  'Under 4.5'),
      odd_esc75: _extractOdd(bets, ODD_MARKET_NAMES.corners75,'Over 7.5'),
      odd_esc85: _extractOdd(bets, ODD_MARKET_NAMES.corners85,'Over 8.5'),
      odd_c25:   _extractOdd(bets, ODD_MARKET_NAMES.cards25,  'Over 2.5'),
      odd_c35:   _extractOdd(bets, ODD_MARKET_NAMES.cards35,  'Over 3.5'),
      odd_justa_15: null, odd_justa_25: null, odd_justa_btts: null,
      odd_justa_05ht: null, odd_justa_esc85: null, odd_justa_cart25: null,
    };

    if (process.env.DEBUG_ODDS === '1') {
      const oddsFound = Object.entries(extracted).filter(([k, v]) => v !== null && !k.startsWith('odd_justa'));
      const oddsNull  = Object.entries(extracted).filter(([k, v]) => v === null && !k.startsWith('odd_justa'));
      console.log(`[ODDS_TRACE] bookmaker="${chosen.name}"(id=${chosen.id}) bets=${bets.length}`);
      console.log(`[ODDS_TRACE] ✅ extraídas (${oddsFound.length}): ${oddsFound.map(([k,v])=>`${k}=${v}`).join(' | ')}`);
      if (oddsNull.length > 0)
        console.log(`[ODDS_TRACE] ❌ não encontradas (${oddsNull.length}): ${oddsNull.map(([k])=>k).join(', ')}`);
    }

    return extracted;
  }


  // ═══════════════════════════════════════════════════════════════
  // API PRINCIPAL — mapFixtureToPackBall()
  // ═══════════════════════════════════════════════════════════════

  /**
   * mapFixtureToPackBall(apiData)
   * Transforma todos os dados brutos da API-Football em um único objeto `raw`
   * compatível com PredictionEngine.processFixture().
   *
   * @param {object} apiData — objeto com todas as respostas da API:
   * {
   *   fixture:     object    — item de /fixtures response[N]
   *   homeStats:   object    — response de /teams/statistics para o time casa
   *   awayStats:   object    — response de /teams/statistics para o time fora
   *   homeGames:   Array     — response de /fixtures?team=HOME_ID&last=10
   *   awayGames:   Array     — response de /fixtures?team=AWAY_ID&last=10
   *   h2hGames:    Array     — response de /fixtures/headtohead
   *   predictions: object    — response[0] de /predictions
   *   odds:        Array     — response de /odds (todos os bookmakers)
   * }
   *
   * @returns {object}  Objeto `raw` para processFixture()
   */
  function mapFixtureToPackBall(apiData) {
    const {
      fixture     = null,
      homeStats   = null,
      awayStats   = null,
      homeGames   = [],
      awayGames   = [],
      h2hGames    = [],
      predictions = null,
      odds        = null,
    } = apiData || {};

    // ── Identificação do jogo ────────────────────────────────────
    const fix         = fixture?.fixture || {};
    const league      = fixture?.league  || {};
    const teams       = fixture?.teams   || {};
    const goals       = fixture?.goals   || {};
    const score       = fixture?.score   || {};

    const fixture_id  = _num(fix.id);
    const home_team   = teams.home?.name  || '';
    const away_team   = teams.away?.name  || '';
    const home_id     = _num(teams.home?.id);
    const away_id     = _num(teams.away?.id);
    const league_name = league.name       || '';
    const league_id   = _num(league.id);
    const season      = _num(league.season);
    const status      = fix.status?.short || 'NS';

    // Data e hora separadas
    const rawDate   = fix.date ? new Date(fix.date) : null;
    const match_date = rawDate ? rawDate.toISOString() : null;
    const hour       = rawDate
      ? rawDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
      : null;

    // ── DIAGNOSTIC LOGS (remove after confirming field paths) ─
    if (process.env.DEBUG_MAPPER === '1') {
      console.log('\n[MAPPER DEBUG] fixture_id:', fixture?.fixture?.id);
      console.log('[MAPPER DEBUG] homeStats keys:', homeStats ? Object.keys(homeStats) : 'null');
      if (homeStats?.response) {
        const r = homeStats.response;
        console.log('[MAPPER DEBUG] homeStats.response keys:', Object.keys(r));
        console.log('[MAPPER DEBUG] homeStats.response.fixtures:', JSON.stringify(r.fixtures?.played));
        console.log('[MAPPER DEBUG] homeStats.response.goals.for.average:', r.goals?.for?.average);
        console.log('[MAPPER DEBUG] homeStats.response.goals.for.total:', r.goals?.for?.total);
      } else {
        console.log('[MAPPER DEBUG] homeStats.response is NULL/UNDEFINED — PPG/xG will be null');
      }
      if (predictions?.response) {
        const p0 = Array.isArray(predictions.response) ? predictions.response[0] : predictions.response;
        console.log('[MAPPER DEBUG] predictions.response[0] keys:', p0 ? Object.keys(p0) : 'null');
        console.log('[MAPPER DEBUG] predictions.comparison.goals:', p0?.comparison?.goals);
        console.log('[MAPPER DEBUG] predictions.predictions.percent:', p0?.predictions?.percent);
        console.log('[MAPPER DEBUG] predictions.predictions.goals:', p0?.predictions?.goals);
      } else {
        console.log('[MAPPER DEBUG] predictions.response is NULL — over15_g/over25_g will be null');
      }
      if (odds?.response) {
        const respArr = Array.isArray(odds.response) ? odds.response : [odds.response];
        const bms = respArr[0]?.bookmakers || [];
        console.log('[MAPPER DEBUG] odds bookmakers count:', bms.length);
        bms.slice(0,2).forEach(bm => {
          console.log(`[MAPPER DEBUG]   bookmaker id=${bm.id} name="${bm.name}" bets:`, bm.bets?.map(b=>b.name));
        });
        const bm6 = bms.find(b => b.id === 6);
        if (bm6) {
          console.log('[MAPPER DEBUG] bookmaker=6 bets:');
          bm6.bets?.forEach(b => console.log(`  bet="${b.name}" values:`, b.values?.map(v=>v.value+'='+v.odd).join(', ')));
        } else {
          console.log('[MAPPER DEBUG] bookmaker=6 NOT FOUND — using fallback');
        }
      } else {
        console.log('[MAPPER DEBUG] odds.response is NULL — all odds will be null');
      }
      const homeGamesArr = Array.isArray(homeGames) ? homeGames : [];
      console.log('[MAPPER DEBUG] homeGames count:', homeGamesArr.length);
      if (homeGamesArr[0]) {
        console.log('[MAPPER DEBUG] homeGames[0].statistics count:', homeGamesArr[0].statistics?.length);
        if (homeGamesArr[0].statistics?.[0]) {
          console.log('[MAPPER DEBUG] homeGames[0].statistics[0] keys:', Object.keys(homeGamesArr[0].statistics[0]));
          console.log('[MAPPER DEBUG] homeGames[0].statistics[0].statistics[0]:', homeGamesArr[0].statistics[0].statistics?.[0]);
        }
        console.log('[MAPPER DEBUG] homeGames[0].score.halftime:', homeGamesArr[0].score?.halftime);
      }
    }

    // ── /teams/statistics → PPG, xG proxy, BTTS, Under25 ────────
    const ppg_h       = _calcPPG(homeStats?.response);
    const ppg_a       = _calcPPG(awayStats?.response);
    const avg_sc_h    = _calcAvgGoals(homeStats?.response);
    const avg_sc_a    = _calcAvgGoals(awayStats?.response);
    const exg_h       = avg_sc_h;   // xG proxy = média de gols marcados (§3.1)
    const exg_a       = avg_sc_a;
    const btts_h      = _calcBTTS(homeStats?.response);
    const btts_a      = _calcBTTS(awayStats?.response);
    const under25_h   = _calcUnder25Rate(homeStats?.response);
    const under25_a   = _calcUnder25Rate(awayStats?.response);

    // ── /fixtures?last=10 → cantos, cartões, chutes, HT ─────────
    const homeMetrics = _processHistoricGames(homeGames, home_id);
    const awayMetrics = _processHistoricGames(awayGames, away_id);
    const merged      = _mergeHistoric(homeMetrics, awayMetrics);

    const {
      avg_corners, over65_c, over75_c, over85_c,
      avg_cards, over25_cards, over35_cards,
      avg_shots, avg_sot,
      over05_ht, over15_ht,
    } = merged;

    // ── /fixtures/headtohead → H2H goals ────────────────────────
    const h2hStats  = _calcH2HStats(h2hGames);
    const h2h_goals = h2hStats.h2h_goals;

    // ── /predictions → over15_g, over25_g ───────────────────────
    // Fallback idêntico ao V1 coletar.py:
    //   1. /predictions endpoint (se disponível — só ligas premium)
    //   2. h2h_over15 calculado dos jogos H2H (igual ao V1)
    //   3. avg_scored de cada time como estimativa final
    let { over15_g, over25_g } = _extractPredictionsOdds(
      Array.isArray(predictions?.response) ? predictions.response[0] : predictions
    );

    // Fallback 2 — h2h (V1: "if o15g is None and h2h.get('h2h_over15') is not None")
    if (over15_g === null && h2hStats.h2h_over15 !== null) {
      over15_g = h2hStats.h2h_over15;
    }
    if (over25_g === null && h2hStats.h2h_over25 !== null) {
      over25_g = h2hStats.h2h_over25;
    }

    // Fallback 3 — avg_scored (V1: "xg_h = ts_h.get('avg_scored')")
    // Quando predictions E h2h são nulos, estima over15_g via Poisson simples
    // P(gols >= 2) ≈ 1 - P(0) - P(1) onde lambda = avg_sc_h + avg_sc_a
    if (over15_g === null && avg_sc_h !== null && avg_sc_a !== null) {
      const lambda = avg_sc_h + avg_sc_a;
      if (lambda > 0) {
        const p0 = Math.exp(-lambda);
        const p1 = p0 * lambda;
        over15_g = Math.round((1 - p0 - p1) * 1000) / 10;  // % com 1 decimal
      }
    }
    if (over25_g === null && avg_sc_h !== null && avg_sc_a !== null) {
      const lambda = avg_sc_h + avg_sc_a;
      if (lambda > 0) {
        const p0 = Math.exp(-lambda);
        const p1 = p0 * lambda;
        const p2 = p1 * lambda / 2;
        over25_g = Math.round((1 - p0 - p1 - p2) * 1000) / 10;
      }
    }

    // ── /odds → todas as odds ────────────────────────────────────
    const allOdds = _extractAllOdds(
      Array.isArray(odds?.response) ? odds.response : odds
    );

    if (process.env.DEBUG_ODDS === '1') {
      const nonNull = Object.entries(allOdds).filter(([k, v]) => v !== null && !k.startsWith('odd_justa'));
      console.log(`[MAPPER] fixture_id=${fixture_id} — allOdds non-null: ${nonNull.length} → ${nonNull.map(([k,v])=>`${k}=${v}`).join(', ') || 'NONE'}`);
    }

    // ── Montar objeto raw ────────────────────────────────────────
    return {
      // Identificação
      fixture_id,
      home_team,
      away_team,
      league_name,
      league_id,
      season,
      match_date,
      hour,
      status,

      // Variáveis brutas §3.1
      over15_g,
      over25_g,
      exg_h,
      exg_a,
      ppg_h,
      ppg_a,
      h2h_goals,
      avg_sc_h,
      avg_sc_a,
      btts_h,
      btts_a,
      over05_ht,
      over15_ht,
      avg_corners,
      over65_c,
      over75_c,
      over85_c,
      avg_cards,
      over25_cards,
      over35_cards,
      avg_shots,
      avg_sot,
      under25_h,
      under25_a,

      // Odds de mercado
      ...allOdds,
    };
  }


  // ═══════════════════════════════════════════════════════════════
  // validatePackBallInput()
  // ═══════════════════════════════════════════════════════════════

  /**
   * validatePackBallInput(raw)
   * Valida o objeto raw antes de passar para processFixture().
   *
   * Retorna:
   *   {
   *     valid:    boolean      — true se sem erros críticos
   *     critical: string[]     — erros que impedem o cálculo
   *     warnings: string[]     — avisos de campos ausentes (motor usa null/fallback)
   *     info:     string[]     — informações (qual path de cálculo será usado)
   *   }
   *
   * @param {object} raw
   * @returns {{ valid:boolean, critical:string[], warnings:string[], info:string[] }}
   */
  function validatePackBallInput(raw) {
    const critical = [];
    const warnings = [];
    const info     = [];

    if (!raw || typeof raw !== 'object') {
      return { valid: false, critical: ['raw is null or not an object'], warnings: [], info: [] };
    }

    // ── Campos críticos (motor não funciona sem eles) ────────────
    if (raw.fixture_id === null || raw.fixture_id === undefined) {
      critical.push('fixture_id ausente — impossível identificar o jogo');
    }

    // O motor usa ws() que ignora nulos, então tecnicamente funciona sem
    // qualquer campo individual. Mas sem nenhuma variável o score será null.
    // Definimos como crítico: precisa de ao menos uma fonte de sinal central.
    const hasAnySignal = [
      raw.over15_g, raw.over25_g, raw.ppg_h, raw.ppg_a,
      raw.avg_sc_h, raw.avg_sc_a, raw.h2h_goals
    ].some(v => v !== null && v !== undefined);

    if (!hasAnySignal) {
      critical.push('Nenhuma variável de sinal disponível — todos os scores serão null');
    }

    // ── Validações de range ──────────────────────────────────────

    // Porcentagens devem estar entre 0 e 100
    const pctFields = {
      over15_g: raw.over15_g, over25_g: raw.over25_g,
      btts_h: raw.btts_h,  btts_a: raw.btts_a,
      over05_ht: raw.over05_ht, over15_ht: raw.over15_ht,
      over65_c: raw.over65_c,   over75_c: raw.over75_c,  over85_c: raw.over85_c,
      over25_cards: raw.over25_cards, over35_cards: raw.over35_cards,
      under25_h: raw.under25_h, under25_a: raw.under25_a,
    };
    for (const [field, val] of Object.entries(pctFields)) {
      if (val !== null && val !== undefined) {
        if (val < 0 || val > 100) {
          critical.push(`${field}=${val} fora do range [0–100]`);
        }
      }
    }

    // PPG deve estar entre 0 e 3
    for (const [field, val] of [['ppg_h', raw.ppg_h], ['ppg_a', raw.ppg_a]]) {
      if (val !== null && val !== undefined) {
        if (val < 0 || val > 3) warnings.push(`${field}=${val.toFixed(2)} fora do range esperado [0–3]`);
      }
    }

    // xG / avg_goals não devem ser negativos
    for (const f of ['exg_h', 'exg_a', 'avg_sc_h', 'avg_sc_a']) {
      if (raw[f] !== null && raw[f] !== undefined && raw[f] < 0) {
        critical.push(`${f}=${raw[f]} negativo — inválido`);
      }
    }

    // Odds devem ser > 1.0 se presentes
    const oddFields = ['odd_o15','odd_o25','odd_btts','odd_05ht','odd_u35','odd_u45',
                       'odd_esc75','odd_esc85','odd_c25','odd_c35'];
    for (const f of oddFields) {
      const v = raw[f];
      if (v !== null && v !== undefined) {
        if (v <= 1.0) warnings.push(`${f}=${v} inválido — odd deve ser > 1.0`);
        if (v > 50)   warnings.push(`${f}=${v} suspeito — odd > 50`);
      }
    }

    // ── Warnings de campos ausentes ──────────────────────────────

    if (raw.over15_g === null || raw.over15_g === undefined)
      warnings.push('over15_g ausente — sinal principal de Over 1.5 indisponível');

    if (raw.over25_g === null || raw.over25_g === undefined)
      warnings.push('over25_g ausente — sinal principal de Over 2.5 indisponível');

    if ((raw.exg_h === null || raw.exg_a === null) &&
        (raw.exg_h !== undefined && raw.exg_a !== undefined))
      warnings.push('xG parcial — exg_tot não será calculado; motor usará fórmula sem xG');

    if (raw.h2h_goals === null || raw.h2h_goals === undefined)
      warnings.push('h2h_goals ausente — componente H2H ignorado nos scores de gols');

    if (raw.avg_corners === null || raw.avg_corners === undefined)
      warnings.push('avg_corners ausente — scores de Escanteios serão muito imprecisos');

    if (raw.avg_cards === null || raw.avg_cards === undefined)
      warnings.push('avg_cards ausente — scores de Cartões serão muito imprecisos');

    // ── Info: path de cálculo que será usado ────────────────────

    const hasXG = raw.exg_h !== null && raw.exg_h !== undefined &&
                  raw.exg_a !== null && raw.exg_a !== undefined;

    info.push(`xG: ${hasXG ? `disponível (exg_h=${raw.exg_h?.toFixed(2)}, exg_a=${raw.exg_a?.toFixed(2)})` : 'indisponível — fórmula sem xG'}`);
    info.push(`Over 1.5: ${raw.over15_g !== null ? `${raw.over15_g?.toFixed(1)}%` : 'null'}`);
    info.push(`PPG: home=${raw.ppg_h?.toFixed(2) ?? 'null'} away=${raw.ppg_a?.toFixed(2) ?? 'null'}`);

    const over15_via = hasXG
      ? (raw.exg_h + raw.exg_a >= 4.5 ? 'Via 1 (xG alto)'
        : raw.exg_h + raw.exg_a >= 2.0 && Math.min(raw.ppg_h || 0, raw.ppg_a || 0) >= 0.7 ? 'Via 2 (equilíbrio)'
        : raw.over15_g >= 85 ? 'Via 4 (predictions)'
        : 'não passa')
      : (raw.over15_g >= 90 && (raw.ppg_h + raw.ppg_a) / 2 >= 1.5 ? 'Via 3 (sem xG)'
        : raw.over15_g >= 85 ? 'Via 4 (predictions)'
        : 'não passa');
    info.push(`Filtro Over 1.5: ${over15_via}`);

    const oddsCount = oddFields.filter(f => raw[f] !== null && raw[f] !== undefined).length;
    info.push(`Odds disponíveis: ${oddsCount}/${oddFields.length}`);

    return {
      valid:    critical.length === 0,
      critical,
      warnings,
      info,
    };
  }


  // ═══════════════════════════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════════════════════════

  return {
    mapFixtureToPackBall,
    validatePackBallInput,

    // Expõe helpers para testes
    _internal: {
      _num, _pct, _pos, _avg, _stat,
      _calcPPG, _calcAvgGoals, _calcBTTS, _calcUnder25Rate,
      _processHistoricGames, _mergeHistoric,
      _calcH2HGoals, _extractPredictionsOdds, _extractAllOdds,
    },
  };

})();

// Compatibilidade Node.js / Jest
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PackBallMapper;
}
