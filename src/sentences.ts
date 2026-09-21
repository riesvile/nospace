/** Conservative prose sentence boundaries; a period needs a following space. */
export function startsSentence(before: string): boolean {
  const preceding = before.replace(/[\s"'‘’“”()[\]{}]+$/gu, '');
  if (!preceding) return true;
  if (/[!?]$/.test(preceding)) return true;
  if (!preceding.endsWith('.') || !/\s/u.test(before.slice(preceding.length))) return false;
  // Titles, common abbreviations and initials do not end a sentence by themselves.
  if (/\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e)\.$/i.test(preceding)) return false;
  if (/(?:\b\p{L}\.)+$/u.test(preceding)) return false;
  return true;
}
