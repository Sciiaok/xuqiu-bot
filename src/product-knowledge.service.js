import OpenAI from 'openai';
import { config } from './config.js';
import supabase from '../lib/supabase.js';

// Use OpenRouter if available (same OpenAI-compatible API), fallback to OpenAI direct
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || config.openai.apiKey,
  baseURL: process.env.OPENROUTER_API_KEY
    ? (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api') + '/v1'
    : undefined,
  timeout: 60000,
});

/**
 * Parse a PDF file using opendataloader-pdf and store results.
 * @param {Buffer} pdfBuffer - Raw PDF file buffer
 * @param {string} documentId - product_documents record ID
 * @param {string} agentId - Agent ID
 * @param {string} productLine - Agent product_line (e.g. 'agri_machinery')
 */
export async function processPdfDocument(pdfBuffer, documentId, agentId, productLine) {
  try {
    // Update status to processing
    await supabase
      .from('product_documents')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', documentId);

    // Step 1: Parse PDF with opendataloader-pdf
    const { markdown, tables, pageCount } = await parsePdf(pdfBuffer);

    // Step 2: Normalize table fields with gpt-4o-mini
    const specs = [];
    for (const table of tables) {
      const normalized = await normalizeSpecFields(table.rawKeyValues, productLine);
      if (normalized && normalized.model) {
        specs.push(normalized);
      }
    }

    // Step 3: Store structured specs
    if (specs.length > 0) {
      const specRows = specs.map(spec => ({
        document_id: documentId,
        agent_id: agentId,
        model: spec.model || 'Unknown',
        brand: spec.brand || null,
        product_line: productLine,
        specs: spec,
      }));
      await supabase.from('product_specs').insert(specRows);
    }

    // Step 4: Generate chunks and embeddings
    const chunks = createChunks(markdown, specs);
    if (chunks.length > 0) {
      const embeddings = await generateEmbeddings(chunks.map(c => c.text));
      const embeddingRows = chunks.map((chunk, i) => ({
        document_id: documentId,
        agent_id: agentId,
        chunk_text: chunk.text,
        chunk_index: i,
        embedding: embeddings[i],
        metadata: chunk.metadata,
      }));
      await supabase.from('product_embeddings').insert(embeddingRows);
    }

    // Step 5: Update status to ready
    await supabase
      .from('product_documents')
      .update({
        status: 'ready',
        page_count: pageCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', documentId);

    return { specs_count: specs.length, chunks_count: chunks.length };
  } catch (error) {
    await supabase
      .from('product_documents')
      .update({
        status: 'error',
        error_message: error.message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', documentId);
    throw error;
  }
}

/**
 * Parse PDF buffer with @opendataloader/pdf.
 * Requires Java 11+ on system PATH.
 * Returns markdown text and extracted tables as key-value pairs.
 */
async function parsePdf(pdfBuffer) {
  const { writeFile, readFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { convert } = await import('@opendataloader/pdf');

  // Write PDF to temp file (convert() requires file path)
  const tempDir = await mkdtemp(join(tmpdir(), 'product-pdf-'));
  const inputPath = join(tempDir, 'input.pdf');
  const outputDir = join(tempDir, 'output');

  try {
    await writeFile(inputPath, pdfBuffer);

    // Parse with both markdown and JSON output
    await convert([inputPath], {
      outputDir,
      format: 'json,markdown',
    });

    // Find output files (named after the PDF, not "input")
    const { readdirSync } = await import('node:fs');
    const outputFiles = readdirSync(outputDir);
    const mdFile = outputFiles.find(f => f.endsWith('.md'));
    const jsonFile = outputFiles.find(f => f.endsWith('.json'));

    // Read markdown output
    let markdown = '';
    if (mdFile) {
      try {
        markdown = await readFile(join(outputDir, mdFile), 'utf-8');
      } catch { /* no markdown output */ }
    }

    // Read JSON output and extract tables
    let tables = [];
    let pageCount = 1;
    if (jsonFile) {
      try {
        const jsonContent = JSON.parse(await readFile(join(outputDir, jsonFile), 'utf-8'));
        pageCount = jsonContent['number of pages'] || 1;
        tables = extractTablesFromJson(jsonContent);
      } catch { /* no JSON output */ }
    }

    return { markdown, tables, pageCount };
  } finally {
    // Clean up temp files
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Extract key-value pairs from opendataloader JSON table structure.
 * JSON structure: { kids: [ { type: "table", rows: [ { cells: [...] } ] } ] }
 * Tables may be 2-col (key, value) or 3-col (category, sub-key, value).
 */
function extractTablesFromJson(jsonContent) {
  const tables = [];

  // Tables are in top-level kids array
  const tableElements = (jsonContent.kids || []).filter(el => el.type === 'table');

  for (const table of tableElements) {
    const rawKeyValues = {};
    const numCols = table['number of columns'] || 0;

    let lastCategory = '';
    for (const row of table.rows || []) {
      const cells = row.cells || [];
      if (cells.length < 2) continue;

      if (numCols >= 3) {
        // 3-column table: category | sub-key | value
        // Some rows have colspan merging cells, so cells.length may be 2 or 3
        if (cells.length >= 3) {
          const category = extractCellText(cells[0]) || lastCategory;
          if (extractCellText(cells[0])) lastCategory = category;
          const subKey = extractCellText(cells[1]);
          const value = extractCellText(cells[2]);
          const key = (subKey && subKey !== category)
            ? `${category} ${subKey}`
            : category;
          if (key && value) {
            rawKeyValues[key] = value;
          }
        } else if (cells.length === 2) {
          // Merged cell row (colspan): key | value
          const key = extractCellText(cells[0]) || lastCategory;
          const value = extractCellText(cells[1]);
          if (key && value) {
            rawKeyValues[key] = value;
          }
        }
      } else {
        // 2-column table: key | value
        const key = extractCellText(cells[0]);
        const value = extractCellText(cells[1]);
        if (key) {
          rawKeyValues[key] = value;
        }
      }
    }
    if (Object.keys(rawKeyValues).length > 0) {
      tables.push({ rawKeyValues });
    }
  }

  return tables;
}

/**
 * Extract plain text from a table cell's nested kids structure.
 */
function extractCellText(cell) {
  if (!cell) return '';
  if (typeof cell === 'string') return cell;

  const parts = [];
  for (const kid of cell.kids || []) {
    if (typeof kid === 'string') {
      parts.push(kid);
    } else if (kid.content) {
      parts.push(kid.content);
    } else if (kid.text) {
      parts.push(kid.text);
    } else if (kid.kids) {
      parts.push(extractCellText(kid));
    }
  }
  return parts.join(' ').trim();
}

/**
 * Normalize raw PDF-extracted key-value pairs into standardized JSON
 * using gpt-4o-mini.
 */
export async function normalizeSpecFields(rawKeyValues, productLine) {
  if (!rawKeyValues || Object.keys(rawKeyValues).length === 0) {
    return null;
  }

  const response = await openai.chat.completions.create({
    model: process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o-mini' : 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a product spec normalizer. Convert raw PDF-extracted key-value pairs into a clean JSON object.
Rules:
- snake_case field names in English
- Append unit suffix: _kw, _mm, _kg, _rpm, _l, _kmh
- Parse numeric values (remove ">", "≥", units text), keep as numbers
- Keep text values as strings
- Always include "model" field (product model number)
- Always include "brand" field if identifiable
- Product line: ${productLine}`,
      },
      {
        role: 'user',
        content: JSON.stringify(rawKeyValues),
      },
    ],
  });

  return JSON.parse(response.choices[0].message.content);
}

/**
 * Create text chunks from parsed PDF content.
 * For spec sheets: entire spec as one chunk with model prefix.
 * For longer documents: split by paragraphs/sections.
 */
export function createChunks(markdown, specs) {
  const chunks = [];

  // For each spec, create a dedicated chunk
  for (const spec of specs) {
    const model = spec.model || 'Unknown';
    const specLines = Object.entries(spec)
      .filter(([key]) => key !== 'model' && key !== 'brand')
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    chunks.push({
      text: `[${model}] Model: ${model}\nBrand: ${spec.brand || 'Unknown'}\n${specLines}`,
      metadata: { model, type: 'spec_sheet' },
    });
  }

  // For remaining markdown content, split into chunks (~500 tokens each)
  if (markdown) {
    const sections = splitMarkdownIntoChunks(markdown, 1500); // ~500 tokens ≈ 1500 chars
    for (const section of sections) {
      // Skip if this content is already covered by spec chunks
      if (section.trim().length < 50) continue;
      chunks.push({
        text: section,
        metadata: { type: 'document' },
      });
    }
  }

  return chunks;
}

/**
 * Split markdown text into chunks of roughly maxChars characters,
 * breaking at paragraph boundaries.
 */
function splitMarkdownIntoChunks(text, maxChars) {
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Generate embeddings for an array of text strings.
 * Uses OpenAI text-embedding-3-small (1536 dimensions).
 */
export async function generateEmbeddings(texts) {
  const response = await openai.embeddings.create({
    model: process.env.OPENROUTER_API_KEY ? 'openai/text-embedding-3-small' : 'text-embedding-3-small',
    input: texts,
  });

  return response.data.map(d => d.embedding);
}
