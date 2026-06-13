/**
 * PATCH: generate_predictions.js — Integração PackBall CSV Enricher
 * ──────────────────────────────────────────────────────────────────
 * Aplique as 3 mudanças abaixo no generate_predictions.js existente.
 * NÃO altere nada mais — todo o resto do pipeline permanece igual.
 */

// ═══════════════════════════════════════════════════════════════
// MUDANÇA 1 — IMPORTS (após a linha do enrichFromWorldCup)
// Adicionar após: const { enrichFromWorldCup } = require(...)
// ═══════════════════════════════════════════════════════════════

const { PackBallCSVEnricher, applyCsvToRaw } = require('../lib/packball_csv_enricher.js');


// ═══════════════════════════════════════════════════════════════
// MUDANÇA 2 — INSTANCIAR E CARREGAR (após criar o supabase client)
// Adicionar após: const supabase = ...
//
// O diretório ./data/packball deve conter os CSVs baixados do PackBall.
// Você pode colocar qualquer nome de arquivo — o enricher detecta o tipo
// pelo número de colunas automaticamente.
// ═══════════════════════════════════════════════════════════════

// Aceita 3 formatos — escolha um:
//   1. Pasta com CSVs:  '../data/packball'
//   2. Arquivo ZIP:     '../data/packball/Downloads.zip'
//   3. Pasta com ZIPs:  '../data/packball'  (extrai automaticamente)
const CSV_DIR = process.env.PACKBALL_CSV_DIR || path.join(__dirname, '../data/packball');
const csvEnricher = new PackBallCSVEnricher(CSV_DIR);


// ═══════════════════════════════════════════════════════════════
// MUDANÇA 3 — NO LOOP PRINCIPAL (função processDate ou equivalente)
//
// ANTES (código atual, ~linha 1153):
//
//   const apiData = await fetchAllData(entry);
//
//   const raw = await enrichFromWorldCup(
//     PackBallMapper.mapFixtureToPackBall(apiData),
//     supabase,
//     LOG
//   );
//
// DEPOIS (substituir pelas linhas abaixo):
// ═══════════════════════════════════════════════════════════════

      const apiData = await fetchAllData(entry);

      // ── ENRIQUECIMENTO CSV PackBall ──────────────────────────
      // Injeta dados dos CSVs do PackBall no apiData antes do mapper.
      // Cobre todas as ligas presentes nos CSVs (Copa do Mundo, BR, EU, etc.)
      csvEnricher.enrich(apiData);

      // ── FASE 3: Mapear + validar + calcular ─────────────────
      let raw = await enrichFromWorldCup(
        PackBallMapper.mapFixtureToPackBall(apiData),
        supabase,
        LOG
      );

      // ── APLICAR DADOS CSV SOBRE O raw DO MAPPER ─────────────
      // O mapper rodou com os dados da API-Football.
      // Agora aplicamos os dados do CSV:
      //   • Campos com prioridade CSV: over15_g, over25_g, cantos, cartões, HT
      //   • Campos fallback CSV: xG, PPG, h2h_goals (quando API retornou null)
      if (apiData.packballCSV) {
        raw = applyCsvToRaw(raw, apiData.packballCSV, LOG);
      }

// ═══════════════════════════════════════════════════════════════
// MUDANÇA 4 — CARREGAR CSVs NO INÍCIO DA EXECUÇÃO
// Adicionar no início da função main() ou run(), antes do loop de datas.
// ═══════════════════════════════════════════════════════════════

  // Carrega CSVs do PackBall uma vez antes de processar os jogos
  await csvEnricher.load();
  LOG.info(`[CSVEnricher] ${csvEnricher.index.size} jogos indexados dos CSVs do PackBall`);


// ═══════════════════════════════════════════════════════════════
// ESTRUTURA DE PASTAS ESPERADA
// ═══════════════════════════════════════════════════════════════
//
// frontend/
// ├── jobs/
// │   └── generate_predictions.js   ← arquivo principal (modificado)
// ├── lib/
// │   ├── packball_mapper.js
// │   ├── packball_csv_enricher.js  ← arquivo novo criado
// │   └── ...
// └── data/
//     └── packball/                 ← pasta onde você coloca os CSVs
//         ├── PackBall Custom Over gols - CR DESIGNER 13-06-2026.csv
//         ├── PackBall Custom OVER GOLS 01 13-06-2026.csv
//         ├── PackBall Custom OVER GOLS 02 13-06-2026.csv
//         ├── PackBall Custom ESCANTEIOS 13-06-2026.csv
//         ├── PackBall Custom CARTÕES 13-06-2026.csv
//         ├── PackBall Custom Filtro 01 13-06-2026.csv
//         ├── PackBall Custom RESULTADO FINAL 13-06-2026.csv
//         └── PackBall Custom Geral 13-06-2026.csv
//
// Você pode manter os nomes originais do PackBall — o enricher
// detecta o tipo pelo número de colunas, não pelo nome do arquivo.
//
// Para testar com debug detalhado dos campos aplicados:
//   DEBUG_CSV=1 node generate_predictions.js --date=2026-06-13 --dry-run
