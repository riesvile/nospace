import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNoSpace, type NoSpaceOptions, type NoSpaceSession } from '../src/engine.js';
import { HttpError } from '../src/http.js';
import type { AnalysisResult, EditorState, NoSpaceProvider, TextUpdate } from '../src/types.js';

const empty: AnalysisResult = { boundaries: [], typos: [], durationMs: 0 };
const sessions: NoSpaceSession[] = [];
afterEach(() => { sessions.splice(0).forEach((s) => s.destroy()); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function harness(provider: NoSpaceProvider, options: Partial<NoSpaceOptions> = {}) {
  vi.useFakeTimers();
  let state: EditorState = { text: '', selectionStart: 0, selectionEnd: 0 };
  let editable = true;
  const changes = vi.fn((next: EditorState) => { state = next; });
  const errors = vi.fn();
  const session = createNoSpace({ capitalize: false, ...options, provider, onError: errors,
    editor: { getState: () => state, setState: changes, isEditable: () => editable } });
  sessions.push(session);
  return { session, changes, errors, get state() { return state; },
    type(text: string) { state = { text, selectionStart: text.length, selectionEnd: text.length }; session.input(); },
    external(text: string) { state = { text, selectionStart: text.length, selectionEnd: text.length }; },
    readonly() { editable = false; }
  };
}
const analyze = async () => empty;
const flagged = async () => ({ decision: 'needs_update' as const, probability: 0.99 });

describe('library typography', () => {
  it('formats punctuation in the user edit, preserves caret and undoes as one change', () => {
    const h = harness({ analyze }); h.type('"What\'s new"...');
    expect(h.state.text).toBe('“What’s new”…');
    expect(h.state.selectionStart).toBe(h.state.text.length);
    expect(h.changes).toHaveBeenLastCalledWith(expect.anything(), 'typography');
    h.session.undo(); expect(h.state.text).toBe('');
    h.session.redo(); expect(h.state.text).toBe('“What’s new”…');
  });
  it('can preserve literal punctuation independently of capitalization', () => {
    const h = harness({ analyze }, { typography: false, capitalize: true }); h.type('"what\'s new"...');
    expect(h.state.text).toBe('"What\'s new"...');
  });
  it('formats word corrections in the same undo step', async () => {
    const h = harness({ analyze: async (input) => ({ ...empty, typos: input.words.filter((w) => w.word === 'Whats').map((w) => ({ key: w.key, probability: 0.1, apostropheProbability: 0.95 })) }),
      correct: async () => "What's" });
    h.type('Whats new'); await vi.advanceTimersByTimeAsync(0);
    expect(h.state.text).toBe('What’s new');
    h.session.undo(); expect(h.state.text).toBe('Whats new');
  });
});

describe('library review scheduling', () => {
  it('keeps legacy custom providers working without sending sentence metadata', async () => {
    const analyze = vi.fn(async () => empty); const h = harness({ analyze });
    h.type('A perfectly ordinary sentence.'); await vi.advanceTimersByTimeAsync(2000);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze.mock.calls.every(([input]) => !('sentence' in (input as object)))).toBe(true);
  });
  it('repairs a flagged sentence only after a pause', async () => {
    const correctSentence = vi.fn(async () => 'This is cool as hell');
    const h = harness({ analyze: async (input) => ({ ...empty, ...(input.paused ? { sentencePlausibility: 0.05 } : {}) }), correctSentence });
    h.type('This is cool a shell'); await vi.advanceTimersByTimeAsync(699);
    expect(correctSentence).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.text).toBe('This is cool as hell');
    expect(h.changes).toHaveBeenLastCalledWith(expect.anything(), 'sentence-correction');
    h.session.undo(); expect(h.state.text).toBe('This is cool a shell');
    await vi.advanceTimersByTimeAsync(4000); expect(correctSentence).toHaveBeenCalledTimes(1);
  });
  it('supports opting out of sentence and document reviews', async () => {
    const correctSentence = vi.fn(); const reviewDocument = vi.fn(); const correctDocument = vi.fn();
    const h = harness({ analyze: async () => ({ ...empty, sentencePlausibility: 0 }), correctSentence, reviewDocument, correctDocument }, { sentenceReview: false, documentReview: false });
    h.type('This is cool a shell.'); await vi.advanceTimersByTimeAsync(5000);
    expect(correctSentence).not.toHaveBeenCalled(); expect(reviewDocument).not.toHaveBeenCalled(); expect(correctDocument).not.toHaveBeenCalled();
  });
  it('discards sentence repairs after resumed typing even if abort is ignored', async () => {
    const job = deferred<string | null>();
    const correctSentence = vi.fn(() => job.promise);
    const h = harness({ analyze: async () => ({ ...empty, sentencePlausibility: 0 }), correctSentence });
    h.type('This is cool a shell'); await vi.advanceTimersByTimeAsync(700);
    const signal = correctSentence.mock.calls[0][1] as AbortSignal;
    h.type('This is cool a shell collection');
    expect(signal.aborted).toBe(true);
    job.resolve('This is cool as hell'); await vi.advanceTimersByTimeAsync(0);
    expect(h.state.text).toBe('This is cool a shell collection');
  });
  it('uses the lower typo referral threshold only for completed words', async () => {
    const correct = vi.fn(async () => 'the');
    const h = harness({ analyze: async (input) => ({ ...empty, typos: input.words.filter((w) => w.word === 'teh').map((w) => ({ key: w.key, probability: 0.7 })) }), correct });
    h.type('teh'); await vi.advanceTimersByTimeAsync(700); expect(correct).not.toHaveBeenCalled();
    h.type('teh cat'); await vi.advanceTimersByTimeAsync(0);
    expect(correct).toHaveBeenCalledTimes(1); expect(h.state.text).toBe('the cat');
  });
  it('applies a document batch with typography as one undo and rechecks the repaired text', async () => {
    const reviewDocument = vi.fn().mockResolvedValueOnce({ decision: 'needs_update', probability: 0.99 }).mockResolvedValue({ decision: 'ok', probability: 0.05 });
    const correctDocument = vi.fn(async () => [{ start: 0, original: 'teh', replacement: 'the' }, { start: 12, original: 'its', replacement: "it's" }]);
    const h = harness({ analyze, reviewDocument, correctDocument }); h.type('teh cat and its toy.');
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.state.text).toBe('the cat and it’s toy.');
    expect(h.state.selectionStart).toBe(h.state.text.length);
    expect(reviewDocument).toHaveBeenCalledTimes(2);
    expect(correctDocument).toHaveBeenCalledTimes(1);
    h.session.undo(); expect(h.state.text).toBe('teh cat and its toy.');
    await vi.advanceTimersByTimeAsync(5000); expect(reviewDocument).toHaveBeenCalledTimes(2);
  });
  it('shares a three-call budget across successful document passes', async () => {
    const correctDocument = vi.fn(async (input) => [{ start: 0, original: input.text.slice(0, 3), replacement: input.text.startsWith('teh') ? 'the' : 'teh' }]);
    const h = harness({ analyze, reviewDocument: flagged, correctDocument }); h.type('teh cat drinks milk.');
    await vi.advanceTimersByTimeAsync(5000);
    expect(correctDocument).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000); expect(correctDocument).toHaveBeenCalledTimes(3);
  });
  it('resumes a throttled correction without rechecking an already-reviewed section', async () => {
    const reviewDocument = vi.fn(flagged);
    const correctDocument = vi.fn().mockRejectedValueOnce(new HttpError('Wait', 429, 10000)).mockResolvedValue([]);
    const h = harness({ analyze, reviewDocument, correctDocument }); h.type('teh cat drinks milk.');
    await vi.advanceTimersByTimeAsync(1000);
    expect(correctDocument).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9800); expect(correctDocument).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(correctDocument).toHaveBeenCalledTimes(2); expect(reviewDocument).toHaveBeenCalledTimes(1);
  });
  it('discards stale full-text repairs and reviews the new draft after appending', async () => {
    const job = deferred<TextUpdate[]>();
    const correctDocument = vi.fn().mockImplementationOnce(() => job.promise).mockResolvedValue([]);
    const h = harness({ analyze, reviewDocument: flagged, correctDocument }); h.type('teh cat drinks milk.');
    await vi.advanceTimersByTimeAsync(1000);
    const signal = correctDocument.mock.calls[0][1] as AbortSignal;
    h.type('teh cat drinks milk. More'); expect(signal.aborted).toBe(true);
    job.resolve([{ start: 0, original: 'teh', replacement: 'the' }]); await vi.advanceTimersByTimeAsync(0);
    expect(h.state.text).toBe('teh cat drinks milk. More');
    await vi.advanceTimersByTimeAsync(1200); expect(correctDocument).toHaveBeenCalledTimes(2);
  });
  it.each(['reset', 'destroy', 'composition', 'external', 'readonly'])('does not apply document results after %s', async (action) => {
    const job = deferred<TextUpdate[]>(); const correctDocument = vi.fn(() => job.promise);
    const h = harness({ analyze, reviewDocument: flagged, correctDocument }); h.type('teh cat drinks milk.');
    await vi.advanceTimersByTimeAsync(1000);
    if (action === 'reset') { h.external('Another document'); h.session.reset(); }
    if (action === 'destroy') h.session.destroy();
    if (action === 'composition') h.session.compositionStart();
    if (action === 'external') h.external('Externally changed');
    if (action === 'readonly') h.readonly();
    const text = h.state.text; const calls = h.changes.mock.calls.length;
    job.resolve([{ start: 0, original: 'teh', replacement: 'the' }]); await vi.advanceTimersByTimeAsync(2000);
    expect(h.state.text).toBe(text); expect(h.changes).toHaveBeenCalledTimes(calls);
  });
  it('keeps spacing responsive during a correction cooldown and retries the word later', async () => {
    const correct = vi.fn().mockRejectedValueOnce(new HttpError('Wait', 429, 10000)).mockResolvedValue('the');
    const analyze = vi.fn(async (input) => ({ ...empty, typos: input.words.filter((w) => w.word === 'teh').map((w) => ({ key: w.key, probability: 1 })) }));
    const h = harness({ analyze, correct }); h.type('teh cat'); await vi.advanceTimersByTimeAsync(0);
    h.type('teh cat runs'); await vi.advanceTimersByTimeAsync(2000);
    expect(analyze.mock.calls.length).toBeGreaterThan(1); expect(correct).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8500);
    expect(correct).toHaveBeenCalledTimes(2); expect(h.state.text).toBe('the cat runs');
  });
});
