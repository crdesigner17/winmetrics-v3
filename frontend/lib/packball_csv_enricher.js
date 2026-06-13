/**
 * WinMetrics Analytics — PackBall CSV Enricher
 * ──────────────────────────────────────────────
 * Lê os 8 CSVs exportados manualmente do PackBall (-7/+7 dias)
 * e enriquece o objeto `apiData` antes de passar ao PackBallMapper.
 *
 * Estratégia:
 *   • CSV é fonte PRIMÁRIA para todos os campos disponíveis
 *   • API-Football é fallback para o que o CSV não cobre (IDs, odds, status)
 *   • Cobertura: todas as ligas presentes nos CSVs (Mundial, BR, EU, etc.)
 *
 * Uso no generate_predictions.js:
 *   const { PackBallCSVEnricher } = require('../lib/packball_csv_enricher.js');
 *   const enricher = new PackBallCSVEnricher('./data/packball');
 *   await enricher.load();
 *   // ... no loop de fixtures:
 *   const apiData = await fetchAllData(entry);
 *   enricher.enrich(apiData);  // modifica apiData in-place
 *
 * Estrutura esperada de ./data/packball/:
 *   packball_geral.csv
 *   packball_over_gols_cr.csv       ← over15_g, over25_g (PRINCIPAL)
 *   packball_over_gols_01.csv       ← h2h, btts
 *   packball_over_gols_02.csv       ← HT gols
 *   packball_escanteios.csv         ← cantos
 *   packball_cartoes.csv            ← cartões
 *   packball_filtro01.csv           ← xG, PPG
 *   packball_resultado_final.csv    ← win%, shots, resultado esperado
 *
 * O nome do arquivo é flexível — o enricher detecta o tipo pelo conteúdo.
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { execSync } = require('child_process');

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

/** Converte string para número ou null */
function _n(v) {
  if (v === null || v === undefined || v === '' || v === '""') return null;
  const f = parseFloat(String(v).replace(',', '.'));
  return isFinite(f) ? f : null;
}

