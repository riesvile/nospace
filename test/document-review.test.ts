import { describe, expect, it, vi } from 'vitest';
import { completedSentence, reviewChunks, reviewWholeText, REVIEW_CHUNK_SIZE } from '../src/document-review.js';
import { WritingDocument } from '../src/document.js';
import type { DocumentDecision, TextUpdate } from '../src/types.js';

describe('sentence completion', () => {
  it.each([
    ['Hello there', 'Hello there.', true],
    ['Hello there', 'Hello there!', true],
    ['Hello there', 'Hello there?"', true],
    ['Hello there', 'Hello there\n', true],
    ['Hello there.', 'Hello there. More', false],
    ['Dr', 'Dr.', false],
    ['It costs 314', 'It costs 3.14', false],
    ['', 'One sentence. Another sentence.', true]
  ])('detects a new ending in %s → %s', (previous, next, expected) => {
    expect(completedSentence(previous, next)).toBe(expected);
  });
});

describe('whole-text review', () => {
  it('covers every character in a long draft with bounded contextual sections', () => {
    const text = ('One long paragraph with useful context. 🙂 ').repeat(130);
    const chunks = reviewChunks(text);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(REVIEW_CHUNK_SIZE);
      expect(text.slice(chunk.start, chunk.start + chunk.text.length)).toBe(chunk.text);
      expect(chunk.before.length).toBeLessThanOrEqual(160);
      expect(chunk.after.length).toBeLessThanOrEqual(160);
      expect(/[\uD800-\uDBFF]$/.test(chunk.text)).toBe(false);
    }
  });

  it('repairs an earlier sentence while preserving newer text and supports undo', async () => {
    const doc = new WritingDocument();
    const text = 'This is cool a shell. ' + 'The cat drinks milk. '.repeat(15);
    doc.edit(text);
    const bookmark = doc.documentSnapshot();
    const caret = doc.anchor(doc.text.length);
    const check = vi.fn(async () => ({ decision: 'needs_update' as const, probability: 0.96 }));
    const correct = vi.fn(async () => [{ start: 8, original: 'cool a shell', replacement: 'cool as hell' }]);
    const result = await reviewWholeText(text, check, correct, new AbortController().signal);
    expect(check.mock.calls.length).toBe(1);
    expect(doc.correctDocument(bookmark, result.updates)).toBe(true);
    expect(doc.text).toBe(text.replace('cool a shell', 'cool as hell'));
    expect(doc.resolve(caret)).toBe(doc.text.length);
    doc.undo();
    expect(doc.text).toBe(text);
  });

  it('never calls Luna for an OK or uncertain result', async () => {
    const correct = vi.fn();
    for (const decision of ['ok', 'needs_update'] as const) {
      await reviewWholeText('A perfectly ordinary sentence.', async () => ({ decision, probability: 0.6 }), correct, new AbortController().signal);
    }
    expect(correct).not.toHaveBeenCalled();
  });

  it('collects several fixes per flagged section in one Luna request', async () => {
    const prefix = 'A perfectly ordinary sentence. '.repeat(41);
    const text = prefix + 'its kindadoingoiay. Inter stingidea idonothateit!';
    const check = vi.fn(async (input) => ({
      decision: input.text.includes('kindadoingoiay') ? 'needs_update' as const : 'ok' as const, probability: 0.99
    }));
    const correct = vi.fn(async (input) => [
      { original: 'its kindadoingoiay', replacement: "it's kinda doing okay" },
      { original: 'Inter stingidea', replacement: 'Interesting idea' },
      { original: 'idonothateit', replacement: 'I do not hate it' }
    ].map((edit) => ({ ...edit, start: input.text.indexOf(edit.original) })));
    const result = await reviewWholeText(text, check, correct, new AbortController().signal);
    expect(correct).toHaveBeenCalledTimes(1);
    expect(result.updates).toHaveLength(3);
    const doc = new WritingDocument();
    doc.edit(text);
    expect(doc.correctDocument(doc.documentSnapshot(), result.updates)).toBe(true);
    expect(doc.text).toBe(prefix + "it's kinda doing okay. Interesting idea I do not hate it!");
    doc.undo();
    expect(doc.text).toBe(text);
  });

  it('discards all returned repairs if the user edits while Luna is working', async () => {
    const controller = new AbortController();
    await expect(reviewWholeText('its kindadoingoiay.', async () => ({ decision: 'needs_update', probability: 1 }), async () => {
      controller.abort();
      return [{ start: 0, original: 'its kindadoingoiay', replacement: "it's kinda doing okay" }];
    }, controller.signal)).rejects.toThrow();
  });

  it('caps Luna attempts while still checking every section', async () => {
    const text = 'Another sentence with a possible typo. '.repeat(180);
    const check = vi.fn(async () => ({ decision: 'needs_update' as const, probability: 0.98 }));
    const correct = vi.fn(async () => []);
    await reviewWholeText(text, check, correct, new AbortController().signal);
    expect(check).toHaveBeenCalledTimes(reviewChunks(text).length);
    expect(correct).toHaveBeenCalledTimes(3);
  });

  it('rechecks repaired text and shares a three-request cap across follow-up passes', async () => {
    const budget = { remaining: 3 };
    const correct = vi.fn(async (input) => [{ start: 0, original: input.text, replacement: input.text + ' ' }]);
    const check = vi.fn(async () => ({ decision: 'needs_update' as const, probability: 1 }));
    const signal = new AbortController().signal;
    for (let pass = 0; pass < 5; pass++) {
      await reviewWholeText('A draft.' + ' '.repeat(pass), check, correct, signal, undefined, budget);
    }
    expect(check).toHaveBeenCalledTimes(5);
    expect(correct).toHaveBeenCalledTimes(3);
    expect(budget.remaining).toBe(0);
  });

  it('preserves the shared budget across a quota pause without rechecking the section', async () => {
    const budget = { remaining: 1 };
    const progress = { checked: new Map<number, DocumentDecision>(), fixes: new Map<number, TextUpdate[]>() };
    const check = vi.fn(async () => ({ decision: 'needs_update' as const, probability: 1 }));
    const correct = vi.fn().mockRejectedValueOnce(Object.assign(new Error('429'), { status: 429 }))
      .mockResolvedValueOnce([{ start: 0, original: 'Teh', replacement: 'The' }]);
    const signal = new AbortController().signal;
    await expect(reviewWholeText('Teh cat.', check, correct, signal, progress, budget)).rejects.toThrow('429');
    expect(budget.remaining).toBe(1);
    const result = await reviewWholeText('Teh cat.', check, correct, signal, progress, budget);
    expect(result.updates).toHaveLength(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(budget.remaining).toBe(0);
  });

  it('applies multiple separated repairs as one undo without disturbing the middle caret', () => {
    const doc = new WritingDocument();
    doc.edit('Teh cat sleeps. I am typing here. This is cool a shell.');
    const bookmark = doc.documentSnapshot();
    const caret = doc.anchor(doc.text.indexOf('typing') + 3);
    expect(doc.correctDocument(bookmark, [
      { start: 0, original: 'Teh', replacement: 'The' },
      { start: doc.text.indexOf('cool a shell'), original: 'cool a shell', replacement: 'cool as hell' }
    ])).toBe(true);
    expect(doc.text).toBe('The cat sleeps. I am typing here. This is cool as hell.');
    expect(doc.resolve(caret)).toBe(doc.text.indexOf('typing') + 3);
    doc.undo();
    expect(doc.text).toBe(bookmark.text);
  });

  it('aborts before correction when typing invalidates an in-flight check', async () => {
    const controller = new AbortController();
    const correct = vi.fn();
    await expect(reviewWholeText('This is cool a shell.', async () => {
      controller.abort();
      return { decision: 'needs_update', probability: 0.99 };
    }, correct, controller.signal)).rejects.toThrow();
    expect(correct).not.toHaveBeenCalled();
  });

  it.each(['append', 'manual edit', 'undo'])('rejects returned document edits after %s', (change) => {
    const doc = new WritingDocument();
    doc.edit('This is cool a shell.');
    const bookmark = doc.documentSnapshot();
    if (change === 'append') doc.edit(doc.text + ' More typing');
    if (change === 'manual edit') doc.edit('This is cool as hell.');
    if (change === 'undo') { doc.undo(); doc.redo(); }
    const current = doc.text;
    expect(doc.correctDocument(bookmark, [{ start: 8, original: 'cool a shell', replacement: 'cool as hell' }])).toBe(false);
    expect(doc.text).toBe(current);
  });

  it('resumes a throttled long review without paying to recheck completed sections', async () => {
    const text = 'An ordinary sentence. '.repeat(180);
    const progress = { checked: new Map<number, DocumentDecision>(), fixes: new Map<number, TextUpdate[]>() };
    const check = vi.fn().mockResolvedValue({ decision: 'ok', probability: 0.05 });
    check.mockResolvedValueOnce({ decision: 'ok', probability: 0.05 }).mockRejectedValueOnce(new Error('429'));
    const correct = vi.fn();
    await expect(reviewWholeText(text, check, correct, new AbortController().signal, progress)).rejects.toThrow('429');
    const completed = progress.checked.size;
    await reviewWholeText(text, check, correct, new AbortController().signal, progress);
    expect(completed).toBe(1);
    expect(check).toHaveBeenCalledTimes(reviewChunks(text).length + 1);
    expect(correct).not.toHaveBeenCalled();
  });
});
