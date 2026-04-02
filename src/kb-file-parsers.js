/**
 * Knowledge Base File Parsers
 *
 * Extracts text content from various file formats.
 * Used by the upload API route before passing to kb-upload.service.js.
 */
import { read, utils } from 'xlsx';

/**
 * Extract text from Excel (.xlsx) buffer.
 * Converts each sheet to CSV-like text for LLM processing.
 */
export async function extractExcelText(buffer) {
  const workbook = read(buffer, { type: 'buffer' });
  const sheets = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) {
      sheets.push(`=== Sheet: ${sheetName} ===\n${csv}`);
    }
  }

  return sheets.join('\n\n');
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