/** Normaliza nome de time para comparação fuzzy */
function _normName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normaliza data para YYYY-MM-DD */
function _normDate(raw) {
  if (!raw) return null;
  // Formatos possíveis: "13-06-2026 19:00", "2026-06-13", "2026-06-13T19:00:00"
  const m = String(raw).match(/(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const m2 = String(raw).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

/**
 * Parseia um CSV do PackBall.
 * Os CSVs usam ponto-e-vírgula como separador e aspas em alguns campos.
 * A primeira linha é o header com nomes genéricos (Global, Casa, Fora, etc.)
 * Retorna array de arrays de strings (raw rows).
 */
function _parseCSV(filepath) {
  const raw = fs.readFileSync(filepath, { encoding: 'utf-8' });
  // Remove BOM se houver
  const content = raw.replace(/^\uFEFF/, '');
  const lines = content.split('\n').filter(l => l.trim());

  return lines.map(line => {
    // Split por ; respeitando aspas
    const fields = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ';' && !inQuote) {
        fields.push(cur.trim().replace(/^"+|"+$/g, ''));
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim().replace(/^"+|"+$/g, ''));
    return fields;
  });
}

/**
 * Detecta o tipo de CSV pelo conteúdo da primeira linha (header).
 * Retorna: 'geral' | 'over_cr' | 'over01' | 'over02' | 'escanteios' | 'cartoes' | 'filtro01' | 'resultado' | 'unknown'
 */
function _detectCSVType(rows) {
  if (!rows || rows.length < 2) return 'unknown';
  const header = (rows[0] || []).join(';').toLowerCase();
  const row1   = (rows[1] || []);
  const ncols  = row1.length;

  // Over Gols CR Designer — tem ~24 colunas, col[11] é over15 (valor 90 para Brazil)
  if (ncols >= 24 && ncols <= 26) return 'over_cr';

  // Filtro 01 — ~28 colunas
  if (ncols >= 27 && ncols <= 29) return 'filtro01';

  // Cartões — ~55 colunas
  if (ncols >= 53 && ncols <= 57) return 'cartoes';

  // Escanteios — ~73 colunas
  if (ncols >= 70 && ncols <= 76) return 'escanteios';

  // Over Gols 02 — ~46 colunas
  if (ncols >= 44 && ncols <= 48) return 'over02';

  // Over Gols 01 — ~70 colunas
  if (ncols >= 68 && ncols <= 72) return 'over01';

  // Resultado Final — ~72 colunas
  if (ncols >= 70 && ncols <= 74) return 'resultado';

  // Geral — ~66 colunas
  if (ncols >= 64 && ncols <= 68) return 'geral';

  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────
// EXTRACTORS POR TIPO DE CSV
// ─────────────────────────────────────────────────────────────────

/**
 * CSV: Over Gols CR Designer (~24 cols)
 * Colunas relevantes (0-indexed):
 *   [0]  Country
 *   [3]  Hour (data e hora)
 *   [5]  Home Team
 *   [8]  Visitor Team
 *   [11] over15_g (Global %)
 *   [12] over25_g (Global %)
 *   [13] over05_ht (Global %)
 *   [14] over15_ht (Global %)
 *   [16] h2h_n (número de jogos H2H)
 *   [17] win_pct_home (%)
 *   [18] win_pct_away (%)
 *   [21] exg_h (xG casa)
 *   [22] exg_a (xG fora)
 *   [23] avg_sc_h
 *   [24] avg_sc_a
 */
function _extractOverCR(row) {
  return {
    over15_g:   _n(row[11]),
    over25_g:   _n(row[12]),
    over05_ht:  _n(row[13]),
    over15_ht:  _n(row[14]),
    exg_h:      _n(row[21]),
    exg_a:      _n(row[22]),
    avg_sc_h:   _n(row[23]),
    avg_sc_a:   _n(row[24]),
  };
}

/**
 * CSV: Filtro 01 (~28 cols)
 * Colunas relevantes:
 *   [13] ppg_global
 *   [14] ppg_h (PPG casa)
 *   [15] ppg_a (PPG fora)
 *   [17] win_pct_home
 *   [18] win_pct_away
 *   [21] h2h_n
 *   [22] h2h_n2
 *   [23] exg_h (xG casa média)
 *   [24] exg_a (xG fora média)
 *   [25] avg_corners_global
 *   [26] exg_h2
 *   [27] exg_a2
 *   [28] avg_corners2
 */
function _extractFiltro01(row) {
  return {
    ppg_h:        _n(row[14]),
    ppg_a:        _n(row[15]),
    exg_h:        _n(row[23]),
    exg_a:        _n(row[24]),
    avg_corners:  _n(row[28]),
  };
}

/**
 * CSV: Over Gols 01 (~70 cols)
 * Colunas relevantes:
 *   [14] global_over15 (H2H over15%)
 *   [15] global_over25 (H2H over25%)
 *   [20] btts_home (%)
 *   [21] btts_away (%)
 *   [37] h2h_goals_avg
 *   [49] avg_gols_h
 *   [50] avg_gols_a
 */
function _extractOver01(row) {
  return {
    h2h_over15:   _n(row[14]),
    h2h_over25:   _n(row[15]),
    btts_h:       _n(row[20]),
    btts_a:       _n(row[21]),
    h2h_goals:    _n(row[37]),
    avg_sc_h:     _n(row[49]),
    avg_sc_a:     _n(row[50]),
  };
}

/**
 * CSV: Over Gols 02 (~46 cols)
 * Colunas relevantes:
 *   [19] over05_ht (%)
 *   [20] over15_ht (%)
 *   [25] avg_ht_goals_h
 *   [26] avg_ht_goals_a
 */
function _extractOver02(row) {
  return {
    over05_ht:  _n(row[19]),
    over15_ht:  _n(row[20]),
  };
}

/**
 * CSV: Escanteios (~73 cols)
 * Colunas relevantes:
 *   [14] avg_corners_global
 *   [37] over65_c (%)
 *   [38] over75_c (%)
 *   [49] over85_c (%)
 *   [67] avg_corners_h
 *   [68] avg_corners_a
 *   [69] avg_corners_h2
 *   [70] avg_corners_a2
 *   [71] over75_c_alt
 */
function _extractEscanteios(row) {
  return {
    avg_corners: _n(row[37]) ?? _n(row[14]),
    over65_c:    _n(row[49]),
    over75_c:    _n(row[50]),
    over85_c:    _n(row[51]),
  };
}

/**
 * CSV: Cartões (~55 cols)
 * Colunas relevantes:
 *   [15] win_pct_home_cards
 *   [16] win_pct_away_cards
 *   [23] avg_cards_global
 *   [28] avg_cards_global2
 *   [47] over25_cards (%)
 *   [48] over35_cards (%)
 *   [49] over45_cards (%)
 *   [50] over55_cards (%)
 *   [51] over25_cards2
 *   [52] over35_cards2
 *   [53] over45_cards2
 *   [54] over55_cards2
 */
function _extractCartoes(row) {
  return {
    avg_cards:     _n(row[33]) ?? _n(row[39]) ?? _n(row[23]),
    over25_cards:  _n(row[47]),
    over35_cards:  _n(row[48]),
    over45_cards:  _n(row[49]),
  };
}

/**
 * CSV: Resultado Final (~72 cols)
 * Colunas relevantes:
 *   [13] win_home (%)
 *   [14] win_away (%)
 *   [17] avg_shots_h
 *   [18] avg_shots_a
 *   [46] avg_shots_global
 *   [47] exg_h
 *   [48] exg_a
 *   [49] ppg_h
 *   [50] ppg_a
 *   [51] avg_corners_global
 *   [52] win_h_%
 *   [53] win_a_%
 */
function _extractResultado(row) {
  return {
    win_home:   _n(row[13]),
    win_away:   _n(row[14]),
    avg_shots:  _n(row[46]),
    avg_sot:    null, // não disponível neste CSV
    ppg_h:      _n(row[49]),
    ppg_a:      _n(row[50]),
  };
}

/**
 * CSV: Geral (~66 cols)
 * Usado como complemento — tem xG, PPG e médias gerais
 * Colunas relevantes:
 *   [19] avg_sc_global
 *   [27] exg_h
 *   [28] exg_a
 *   [34] avg_corners_global
 */
function _extractGeral(row) {
  return {
    // Geral é complemento — só preenche o que outros não têm
    avg_corners_geral: _n(row[34]),
  };
}

// ─────────────────────────────────────────────────────────────────
// HELPERS DE ARQUIVO
// ─────────────────────────────────────────────────────────────────

/** Encontra todos os CSVs recursivamente em uma pasta */
function _findCSVsRecursive(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        results.push(..._findCSVsRecursive(full));
      } else if (entry.toLowerCase().endsWith('.csv')) {
        results.push(full);
      }
    }
  } catch (e) {}
  return results;
}

