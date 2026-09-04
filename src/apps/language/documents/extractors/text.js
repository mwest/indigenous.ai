// TXT extraction (spec §32): UTF-8 text split into paragraph blocks with
// line-range locators. Obviously binary input is rejected by the upload
// signature check before it reaches here.
import fs from 'node:fs/promises';

export async function extractText(filePath, LIMITS) {
  const buf = await fs.readFile(filePath);
  if (buf.length > LIMITS.maxTextBytes) throw new Error('Text file too large to extract');
  const text = buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  const blocks = [];
  let line = 1;
  for (const para of text.split(/\n{2,}/)) {
    const lines = para.split('\n').length;
    const trimmed = para.trim();
    if (trimmed) {
      blocks.push({
        blockType: 'paragraph',
        text: trimmed,
        location: { line_start: line, line_end: line + lines - 1 },
      });
    }
    line += lines + 1; // the blank separator line
  }
  return { metadata: { format: 'txt', paragraph_count: blocks.length }, blocks };
}
