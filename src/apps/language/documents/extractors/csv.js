// CSV extraction (spec §32): each data row becomes a sheet_row block with the
// row number and header-keyed cell values — the structure later drives the
// explicit map-to-Entries workflow. Uploading a CSV as a Document preserves
// and indexes it; it never auto-imports.
import fs from 'node:fs/promises';
import { parseCsv } from '../../csv.js';

export async function extractCsv(filePath, LIMITS) {
  const buf = await fs.readFile(filePath);
  if (buf.length > LIMITS.maxTextBytes) throw new Error('CSV file too large to extract');
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (rows.length > LIMITS.maxSheetRows) throw new Error(`CSV has too many rows (max ${LIMITS.maxSheetRows})`);

  // Header detection: the first row is treated as the header when every cell
  // is short non-numeric text; otherwise columns get positional names.
  const first = rows[0] ?? [];
  const looksLikeHeader = first.length > 0 &&
    first.every((c) => c.trim() && c.trim().length <= 64 && !/^-?[\d.,]+$/.test(c.trim()));
  const headers = looksLikeHeader
    ? first.map((c, i) => c.trim() || `Column ${i + 1}`)
    : first.map((_, i) => `Column ${i + 1}`);
  const dataRows = looksLikeHeader ? rows.slice(1) : rows;

  const blocks = dataRows.map((r, i) => {
    const cells = {};
    r.slice(0, LIMITS.maxCellsPerRow).forEach((v, ci) => { cells[headers[ci] ?? `Column ${ci + 1}`] = v; });
    return {
      blockType: 'sheet_row',
      text: r.filter((v) => String(v).trim()).join(' | '),
      rowNumber: i + (looksLikeHeader ? 2 : 1), // 1-based, counting the header row
      metadata: { cells },
    };
  });
  return {
    metadata: { format: 'csv', row_count: dataRows.length, headers, has_header_row: looksLikeHeader },
    blocks,
  };
}
