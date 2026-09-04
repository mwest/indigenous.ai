// DOCX extraction (spec §30): paragraphs, headings, lists and table rows in
// document order, with paragraph ordinals and table row locators. mammoth
// reads the OOXML content only — no macro execution, no pixel-perfect
// rendering; the goal is reliable retrieval and provenance.
import mammoth from 'mammoth';

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const strip = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

export async function extractDocx(filePath) {
  const { value: html } = await mammoth.convertToHtml({ path: filePath });

  const blocks = [];
  let paragraph = 0;
  let tableIndex = 0;
  // mammoth emits simple, well-formed HTML: h1..h6, p, ol/ul>li, table>tr>td.
  const top = html.match(/<(h[1-6]|p|li|table)[^>]*>[\s\S]*?<\/\1>|<(h[1-6]|p|li)[^>]*\/>/gi) ?? [];
  for (const chunk of top) {
    const tag = chunk.match(/^<(\w+)/)[1].toLowerCase();
    if (tag === 'table') {
      tableIndex++;
      const rows = chunk.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
      rows.forEach((rowHtml, ri) => {
        const cells = (rowHtml.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(strip);
        const text = cells.filter(Boolean).join(' | ');
        if (text) {
          blocks.push({
            blockType: 'table_row',
            text,
            rowNumber: ri + 1,
            location: { table: tableIndex, row: ri + 1 },
            metadata: { cells },
          });
        }
      });
    } else {
      const text = strip(chunk);
      if (!text) continue;
      paragraph++;
      blocks.push({
        blockType: tag.startsWith('h') ? 'heading' : tag === 'li' ? 'list_item' : 'paragraph',
        text,
        location: {
          paragraph,
          ...(tag.startsWith('h') ? { heading_level: Number(tag[1]) } : {}),
        },
      });
    }
  }
  return {
    metadata: { format: 'docx', paragraph_count: paragraph, table_count: tableIndex },
    blocks,
  };
}
