import type { TextUpdate } from './types.js';

/** English prose typography; technical spans keep their literal punctuation. */
export function typographyEdits(text: string): TextUpdate[] {
  const protectedCharacters = new Uint8Array(text.length);
  const protect = (start: number, end: number) => protectedCharacters.fill(1, start, end);
  for (const match of text.matchAll(/`+/g)) {
    if (protectedCharacters[match.index]) continue;
    const end = text.indexOf(match[0], match.index + match[0].length);
    protect(match.index, end < 0 ? text.length : end + match[0].length);
  }
  for (const match of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"“”]+|[\p{L}\p{N}][\p{L}\p{N}._%+'‘’+-]*@[^\s<>"“”]*/giu)) {
    let end = match.index + match[0].length;
    if (/['‘]/.test(text[match.index - 1] ?? '') && /['’]/.test(text[end - 1])) end--;
    protect(match.index, end);
  }

  const edits: TextUpdate[] = [];
  let doubleOpen = false;
  let singleOpen = false;
  const word = (char: string) => /[\p{L}\p{M}\p{N}]/u.test(char);
  const replace = (start: number, original: string, replacement: string) => {
    if (original !== replacement) edits.push({ start, original, replacement });
  };
  for (let i = 0; i < text.length; i++) {
    if (protectedCharacters[i]) continue;
    const char = text[i];
    const before = text[i - 1] ?? '';
    const after = text[i + 1] ?? '';
    if (char === '\n') { doubleOpen = false; singleOpen = false; }
    if (char === '.' && text.slice(i, i + 3) === '...' && text[i - 1] !== '.' && text[i + 3] !== '.') {
      replace(i, '...', '…');
      i += 2;
    } else if (/['‘’]/.test(char)) {
      // Keep numeric measurement marks literal; don't turn 5'10" into quotes.
      if (/\d/.test(before) && (after === '' || /[\d\s.,;:!?]/.test(after))) continue;
      const elision = /^(?:\d{2}s\b|(?:tis|twas|twere|em|cause|til|round|bout)\b)/i.test(text.slice(i + 1));
      if (elision || (word(before) && word(after))) replace(i, char, '’');
      else {
        const opening: boolean = !singleOpen && (!before || /[\s([{—–,:;=“‘]/.test(before));
        replace(i, char, opening ? '‘' : '’');
        singleOpen = opening;
      }
    } else if (/["“”]/.test(char)) {
      if (/\d/.test(before) && (!doubleOpen || /\d['′]\d+$/.test(text.slice(0, i)))) continue;
      const opening: boolean = !doubleOpen && (!before || /[\s([{—–,:;=‘“]/.test(before));
      replace(i, char, opening ? '“' : '”');
      doubleOpen = opening;
    }
  }
  return edits;
}
