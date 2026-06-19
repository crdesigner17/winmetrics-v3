#!/usr/bin/env node
/**
 * WinMetrics V3 — Extrai contexto manual da Copa do Mundo (PDF/Imagem/Texto → JSON)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lê PDFs, imagens (PNG/JPG/WEBP) e textos (TXT/MD) com notícias, escalações,
 * tabelas de grupo, relatórios de lesão, etc., manda pra Claude extrair os
 * campos do mercado "Resultado Final (Vitória)" e atualiza automaticamente
 * frontend/data/wc_manual_context.json.
 *
 * REGRA DE OURO: a IA só preenche um campo se o documento realmente disser
 * aquilo. squadQuality/cupPedigree podem ser estimativa da IA (são
 * subjetivos por natureza), mas desfalques/contexto de grupo/rotação só são
 * preenchidos se estiverem escritos no documento — nunca inventados.
 *
 * Uso:
 *   node scripts/extract_wc_context.js --dir=./wc_context_inbox
 *   node scripts/extract_wc_context.js --files=docs/brasil_lesoes.pdf,docs/grupo_e.png
 *   node scripts/extract_wc_context.js --dir=./wc_context_inbox --dry-run   (não salva, só mostra)
 *
 * Variáveis de ambiente:
 *   ANTHROPIC_API_KEY — sua chave da API da Anthropic
 *
 * Fluxo recomendado:
 *   1. Jogue PDFs/prints/notícias na pasta ./wc_context_inbox antes da rodada
 *   2. Rode este script
 *   3. Confira o resumo impresso no terminal
 *   4. Dê commit/push em frontend/data/wc_manual_context.json
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL              = 'claude-sonnet-4-6';
const CONTEXT_PATH        = path.join(__dirname, '../frontend/data/wc_manual_context.json');

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dirArg   = args.find(a => a.startsWith('--dir='))?.split('=')[1]   || null;
const filesArg = args.find(a => a.startsWith('--files='))?.split('=')[1] || null;

// ─────────────────────────────────────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────────────────────────────────────
const LOG = {
  info:  (...a) => console.log(`\x1b[36m[INFO]\x1b[0m `, ...a),
  ok:    (...a) => console.log(`\x1b[32m[ OK ]\x1b[0m `, ...a),
  warn:  (...a) => console.warn(`\x1b[33m[WARN]\x1b[0m `, ...a),
  error: (...a) => console.error(`\x1b[31m[ERR ]\x1b[0m `, ...a),
};

// ─────────────────────────────────────────────────────────────────────────────
// COLETA DE ARQUIVOS
// ─────────────────────────────────────────────────────────────────────────────
function collectFiles() {
  let files = [];
  if (dirArg) {
    if (!fs.existsSync(dirArg)) {
      LOG.error(`Pasta não encontrada: ${dirArg}`);
      process.exit(1);
    }
    files = fs.readdirSync(dirArg)
      .map(f => path.join(dirArg, f))
      .filter(f => fs.statSync(f).isFile());
  }
  if (filesArg) {
    files = files.concat(filesArg.split(',').map(f => f.trim()).filter(Boolean));
  }
  return files;
}

function fileKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return { kind: 'document', mediaType: 'application/pdf' };
  if (ext === '.png') return { kind: 'image', mediaType: 'image/png' };
  if (['.jpg', '.jpeg'].includes(ext)) return { kind: 'image', mediaType: 'image/jpeg' };
  if (ext === '.webp') return { kind: 'image', mediaType: 'image/webp' };
  if (['.txt', '.md'].includes(ext)) return { kind: 'text' };
  return null;
}

function buildContentBlocks(files) {
  const blocks = [];
  for (const file of files) {
    const info = fileKind(file);
    if (!info) { LOG.warn(`Tipo não suportado, pulando: ${file}`); continue; }

    if (info.kind === 'text') {
      const text = fs.readFileSync(file, 'utf8');
      blocks.push({ type: 'text', text: `\n--- Arquivo: ${path.basename(file)} ---\n${text}` });
    } else {
      const data = fs.readFileSync(file).toString('base64');
      blocks.push({
        type: info.kind, // 'document' (pdf) ou 'image'
        source: { type: 'base64', media_type: info.mediaType, data },
      });
      blocks.push({ type: 'text', text: `(arquivo acima: ${path.basename(file)})` });
    }
    LOG.info(`Carregado: ${path.basename(file)}`);
  }
  return blocks;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT DE EXTRAÇÃO
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é um analista extraindo dados estruturados de documentos (notícias, escalações, tabelas de grupo, relatórios de lesão) para abastecer um sistema de previsões da Copa do Mundo 2026 (mercado "Resultado Final - Vitória").

Para CADA seleção nacional mencionada nos documentos, extraia/estime estes campos:

- squadQuality (0-100): qualidade geral do elenco. Pode ser uma estimativa SUA baseada no que os documentos descrevem (nomes de jogadores, nível dos clubes, profundidade do elenco) — é subjetivo por natureza. Se não houver base nenhuma nos documentos, OMITA o campo.
- cupPedigree (0-100): histórico/tradição em Copas do Mundo. SOMENTE se os documentos mencionarem isso explicitamente (campanhas anteriores, títulos, participações). Senão, omita.
- groupContext: { needsWin, alreadyQualified, eliminated } (booleanos) — SOMENTE se os documentos disserem a situação atual do time no grupo. Senão, omita o campo inteiro (não os sub-campos individualmente — omita "groupContext" por completo se não há informação).
- missingKeyPlayers: { strikerOut, goalkeeperOut, centerBackOut } (booleanos) — SOMENTE se os documentos mencionarem desfalque/lesão/suspensão explicitamente de um atacante principal, goleiro titular ou zagueiro titular. Senão, omita o campo inteiro.
- rotationRisk (bool) — SOMENTE se os documentos sinalizarem que o técnico vai poupar titulares (ex: time já classificado, jogo decisivo já perdido sentido).
- unpredictable (bool) — SOMENTE se os documentos mencionarem resultados muito inconsistentes desta seleção nesta edição.

REGRA MAIS IMPORTANTE: nunca invente um fato que não está no documento. squadQuality e cupPedigree podem ser sua avaliação (deixe claro em "_sourceNotes" que é estimativa). Mas missingKeyPlayers, groupContext, rotationRisk e unpredictable só podem vir de algo realmente escrito no documento — se não tiver, OMITA o campo (não escreva false "por padrão").

Use o nome da seleção em inglês, como aparece na API-Football (ex: "Brazil", "USA", "South Korea", "Bosnia and Herzegovina", "DR Congo", "Czechia", "Ivory Coast").

Responda APENAS com um JSON válido, sem markdown, sem texto antes ou depois, neste formato exato:
{
  "teams": {
    "Nome Exato da Seleção": {
      "squadQuality": 80,
      "cupPedigree": 70,
      "groupContext": { "needsWin": true },
      "missingKeyPlayers": { "strikerOut": true },
      "rotationRisk": false,
      "unpredictable": false,
      "_sourceNotes": "breve nota de qual documento/trecho embasou cada campo preenchido"
    }
  }
}`;

async function callClaude(blocks) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 4000,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: blocks }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const textBlock = (json.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Resposta da API sem bloco de texto.');
  return textBlock.text;
}

function parseClaudeJson(text) {
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE NO ARQUIVO EXISTENTE — preserva o que já estava lá, só sobrescreve
// os campos que vieram com dado novo nesta extração.
// ─────────────────────────────────────────────────────────────────────────────
function mergeContext(existing, extracted) {
  const merged = JSON.parse(JSON.stringify(existing));
  if (!merged.teams) merged.teams = {};

  for (const [team, fields] of Object.entries(extracted.teams || {})) {
    const prev = merged.teams[team] || {};
    merged.teams[team] = {
      ...prev,
      ...fields,
      groupContext: fields.groupContext
        ? { ...(prev.groupContext || {}), ...fields.groupContext }
        : prev.groupContext,
      missingKeyPlayers: fields.missingKeyPlayers
        ? { ...(prev.missingKeyPlayers || {}), ...fields.missingKeyPlayers }
        : prev.missingKeyPlayers,
    };
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n' + '═'.repeat(64));
  console.log(' WinMetrics V3 — Extract WC Manual Context');
  console.log('═'.repeat(64) + '\n');

  if (!ANTHROPIC_API_KEY) {
    LOG.error('ANTHROPIC_API_KEY não configurada.');
    process.exit(1);
  }

  const files = collectFiles();
  if (!files.length) {
    LOG.error('Nenhum arquivo informado. Use --dir=./pasta ou --files=a.pdf,b.png');
    process.exit(1);
  }

  LOG.info(`${files.length} arquivo(s) encontrado(s). Lendo...`);
  const blocks = buildContentBlocks(files);
  blocks.push({
    type: 'text',
    text: '\nExtraia os dados de TODAS as seleções mencionadas acima, seguindo as regras do system prompt.',
  });

  LOG.info('Chamando Claude para extração...');
  const responseText = await callClaude(blocks);

  let extracted;
  try {
    extracted = parseClaudeJson(responseText);
  } catch (e) {
    LOG.error('Resposta da IA não veio em JSON válido:');
    console.log(responseText);
    process.exit(1);
  }

  const existingRaw = fs.existsSync(CONTEXT_PATH)
    ? fs.readFileSync(CONTEXT_PATH, 'utf8')
    : '{"teams":{}}';
  const existing = JSON.parse(existingRaw);
  const merged = mergeContext(existing, extracted);

  console.log('\n' + '─'.repeat(64));
  console.log(' Times extraídos nesta rodada');
  console.log('─'.repeat(64));
  const teamNames = Object.keys(extracted.teams || {});
  if (!teamNames.length) {
    LOG.warn('Nenhuma seleção identificada nos documentos enviados.');
  }
  for (const team of teamNames) {
    console.log(`\n${team}:`);
    console.log(JSON.stringify(extracted.teams[team], null, 2));
  }

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] Nada foi salvo. Rode sem --dry-run para gravar no arquivo.');
    return;
  }

  fs.writeFileSync(CONTEXT_PATH, JSON.stringify(merged, null, 2));
  LOG.ok(`Salvo em ${CONTEXT_PATH}`);
  console.log('\nPróximo passo: confira o arquivo e dê commit/push antes da próxima rodada da pipeline.\n');
}

run().catch(err => {
  LOG.error('Erro fatal:', err.message);
  process.exit(1);
});