// ─────────────────────────────────────────────────────────────────
// CLASSE PRINCIPAL
// ─────────────────────────────────────────────────────────────────

class PackBallCSVEnricher {
  /**
   * @param {string} csvDir — diretório com os CSVs do PackBall
   *   Aceita também um array de caminhos de arquivo: [path1, path2, ...]
   */
  constructor(csvDir) {
    this.csvDir  = csvDir;
    this.index   = new Map(); // chave: "home_norm|away_norm|date" → dados mesclados
    this.loaded  = false;
    this.stats   = { files: 0, rows: 0, indexed: 0, types: {} };
  }

  /**
   * Carrega e indexa todos os CSVs do diretório.
   * Pode ser chamado com await antes do loop de fixtures.
   */
  async load() {
    let files = [];
    let tmpDir = null; // pasta temporária se extraiu ZIP

    if (Array.isArray(this.csvDir)) {
      // Array de caminhos diretos
      files = this.csvDir.filter(f => fs.existsSync(f));

    } else if (typeof this.csvDir === 'string') {
      if (!fs.existsSync(this.csvDir)) {
        console.warn(`[CSVEnricher] Caminho não encontrado: ${this.csvDir}`);
        this.loaded = true;
        return;
      }

      const stat = fs.statSync(this.csvDir);

      if (stat.isFile() && this.csvDir.toLowerCase().endsWith('.zip')) {
        // ── ZIP: extrair para pasta temporária ──────────────────
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packball_'));
        console.log(`[CSVEnricher] Extraindo ZIP para ${tmpDir}...`);
        try {
          execSync(`unzip -o "${this.csvDir}" -d "${tmpDir}"`, { stdio: 'pipe' });
        } catch (err) {
          // unzip pode retornar exit 1 com warnings — verifica se extraiu algo
          if (!fs.readdirSync(tmpDir).length) {
            console.error('[CSVEnricher] Falha ao extrair ZIP:', err.message);
            this.loaded = true;
            return;
          }
        }
        // Coleta CSVs da pasta extraída (incluindo subpastas)
        files = _findCSVsRecursive(tmpDir);

      } else if (stat.isDirectory()) {
        // ── DIRETÓRIO: lê CSVs e ZIPs ───────────────────────────
        const entries = fs.readdirSync(this.csvDir);

        // Extrai ZIPs encontrados no diretório
        for (const entry of entries) {
          if (entry.toLowerCase().endsWith('.zip')) {
            const zipPath = path.join(this.csvDir, entry);
            if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packball_'));
            try {
              execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' });
              console.log(`[CSVEnricher] ZIP extraído: ${entry}`);
            } catch (e) { /* ignora warnings do unzip */ }
          }
        }

        // CSVs diretos na pasta
        const directCSVs = entries
          .filter(f => f.toLowerCase().endsWith('.csv'))
          .map(f => path.join(this.csvDir, f));

        // CSVs extraídos dos ZIPs
        const zippedCSVs = tmpDir ? _findCSVsRecursive(tmpDir) : [];

        files = [...directCSVs, ...zippedCSVs];
      }
    }

    if (files.length === 0) {
      console.warn('[CSVEnricher] Nenhum CSV encontrado.');
      this.loaded = true;
      return;
    }

    for (const filepath of files) {
      try {
        this._loadFile(filepath);
        this.stats.files++;
      } catch (err) {
        console.error(`[CSVEnricher] Erro ao carregar ${path.basename(filepath)}:`, err.message);
      }
    }

    // Limpa pasta temporária
    if (tmpDir && fs.existsSync(tmpDir)) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }

