// XLSX extraction (spec §31): Excel is not prose — preserve workbook
// structure. Each worksheet row becomes a sheet_row block carrying the sheet
// name, 1-based row number and header-keyed cell values. Formulas are never
// executed: exceljs only reads stored/cached values.
import ExcelJS from 'exceljs';

const cellText = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text) return String(v.text);          // hyperlinks
    if (v.result !== undefined) return String(v.result); // formula cached value
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v);
};

export async function extractXlsx(filePath, LIMITS) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const blocks = [];
  const sheets = [];
  let totalRows = 0;
  for (const ws of wb.worksheets) {
    const sheetName = ws.name;
    let headers = null;
    let sheetRows = 0;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (totalRows >= LIMITS.maxSheetRows) return;
      const values = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        if (col <= LIMITS.maxCellsPerRow) values[col - 1] = cellText(cell.value);
      });
      const nonEmpty = values.filter((v) => v && v.trim());
      if (!nonEmpty.length) return;
      if (!headers) {
        // First non-empty row: header when it is all short non-numeric text.
        const isHeader = nonEmpty.every((v) => v.trim().length <= 64 && !/^-?[\d.,]+$/.test(v.trim()));
        headers = values.map((v, i) => (isHeader && v?.trim()) || `Column ${i + 1}`);
        if (isHeader) return; // the header row itself is not a data block
      }
      const cells = {};
      values.forEach((v, i) => { if (v !== undefined) cells[headers[i] ?? `Column ${i + 1}`] = v; });
      blocks.push({
        blockType: 'sheet_row',
        text: nonEmpty.join(' | '),
        sheetName,
        rowNumber,
        metadata: { cells },
      });
      sheetRows++;
      totalRows++;
    });
    sheets.push({ name: sheetName, rows: sheetRows, headers: headers ?? [] });
  }
  return {
    metadata: { format: 'xlsx', sheet_count: wb.worksheets.length, sheets, row_count: totalRows },
    blocks,
  };
}
