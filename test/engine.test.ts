import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNoSpace, type NoSpaceSession } from '../src/engine.js';
import type { AnalysisInput, AnalysisResult, EditorState, NoSpaceProvider } from '../src/types.js';

const empty: AnalysisResult = { boundaries: [], typos: [], durationMs: 1 };
const sessions: NoSpaceSession[] = [];
afterEach(() => { sessions.splice(0).forEach((session) => session.destroy()); vi.useRealTimers(); });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function harness(provider?: NoSpaceProvider, capitalize = false) {
  vi.useFakeTimers();
  let state: EditorState = { text: '', selectionStart: 0, selectionEnd: 0 };
  const pending: { input: AnalysisInput; signal: AbortSignal; resolve: (result: AnalysisResult) => void }[] = [];
  const onError = vi.fn();
  const setState = vi.fn((next: EditorState) => { state = next; });
  const session = createNoSpace({ capitalize, onError, editor: { getState: () => state, setState },
    provider: provider ?? { analyze: (input, signal) => new Promise((resolve) => pending.push({ input, signal, resolve })) } });
  sessions.push(session);
  return { session, pending, onError, setState, get state() { return state; },
    type(text: string) { state = { text, selectionStart: text.length, selectionEnd: text.length }; session.input(); },
    external(text: string) { state = { text, selectionStart: text.length, selectionEnd: text.length }; },
    space(index: number, after: string) {
      const job = pending[index];
      const boundary = job.input.boundaries.find((b) => b.left === after)!;
      job.resolve({ ...empty, boundaries: [{ id: boundary.id, probability: 0.99 }] });
    }
  };
}

describe('headless lifecycle', () => {
  it('preserves typing and the caret when an earlier spacing result arrives', async () => {
    const h = harness();
    h.type('hellow'); h.type('helloworld');
    h.space(0, 'hello'); await tick();
    expect(h.state.text).toBe('hello world');
    expect(h.state.selectionStart).toBe(11);
  });

  it('aborts pending work after a manual replacement and ignores a provider that ignores abort', async () => {
    const h = harness(); h.type('helloworld'); h.type('goodbye');
    expect(h.pending[0].signal.aborted).toBe(true);
    h.space(0, 'hello'); await tick();
    expect(h.state.text).toBe('goodbye');
  });

  it('never overwrites external host state that has not been synchronized', async () => {
    const h = harness(); h.type('helloworld'); h.external('another document');
    h.space(0, 'hello'); await tick();
    expect(h.state.text).toBe('another document');
    expect(h.setState).not.toHaveBeenCalled();
  });

  it('keeps IME intermediate text untouched and analyzes a commit once', async () => {
    const h = harness(undefined, true);
    h.session.compositionStart(); h.type('hello');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.pending).toHaveLength(0);
    expect(h.state.text).toBe('hello');
    h.session.compositionEnd(); h.session.input();
    expect(h.pending).toHaveLength(1);
    expect(h.state.text).toBe('Hello');
  });

  it('undo cancels follow-up work and remains until a new user edit', async () => {
    const h = harness(); h.type('helloworld'); h.space(0, 'hello'); await tick();
    expect(h.session.undo()).toBe(true);
    expect(h.state.text).toBe('helloworld');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.pending).toHaveLength(1);
    expect(h.session.redo()).toBe(true);
    expect(h.state.text).toBe('hello world');
  });

  it('reset adopts a new document and clears history even with old work in flight', async () => {
    const h = harness(); h.type('helloworld'); h.external('new text'); h.session.reset();
    h.space(0, 'hello'); await tick();
    expect(h.state.text).toBe('new text');
    expect(h.session.undo()).toBe(false);
    expect(h.session.text).toBe('new text');
  });

  it('destroy aborts, clears timers and prevents later callbacks', async () => {
    const h = harness(); h.type('helloworld'); h.session.destroy();
    expect(h.pending[0].signal.aborted).toBe(true);
    h.space(0, 'hello'); await vi.advanceTimersByTimeAsync(5000);
    expect(h.setState).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.pending).toHaveLength(1);
  });

  it('caps live spacing requests while typing continues', () => {
    const h = harness();
    for (let i = 2; i <= 20; i++) h.type('a'.repeat(i));
    expect(h.pending.filter((p) => !p.signal.aborted)).toHaveLength(12);
  });

  it('calls an optional corrector only after a confident typo decision', async () => {
    const correct = vi.fn().mockResolvedValue('the');
    const provider: NoSpaceProvider = { correct, analyze: vi.fn(async (input) => ({ ...empty,
      typos: input.words.map((w) => ({ key: w.key, probability: 0.99 })) })) };
    const h = harness(provider); h.type('teh cat'); await tick();
    expect(correct).toHaveBeenCalledTimes(1);
    expect(h.state.text).toBe('the cat');
    expect(h.state.selectionStart).toBe(7);
  });

  it('reports a failure without affecting text and retries transient failures once', async () => {
    const analyze = vi.fn().mockRejectedValue(Object.assign(new Error('Busy'), { status: 503 }));
    const h = harness({ analyze }); h.type('hello'); await tick();
    // flush the pause check too; each new input/pause attempt gets one retry.
    await vi.advanceTimersByTimeAsync(10000);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(h.onError).toHaveBeenCalledWith(expect.any(Error), 'analyze');
    expect(h.state.text).toBe('hello');
  });
});
