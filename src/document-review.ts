import { startsSentence } from './sentences.js';
import type { DocumentDecision, SentenceInput, TextUpdate } from './types.js';

export const REVIEW_CHUNK_SIZE = 1200;
export interface ReviewBudget { remaining: number }

export function completedSentence(previous: string, next: string): boolean {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = next.length;
  let oldEnd = previous.length;
  while (end > start && oldEnd > start && next[end - 1] === previous[oldEnd - 1]) { end--; oldEnd--; }
  for (let i = start; i < end; i++) {
    if (next[i] === '\n' && /\p{L}/u.test(next.slice(0, i))) return true;
    if (next[i] === '…' && /\p{L}/u.test(next.slice(0, i))) return true;
    if (/[.!?]/.test(next[i]) && !/\d/.test(next[i + 1] ?? '') && startsSentence(next.slice(0, i + 1) + ' ')) return true;
  }
  return false;
}

export function reviewChunks(text: string): (SentenceInput & { start: number })[] {
  const chunks: (SentenceInput & { start: number })[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + REVIEW_CHUNK_SIZE);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end - 1);
      if (boundary > start + REVIEW_CHUNK_SIZE / 2) end = boundary + 1;
      // Never split an emoji's UTF-16 surrogate pair.
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    chunks.push({ start, text: text.slice(start, end), before: text.slice(Math.max(0, start - 160), start), after: text.slice(end, end + 160) });
    start = end;
  }
  return chunks;
}

/** All sections are checked. Only confident flags spend a Luna request. */
export async function reviewWholeText(
  text: string,
  check: (input: SentenceInput) => Promise<DocumentDecision>,
  correct: (input: SentenceInput) => Promise<TextUpdate[]>,
  signal: AbortSignal,
  progress = { checked: new Map<number, DocumentDecision>(), fixes: new Map<number, TextUpdate[]>() },
  budget: ReviewBudget = { remaining: Math.max(0, 3 - progress.fixes.size) }
): Promise<{ decision: DocumentDecision['decision']; updates: TextUpdate[] }> {
  const updates: TextUpdate[] = [];
  let needsUpdate = false;
  for (const chunk of reviewChunks(text)) {
    signal.throwIfAborted();
    if (!chunk.text.trim()) continue;
    const input = { text: chunk.text, before: chunk.before, after: chunk.after };
    let result = progress.checked.get(chunk.start);
    if (!result) {
      result = await check(input);
      signal.throwIfAborted();
      progress.checked.set(chunk.start, result);
    }
    if (result.decision !== 'needs_update' || result.probability < 0.8) continue;
    needsUpdate = true;
    // Share the cap across sections and follow-up passes, while still checking
    // the entire document. Reserve before the request, including aborted calls.
    if (!progress.fixes.has(chunk.start) && budget.remaining <= 0) continue;
    if (!progress.fixes.has(chunk.start)) {
      budget.remaining--;
      try {
        const repairs = await correct(input);
        signal.throwIfAborted();
        progress.fixes.set(chunk.start, repairs);
      } catch (error) {
        // A throttled request never reached Luna; allow it to resume later.
        if (error instanceof Error && 'status' in error && error.status === 429) budget.remaining++;
        throw error;
      }
    }
    for (const update of progress.fixes.get(chunk.start) ?? []) {
      updates.push({ ...update, start: chunk.start + update.start });
    }
  }
  signal.throwIfAborted();
  return { decision: needsUpdate ? 'needs_update' : 'ok', updates };
}
