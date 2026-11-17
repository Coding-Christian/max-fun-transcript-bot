// Keep the readable text on disk; normalize only when matching queries.
export async function extractPDFText(pdf) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(pdf), isEvalSupported: false, useSystemFonts: true });
  try {
    const document = await task.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.filter(item => typeof item.str === 'string')
        .map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim());
      page.cleanup();
    }
    const text = pages.join('\n\n').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new Error('The PDF has no extractable text.');
    return text + '\n';
  } finally {
    await task.destroy();
  }
}

// Map normalized characters back to the original so excerpts preserve spelling.
function normalizedText(text, withOffsets = false) {
  let value = '';
  const offsets = [];
  for (let index = 0; index < text.length;) {
    const originalIndex = index;
    const character = String.fromCodePoint(text.codePointAt(index));
    index += character.length;
    // PDF line wrapping sometimes splits a word with a hyphen and a newline.
    const wrap = character === '-' && /^\s*\n\s*(?=\p{L})/u.exec(text.slice(index));
    if (wrap && /\p{L}/u.test(text[originalIndex - 1] || '')) {
      index += wrap[0].length;
      continue;
    }
    const folded = character.normalize('NFKD').toLowerCase()
      .replace(/[\p{M}\p{Cf}'’‘ʼ]/gu, '').replace(/ß/g, 'ss').replace(/&/g, ' and ');
    for (const part of folded) {
      const next = /[\p{L}\p{N}]/u.test(part) ? part : ' ';
      if (next === ' ' && (!value || value.endsWith(' '))) continue;
      value += next;
      if (withOffsets) {
        for (let unit = 0; unit < next.length; unit++) offsets.push(originalIndex);
      }
    }
  }
  return { value: value.trimEnd(), offsets };
}

export function normalizeSearchText(text) {
  return normalizedText(text).value;
}

export function matchingExcerpt(text, normalizedQuery) {
  const { value, offsets } = normalizedText(text, true);
  const match = value.indexOf(normalizedQuery);
  if (match < 0) return null;
  const first = offsets[match];
  const last = offsets[match + normalizedQuery.length - 1] + 1;
  const start = Math.max(0, first - 150);
  const end = Math.min(text.length, last + 250);
  return `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}
