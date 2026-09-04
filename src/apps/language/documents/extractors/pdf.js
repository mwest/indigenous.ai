// PDF extraction (spec §29): native text with page provenance, one page_text
// block per page. No OCR in v1 — a PDF with little/no extractable text stays
// stored and searchable-by-metadata, flagged requires_ocr for a future pass.
// Security: embedded JavaScript is never evaluated (isEvalSupported: false),
// no attachments or external programs are touched, and page count is capped.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

export async function extractPdf(filePath, LIMITS) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs wants its bundled standard fonts for text metrics; point it at the
  // package's own directory (local files only — nothing is fetched).
  const fontDir = path.join(path.dirname(require_.resolve('pdfjs-dist/package.json')), 'standard_fonts')
    .split(path.sep).join('/') + '/';
  const data = new Uint8Array(await fs.readFile(filePath));
  const loadingTask = getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    standardFontDataUrl: fontDir,
  });
  const doc = await loadingTask.promise;

  try {
    const pageCount = Math.min(doc.numPages, LIMITS.maxPages);
    const blocks = [];
    let textChars = 0;
    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // Join items, inserting newlines when the writer moved down the page.
      let text = '';
      let lastY = null;
      for (const item of content.items) {
        const y = item.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) text += '\n';
        else if (text && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
        text += item.str;
        if (y !== undefined) lastY = y;
      }
      text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      textChars += text.length;
      if (text) blocks.push({ blockType: 'page_text', text, pageNumber: p });
      page.cleanup();
    }
    return {
      metadata: {
        format: 'pdf',
        page_count: doc.numPages,
        pages_extracted: pageCount,
        requires_ocr: textChars < 20, // effectively no machine-readable text
      },
      blocks,
    };
  } finally {
    await loadingTask.destroy();
  }
}
