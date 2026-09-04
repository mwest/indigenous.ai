// Extractor interface (spec §28): one adapter per format, all returning
// { metadata, blocks } where each block carries its best source locator
// (page / sheet+row / paragraph ordinal / line range). Extraction only reads
// content — no macros, no embedded scripts, no external fetches.
import { extractPdf } from './pdf.js';
import { extractDocx } from './docx.js';
import { extractXlsx } from './xlsx.js';
import { extractCsv } from './csv.js';
import { extractText } from './text.js';

// Guard rails against pathological files (spec §29/§38).
export const LIMITS = {
  maxPages: 2000,
  maxBlocks: 50000,
  maxSheetRows: 100000,
  maxCellsPerRow: 256,
  maxTextBytes: 20 * 1024 * 1024, // decoded text cap for csv/txt
};

const BY_KIND = { pdf: extractPdf, docx: extractDocx, xlsx: extractXlsx, csv: extractCsv, txt: extractText };

/** Run the format adapter. kind comes from the validated extension. */
export async function extractDocument({ filePath, kind }) {
  const fn = BY_KIND[kind];
  if (!fn) throw new Error(`No extractor for format: ${kind}`);
  const result = await fn(filePath, LIMITS);
  if (result.blocks.length > LIMITS.maxBlocks) {
    result.blocks = result.blocks.slice(0, LIMITS.maxBlocks);
    result.metadata.truncated = true;
  }
  // Normalize ordinals; drop empty-text blocks (nothing to index or show).
  result.blocks = result.blocks
    .filter((b) => b.text && b.text.trim())
    .map((b, i) => ({ ...b, ordinal: i + 1 }));
  result.metadata.block_count = result.blocks.length;
  return result;
}