    this.loaded = true;
    console.log(
      `[CSVEnricher] Carregados ${this.stats.files} CSVs → ` +
      `${this.stats.indexed} jogos indexados ` +
      `(${Object.entries(this.stats.types).map(([k,v])=>`${k}:${v}`).join(', ')})`
    );
  }

  /**
   * Carrega um único arquivo CSV e indexa os dados.
   */
  _loadFile(filepath) {
    const rows = _parseCSV(filepath);
    if (rows.length < 2) return;

    const type = _detectCSVType(rows);
    this.stats.types[type] = (this.stats.types[type] || 0) + 1;

    if (type === 'unknown') {
      console.warn(`[CSVEnricher] Tipo desconhecido: ${path.basename(filepath)} (${rows[1]?.length} cols)`);
      return;
    }

    // Processa cada linha de dados (pula header)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 5) continue;

      const homeRaw = row[5];
      const awayRaw = row[8];
      const dateRaw = row[3];

      if (!homeRaw || !awayRaw) continue;

      const home = _normName(homeRaw);
      const away = _normName(awayRaw);
      const date = _normDate(dateRaw);

      if (!home || !away) continue;

      // Extrair dados conforme tipo
      let data = {};
      switch (type) {
        case 'over_cr':   data = _extractOverCR(row);   break;
        case 'filtro01':  data = _extractFiltro01(row);  break;
        case 'over01':    data = _extractOver01(row);    break;
        case 'over02':    data = _extractOver02(row);    break;
        case 'escanteios':data = _extractEscanteios(row);break;
        case 'cartoes':   data = _extractCartoes(row);   break;
        case 'resultado': data = _extractResultado(row); break;
        case 'geral':     data = _extractGeral(row);     break;
        default: continue;
      }

      // Indexar por combinação home|away|date
      const key = `${home}|${away}|${date || 'nodate'}`;
      const existing = this.index.get(key) || {};
      // Mescla: dados novos só sobrescrevem se o campo existente for null
      const merged = this._merge(existing, data);
      this.index.set(key, merged);

      // Também indexar sem data (fallback)
      const keyNoDate = `${home}|${away}|nodate`;
      if (date) {
        const exNoDate = this.index.get(keyNoDate) || {};
        this.index.set(keyNoDate, this._merge(exNoDate, data));
      }

      this.stats.rows++;
    }

    this.stats.indexed = this.index.size;
  }

  /**
   * Mescla dois objetos de dados.
   * Prioridade: valor existente > novo valor (não sobrescreve dados já presentes)
   * Exceto quando o valor existente é null/undefined.
   */
  _merge(existing, incoming) {
    const result = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
      if (v !== null && v !== undefined && (result[k] === null || result[k] === undefined)) {
        result[k] = v;
      }
    }
    return result;
  }

  /**
   * Busca dados do PackBall para um jogo.
   * Tenta várias combinações de nome para lidar com variações de escrita.
   *
   * @param {string} homeTeam — nome do time da casa (da API-Football)
   * @param {string} awayTeam — nome do visitante
   * @param {string} matchDate — YYYY-MM-DD
   * @returns {object|null} dados do PackBall ou null se não encontrado
   */
  lookup(homeTeam, awayTeam, matchDate) {
    if (!this.loaded || this.index.size === 0) return null;

    const home = _normName(homeTeam);
    const away = _normName(awayTeam);
    const date = matchDate ? matchDate.slice(0, 10) : null;

    // Tentativa 1: match exato com data
    if (date) {
      const key = `${home}|${away}|${date}`;
      if (this.index.has(key)) return this.index.get(key);
    }

    // Tentativa 2: sem data
    const keyNoDate = `${home}|${away}|nodate`;
    if (this.index.has(keyNoDate)) return this.index.get(keyNoDate);

    // Tentativa 3: fuzzy — procura por contains
    // (cobre casos como "Brazil" vs "Brasil", "Man City" vs "Manchester City")
    for (const [k, v] of this.index.entries()) {
      const [kHome, kAway, kDate] = k.split('|');

      // Verificar data se disponível
      if (date && kDate !== 'nodate' && kDate !== date) continue;

      // Verificar se os nomes contêm um ao outro
      const homeMatch = kHome.includes(home) || home.includes(kHome) ||
                        _fuzzyMatch(home, kHome);
      const awayMatch = kAway.includes(away) || away.includes(kAway) ||
                        _fuzzyMatch(away, kAway);

      if (homeMatch && awayMatch) return v;
    }

    return null;
  }

  /**
   * Enriquece o objeto apiData com dados do PackBall CSV.
   * Modifica apiData in-place, adicionando propriedade `packballCSV`.
   * O PackBallMapper deve ser adaptado para ler de apiData.packballCSV.
   *
   * @param {object} apiData — objeto retornado por fetchAllData()
   * @returns {object} apiData modificado
   */
  enrich(apiData) {
    if (!apiData) return apiData;

    const homeName  = apiData.fixture?.teams?.home?.name;
    const awayName  = apiData.fixture?.teams?.away?.name;
    const matchDate = apiData.fixture?.fixture?.date;

    const csvData = this.lookup(homeName, awayName, matchDate);

    if (csvData) {
      apiData.packballCSV = csvData;
    } else {
      apiData.packballCSV = null;
    }

    return apiData;
  }

  /**
   * Retorna estatísticas de cobertura para debug.
   */
  getCoverageStats() {
    return { ...this.stats, indexSize: this.index.size };
  }
}

