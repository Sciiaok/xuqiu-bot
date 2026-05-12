/**
 * Knowledge Base File Parsers
 *
 * Extracts text content from various file formats.
 * Used by the upload API route before passing to kb-upload.service.js.
 *
 * 重点：
 *   - Excel 文件统一走 extractExcelChunks，把每个 sheet 按行切片。即使是
 *     小文件也会切（小文件 = 1 chunk），上层走统一 chunked 抽取路径。
 *   - PDF / Word / MD / TXT 仍然返回单个字符串（buffer.toString / pdf-parse /
 *     mammoth），由 kb-upload.service.js 的 600K 字符 cap 兜底防御。
 */
import { read, utils } from 'xlsx';

const DEFAULT_ROWS_PER_CHUNK = 80;

// MIME → fileType（与 app/api/knowledge/upload/route.js 的 ALLOWED_TYPES 对应）。
// Reparse 时没有 MIME，按扩展名兜底推一个。
const EXT_TO_FILETYPE = {
  '.pdf':  'pdf_text',
  '.xlsx': 'xlsx_text',
  '.csv':  'csv',
  '.docx': 'docx',
  '.md':   'markdown',
  '.txt':  'txt',
};

export function inferFileTypeFromName(filename) {
  if (!filename) return 'txt';
  const lower = filename.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx < 0) return 'txt';
  return EXT_TO_FILETYPE[lower.slice(dotIdx)] || 'txt';
}

/**
 * 统一的"buffer + fileType → processDocument 入参"转换。
 * Excel 走 chunked，其它格式走整串文本，由 kb-upload.service.js 的 600K 字符 cap 兜底。
 */
export async function parseBufferToContent(buffer, fileType) {
  if (fileType === 'xlsx_text') {
    return extractExcelChunks(buffer);
  }
  if (fileType === 'pdf_text') {
    return extractPdfText(buffer);
  }
  if (fileType === 'docx') {
    return extractDocxText(buffer);
  }
  // txt / markdown / csv / unknown → utf-8 文本
  return buffer.toString('utf-8');
}

/**
 * 把 xlsx buffer 切成 chunks。每个 chunk 自带 header 上下文。
 *
 * 设计权衡：
 *   - LLM 输出 32K token 大约能写 150 行结构化产品/路线。chunk 80 行留一倍余量。
 *   - 每片重复 header 行让 LLM 知道列含义（不然第 2 片以后看不懂列名）。
 *   - 同时附 "Sheet X, rows N..M of TOTAL" 元信息，避免 LLM 把局部当全文。
 *
 * @returns {Array<{label:string, content:string, sheet:string, row_start:number, row_end:number, total_rows:number}>}
 *   row_start / row_end 是 **Excel 1-based 行号**（含 header 行 = 1）。
 *   总返回数 ≥ 1（空文件返回 1 个空 chunk，让上层照常 N=1 走单次路径）。
 */
export async function extractExcelChunks(buffer, { rowsPerChunk = DEFAULT_ROWS_PER_CHUNK } = {}) {
  const workbook = read(buffer, { type: 'buffer' });
  const out = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    // 用 array-of-arrays 切片，最后再 join 成 CSV。比 sheet_to_csv 全文切割
    // 更稳：保留空字符串、不会丢空列。
    const aoa = utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    if (!aoa.length) continue;

    const header = aoa[0];
    const dataRows = aoa.slice(1);
    const totalDataRows = dataRows.length;

    // 1 个 chunk 兜底：即使没有 data row，也产出 header-only chunk
    if (totalDataRows === 0) {
      out.push({
        label: `${sheetName}#header-only`,
        sheet: sheetName,
        row_start: 1, row_end: 1, total_rows: 1,
        content: formatChunkBody({ sheetName, header, dataRows: [], rowStart: 1, rowEnd: 1, totalRows: 1 }),
      });
      continue;
    }

    for (let i = 0; i < totalDataRows; i += rowsPerChunk) {
      const slice = dataRows.slice(i, i + rowsPerChunk);
      const rowStart = i + 2; // header=1, first data=2
      const rowEnd = rowStart + slice.length - 1;
      out.push({
        label: `${sheetName}#${rowStart}-${rowEnd}`,
        sheet: sheetName,
        row_start: rowStart,
        row_end: rowEnd,
        total_rows: totalDataRows + 1, // including header
        content: formatChunkBody({
          sheetName, header, dataRows: slice,
          rowStart, rowEnd, totalRows: totalDataRows + 1,
        }),
      });
    }
  }

  // 整个 workbook 没有任何 sheet 时返回一个空 chunk —— 上游不会崩
  if (!out.length) {
    out.push({
      label: 'empty-workbook',
      sheet: '', row_start: 0, row_end: 0, total_rows: 0,
      content: '(empty workbook)',
    });
  }
  return out;
}

function formatChunkBody({ sheetName, header, dataRows, rowStart, rowEnd, totalRows }) {
  const headerCsv = csvRow(header);
  const bodyCsv = dataRows.map(csvRow).join('\n');
  return [
    `=== Sheet: ${sheetName} (rows ${rowStart}-${rowEnd} of ${totalRows}) ===`,
    `Header: ${headerCsv}`,
    '',
    'Data rows:',
    bodyCsv,
  ].join('\n');
}

function csvRow(cells) {
  return cells.map(c => {
    const s = c == null ? '' : String(c);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }).join(',');
}

/**
 * Extract text from PDF buffer.
 * Uses pdf-parse if available, otherwise returns a placeholder
 * indicating the file needs manual text input or OCR.
 */
export async function extractPdfText(buffer) {
  try {
    // Dynamic import — pdf-parse is an optional dependency
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch {
    // pdf-parse not installed — fall back to base64 for Vision API
    // For now, return a message; in production, use Vision API
    return `[PDF file — ${buffer.length} bytes. Install pdf-parse for text extraction, or upload as text/markdown instead.]`;
  }
}

/**
 * Extract text from Word (.docx) buffer.
 * Uses mammoth if available, otherwise falls back to raw XML extraction.
 */
export async function extractDocxText(buffer) {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  } catch {
    // mammoth not installed — basic fallback
    return `[DOCX file — ${buffer.length} bytes. Install mammoth for text extraction, or upload as text/markdown instead.]`;
  }
}
