import { WritingDocument, type Bookmark } from './document.js';
import type { ChangeReason, EditorAdapter, NoSpaceProvider } from './types.js';

export interface NoSpaceOptions {
  editor: EditorAdapter;
  provider: NoSpaceProvider;
  capitalize?: boolean;
  idleDelayMs?: number;
  /** null clears a previous error for this operation. */
  onError?(error: Error | null, operation: 'analyze' | 'correct'): void;
}

export interface NoSpaceSession {
  readonly text: string;
  /** Call after the host has committed a user edit. */
  input(): void;
  compositionStart(): void;
  compositionEnd(): void;
  undo(): boolean;
  redo(): boolean;
  /** Analyze the current window as paused; dependent follow-ups remain async. */
  flush(): Promise<void>;
  /** Adopt host text as a new document, clearing history and pending work. */
  reset(): void;
  destroy(): void;
}

/** No DOM, framework, networking or provider credentials in the editing engine. */
export function createNoSpace(options: NoSpaceOptions): NoSpaceSession {
  const { editor, provider } = options;
  const idleDelay = options.idleDelayMs ?? 700;
  if (!Number.isFinite(idleDelay) || idleDelay < 0) throw new RangeError('idleDelayMs must be a nonnegative finite number.');
  let doc = new WritingDocument(editor.getState().text);
  let disposed = false;
  let composing = false;
  let lastInput = 0;
  let cooldown = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const analyses = new Set<AbortController>();
  const corrections = new Map<string, { controller: AbortController; bookmark: Bookmark }>();
  const attempted = new Set<string>();

  const editable = () => !disposed && !composing && (editor.isEditable?.() ?? true);
  const synchronized = () => editable() && editor.getState().text === doc.text;
  const capitalize = () => options.capitalize !== false && doc.capitalizeSentences();

  function paint(change: () => boolean, reason: ChangeReason): boolean {
    // Programmatic host changes must never be overwritten by an old result.
    if (!synchronized()) return false;
    const state = editor.getState();
    const start = doc.anchor(state.selectionStart);
    const end = doc.anchor(state.selectionEnd);
    if (!change()) return false;
    editor.setState({ ...state, text: doc.text, selectionStart: doc.resolve(start), selectionEnd: doc.resolve(end) }, reason);
    return true;
  }

  function cancel() {
    for (const controller of analyses) controller.abort();
    for (const { controller } of corrections.values()) controller.abort();
    analyses.clear();
    corrections.clear();
    clearTimeout(idleTimer);
    clearTimeout(settleTimer);
    clearTimeout(retryTimer);
  }

  function settle(depth = 0) {
    if (depth >= 2 || !synchronized()) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => void analyze(Date.now() - lastInput >= idleDelay, depth + 1), 100);
  }

  function report(error: unknown, operation: 'analyze' | 'correct') {
    const problem = error instanceof Error ? error : new Error('The provider is unavailable.');
    if ('status' in problem && problem.status === 429) cooldown = Date.now() + 2000;
    options.onError?.(problem, operation);
    return problem;
  }

  async function correct(bookmark: Bookmark) {
    if (!provider.correct || !synchronized()) return;
    const key = `${bookmark.epoch}:${bookmark.key}`;
    const attempt = JSON.stringify([key, bookmark.before, bookmark.after]);
    if (!doc.isCurrent(bookmark) || attempted.has(attempt) || corrections.has(key) || corrections.size >= 3) return;
    attempted.add(attempt);
    if (attempted.size > 400) { attempted.clear(); attempted.add(attempt); }
    const controller = new AbortController();
    corrections.set(key, { controller, bookmark });
    try {
      const result = await provider.correct({ word: bookmark.word, before: bookmark.before, after: bookmark.after }, controller.signal);
      if (controller.signal.aborted || !synchronized() || !doc.isCurrent(bookmark)) return;
      options.onError?.(null, 'correct');
      if (result && paint(() => {
        const changed = doc.correct(bookmark, result);
        const capitalized = capitalize();
        return changed || capitalized;
      }, 'correction')) settle();
    } catch (error) {
      if (!controller.signal.aborted && synchronized() && doc.isCurrent(bookmark)) {
        report(error, 'correct');
        attempted.delete(attempt);
      }
    } finally {
      // A canceled request can finish after a replacement request with this key.
      if (corrections.get(key)?.controller === controller) corrections.delete(key);
    }
  }

  async function analyze(paused = false, depth = 0, retry = false): Promise<void> {
    if (!synchronized() || !doc.text) return;
    if (Date.now() < cooldown) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void analyze(true, 0, true), cooldown - Date.now() + 50);
      return;
    }
    const snapshot = doc.snapshot(editor.getState().selectionStart, paused);
    if (!snapshot.input.boundaries.length && !snapshot.words.length) return;
    if (analyses.size >= 12) {
      const oldest = analyses.values().next().value;
      oldest?.abort();
      if (oldest) analyses.delete(oldest);
    }
    const controller = new AbortController();
    analyses.add(controller);
    try {
      const result = await provider.analyze(snapshot.input, controller.signal);
      if (controller.signal.aborted || !synchronized() || snapshot.epoch !== doc.epoch) return;
      options.onError?.(null, 'analyze');
      if (paint(() => {
        const spaced = doc.applySpacing(snapshot, result.boundaries);
        const capitalized = capitalize();
        return spaced || capitalized;
      }, 'spacing')) settle(depth);
      for (const typo of result.typos) {
        if (!(typo.probability >= 0.85 || (typo.apostropheProbability ?? 0) >= 0.8)) continue;
        const bookmark = snapshot.words.find((word) => word.key === typo.key);
        if (bookmark) void correct(bookmark);
      }
    } catch (error) {
      if (!controller.signal.aborted && synchronized() && snapshot.epoch === doc.epoch) {
        const problem = report(error, 'analyze');
        if (!retry && 'status' in problem && (problem.status === 429 || problem.status === 503)) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => void analyze(true, 0, true), 2100);
        }
      }
    } finally { analyses.delete(controller); }
  }

  function input() {
    if (!editable()) return;
    const next = editor.getState().text;
    if (next === doc.text) return;
    const { appended } = doc.edit(next);
    if (!appended) cancel();
    paint(capitalize, 'capitalization');
    if (!doc.text) { options.onError?.(null, 'analyze'); options.onError?.(null, 'correct'); }
    for (const [key, job] of corrections) {
      if (!doc.isCurrent(job.bookmark)) { job.controller.abort(); corrections.delete(key); }
    }
    lastInput = Date.now();
    clearTimeout(idleTimer);
    clearTimeout(settleTimer);
    void analyze();
    idleTimer = setTimeout(() => void analyze(true), idleDelay);
  }

  function history(redo: boolean) {
    if (!synchronized()) return false;
    cancel();
    // Undo is a manual choice; only a new user edit starts analysis again.
    return paint(() => redo ? doc.redo() : doc.undo(), redo ? 'redo' : 'undo');
  }

  return {
    get text() { return doc.text; },
    input,
    compositionStart() { if (!disposed) { composing = true; doc.epoch++; cancel(); } },
    compositionEnd() { if (!disposed) { composing = false; input(); } },
    undo: () => history(false),
    redo: () => history(true),
    flush: () => analyze(true),
    reset() {
      if (disposed) return;
      cancel();
      attempted.clear();
      composing = false;
      cooldown = 0;
      doc = new WritingDocument(editor.getState().text);
      options.onError?.(null, 'analyze');
      options.onError?.(null, 'correct');
    },
    destroy() { disposed = true; cancel(); }
  };
}