// ─────────────────────────────────────────────────────────────────
// FUZZY MATCH
// ─────────────────────────────────────────────────────────────────

/**
 * Match fuzzy simples por palavras comuns.
 * Considera match se >= 60% das palavras do nome menor estão no maior.
 */
function _fuzzyMatch(a, b) {
  if (!a || !b) return false;
  const wordsA = a.split(' ').filter(w => w.length > 2);
  const wordsB = b.split(' ').filter(w => w.length > 2);
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longer  = wordsA.length <= wordsB.length ? wordsB : wordsA;

  const matches = shorter.filter(w => longer.some(lw => lw.includes(w) || w.includes(lw)));
  return matches.length / shorter.length >= 0.6;
}

// ─────────────────────────────────────────────────────────────────
// PATCH PARA O PACKBALL MAPPER
// ─────────────────────────────────────────────────────────────────

/**
 * applyCsvToRaw(raw, csvData)
 *
 * Aplica os dados do CSV ao objeto `raw` APÓS o PackBallMapper rodar.
 * Sobrescreve campos com valores do CSV quando o CSV tem dado e o mapper
 * retornou null (dados insuficientes da API-Football).
 *
 * Campos com prioridade CSV:
 *   - over15_g, over25_g: CSV sempre tem prioridade (PackBall calcula melhor)
 *   - exg_h, exg_a: CSV substitui quando API retornou null
 *   - ppg_h, ppg_a: CSV substitui quando API retornou null
 *   - h2h_goals: CSV substitui quando API retornou null
 *   - avg_corners, over65_c, over75_c, over85_c: CSV prioridade
 *   - avg_cards, over25_cards, over35_cards, over45_cards: CSV prioridade
 *   - over05_ht, over15_ht: CSV prioridade
 *   - avg_sc_h, avg_sc_a: CSV quando null
 *   - win_home, win_away: CSV quando null
 *
 * @param {object} raw — objeto raw do PackBallMapper
 * @param {object} csvData — dados do PackBall CSV
 * @param {object} [LOG] — logger opcional
 * @returns {object} raw modificado
 */
function applyCsvToRaw(raw, csvData, LOG) {
  if (!raw || !csvData) return raw;

  const log = LOG || { dim: () => {}, info: () => {} };
  const changes = [];

  // Campos onde CSV tem PRIORIDADE TOTAL (sempre substitui, mesmo com dado da API)
  const csvPriority = [
    'over15_g', 'over25_g',           // PackBall calcula melhor que predictions API
    'avg_corners', 'over65_c', 'over75_c', 'over85_c',  // cantos
    'avg_cards', 'over25_cards', 'over35_cards', 'over45_cards',  // cartões
    'over05_ht', 'over15_ht',         // half-time
    'btts_h', 'btts_a',              // BTTS
  ];

  // Campos onde CSV é FALLBACK (só substitui se API retornou null)
  const csvFallback = [
    'exg_h', 'exg_a',
    'ppg_h', 'ppg_a',
    'h2h_goals',
    'avg_sc_h', 'avg_sc_a',
    'avg_shots', 'avg_sot',
    'win_home', 'win_away',
  ];

  for (const field of csvPriority) {
    const csvVal = csvData[field];
    if (csvVal !== null && csvVal !== undefined) {
      if (raw[field] !== csvVal) {
        changes.push(`${field}: ${raw[field]} → ${csvVal} (CSV override)`);
      }
      raw[field] = csvVal;
    }
  }

  for (const field of csvFallback) {
    const csvVal = csvData[field];
    const apiVal = raw[field];
    if ((field === 'ppg_h' || field === 'ppg_a') && (csvVal < 0 || csvVal > 3)) {
      if (process.env.DEBUG_CSV === '1') {
        log.dim(`    • ${field}: ${csvVal} ignorado (fora do range PPG 0-3)`);
      }
      continue;
    }
    const apiMissing = apiVal === null || apiVal === undefined;
    const zeroMeansMissing = (field === 'exg_h' || field === 'exg_a') && apiVal === 0 && csvVal > 0;
    if (csvVal !== null && csvVal !== undefined && (apiMissing || zeroMeansMissing)) {
      changes.push(`${field}: ${apiMissing ? 'null' : apiVal} → ${csvVal} (CSV fallback)`);
      raw[field] = csvVal;
    }
  }

  if (changes.length > 0) {
    log.dim(`  [CSVEnricher] ${raw.home_team} vs ${raw.away_team}: ${changes.length} campos enriquecidos`);
    if (process.env.DEBUG_CSV === '1') {
      changes.forEach(c => log.dim(`    • ${c}`));
    }
  }

  return raw;
}

// ─────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────

module.exports = { PackBallCSVEnricher, applyCsvToRaw };
