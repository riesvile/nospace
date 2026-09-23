import { WritingDocument, type Bookmark, type SentenceBookmark } from './document.js';
import { needsCorrection } from './correction-routing.js';
import { completedSentence, reviewWholeText } from './document-review.js';
import { boundedRetryDelay } from './retry.js';
import type { ChangeReason, DocumentDecision, EditorAdapter, NoSpaceProvider, TextUpdate } from './types.js';

type Operation = 'analyze' | 'correct' | 'review';
export interface NoSpaceOptions {
  editor: EditorAdapter;
  provider: NoSpaceProvider;
  capitalize?: boolean;
  /** English prose punctuation. Default true; disable for literal/code inputs. */
  typography?: boolean;
  /** Optional provider methods enable these reviews by default. */
  sentenceReview?: boolean;
  documentReview?: boolean;
  idleDelayMs?: number;
  /** null clears a previous error for this operation. */
  onError?(error: Error | null, operation: Operation): void;
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
  let analysisCooldown = 0;
  let correctionCooldown = 0;
  let documentCooldown = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let correctionTimer: ReturnType<typeof setTimeout> | undefined;
  let documentTimer: ReturnType<typeof setTimeout> | undefined;
  const analyses = new Set<AbortController>();
  const corrections = new Map<string, { controller: AbortController; bookmark: Bookmark }>();
  const attempted = new Set<string>();
  const reviewed = new Set<string>();
  let sentenceJob: { controller: AbortController; bookmark: SentenceBookmark } | undefined;
  let documentJob: AbortController | undefined;
  let documentPending = false;
  let documentBudget = { remaining: 3 };
  let reviewedDocument = '';
  let reviewProgress = { text: '', checked: new Map<number, DocumentDecision>(), fixes: new Map<number, TextUpdate[]>() };

  const editable = () => !disposed && !composing && (editor.isEditable?.() ?? true);
  const synchronized = () => editable() && editor.getState().text === doc.text;
  const capitalize = () => options.capitalize !== false && doc.capitalizeSentences();
  const sentenceEnabled = () => options.sentenceReview !== false && !!provider.correctSentence;
  const documentEnabled = () => options.documentReview !== false && !!provider.reviewDocument && !!provider.correctDocument;

  function paint(change: () => boolean, reason: ChangeReason, typography = true): boolean {
    if (!synchronized()) return false;
    const state = editor.getState();
    const start = doc.anchor(state.selectionStart);
    const end = doc.anchor(state.selectionEnd);
    const changed = change();
    const formatted = typography && options.typography !== false && doc.formatTypography(true);
    if (!changed && !formatted) return false;
    editor.setState({ ...state, text: doc.text, selectionStart: doc.resolve(start), selectionEnd: doc.resolve(end) }, changed ? reason : 'typography');
    return true;
  }

  function cancel() {
    documentJob?.abort(); documentJob = undefined; documentPending = false;
    sentenceJob?.controller.abort(); sentenceJob = undefined;
    for (const controller of analyses) controller.abort();
    for (const { controller } of corrections.values()) controller.abort();
    analyses.clear(); corrections.clear();
    clearTimeout(idleTimer); clearTimeout(settleTimer); clearTimeout(retryTimer);
    clearTimeout(correctionTimer); clearTimeout(documentTimer);
  }

  function settle(depth = 0) {
    if (depth >= 2 || !synchronized()) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => void analyze(Date.now() - lastInput >= idleDelay, depth + 1), 100);
  }

  function retryCorrection() {
    if (!synchronized()) return;
    clearTimeout(correctionTimer);
    correctionTimer = setTimeout(() => void analyze(true), Math.max(50, correctionCooldown - Date.now() + 50));
  }

  function report(error: unknown, operation: Operation | 'review-correct') {
    const problem = error instanceof Error ? error : new Error('The provider is unavailable.');
    if ('status' in problem && problem.status === 429) {
      const until = Date.now() + boundedRetryDelay('retryAfterMs' in problem ? problem.retryAfterMs : undefined);
      if (operation === 'analyze') analysisCooldown = Math.max(analysisCooldown, until);
      if (operation === 'correct' || operation === 'review-correct') correctionCooldown = Math.max(correctionCooldown, until);
      if (operation === 'review' || operation === 'review-correct') documentCooldown = Math.max(documentCooldown, until);
    }
    options.onError?.(problem, operation === 'review-correct' ? 'review' : operation);
    return problem;
  }

  async function correct(bookmark: Bookmark) {
    if (!provider.correct || !synchronized() || sentenceJob || documentJob) return;
    if (Date.now() < correctionCooldown) { retryCorrection(); return; }
    const key = `${bookmark.epoch}:${bookmark.key}`;
    const attempt = JSON.stringify([key, bookmark.before, bookmark.after]);
    if (!doc.isCurrent(bookmark) || attempted.has(attempt) || corrections.has(key) || corrections.size >= 3) return;
    attempted.add(attempt);
    if (attempted.size > 400) { attempted.clear(); attempted.add(attempt); }
    const controller = new AbortController();
    corrections.set(key, { controller, bookmark });
    let completed = false;
    try {
      const result = await provider.correct({ word: bookmark.word, before: bookmark.before, after: bookmark.after }, controller.signal);
      if (controller.signal.aborted || !synchronized() || !doc.isCurrent(bookmark)) return;
      completed = true;
      options.onError?.(null, 'correct');
      if (result && paint(() => {
        const changed = doc.correct(bookmark, result);
        const capitalized = capitalize();
        return changed || capitalized;
      }, 'correction')) settle();
    } catch (error) {
      if (!controller.signal.aborted && synchronized() && doc.isCurrent(bookmark)) {
        const problem = report(error, 'correct'); attempted.delete(attempt);
        if ('status' in problem && problem.status === 429) retryCorrection();
      }
    } finally {
      if (corrections.get(key)?.controller === controller) corrections.delete(key);
      if (completed && !controller.signal.aborted && synchronized() && !corrections.size && Date.now() - lastInput >= idleDelay) settle();
    }
  }

  async function reviewSentence(bookmark: SentenceBookmark) {
    if (!sentenceEnabled() || !synchronized() || !doc.isSentenceCurrent(bookmark) || sentenceJob || documentJob || corrections.size) return;
    if (Date.now() < correctionCooldown) { retryCorrection(); return; }
    const attempt = JSON.stringify([bookmark.before, bookmark.text, bookmark.after]);
    if (reviewed.has(attempt)) return;
    reviewed.add(attempt);
    if (reviewed.size > 100) { reviewed.clear(); reviewed.add(attempt); }
    const controller = new AbortController();
    sentenceJob = { controller, bookmark };
    try {
      const result = await provider.correctSentence!({ text: bookmark.text, before: bookmark.before, after: bookmark.after }, controller.signal);
      if (controller.signal.aborted || !synchronized() || !doc.isSentenceCurrent(bookmark)) return;
      options.onError?.(null, 'correct');
      if (result && paint(() => doc.correctSentence(bookmark, result), 'sentence-correction')) settle();
    } catch (error) {
      if (!controller.signal.aborted && synchronized() && doc.isSentenceCurrent(bookmark)) {
        const problem = report(error, 'correct'); reviewed.delete(attempt);
        if ('status' in problem && problem.status === 429) retryCorrection();
      }
    } finally {
      if (controller.signal.aborted) reviewed.delete(attempt);
      if (sentenceJob?.controller === controller) sentenceJob = undefined;
    }
  }

  function scheduleDocumentReview() {
    clearTimeout(documentTimer);
    if (!documentPending || !documentEnabled() || !synchronized()) return;
    documentTimer = setTimeout(() => void reviewDocument(), Math.max(200, Math.max(900, idleDelay) - (Date.now() - lastInput), documentCooldown - Date.now()));
  }

  async function reviewDocument() {
    if (!documentPending || !documentEnabled() || !synchronized() || documentJob) return;
    if (analyses.size || corrections.size || sentenceJob || Date.now() < documentCooldown) { scheduleDocumentReview(); return; }
    const bookmark = doc.documentSnapshot();
    if (!bookmark.text.trim() || bookmark.text === reviewedDocument) { documentPending = false; return; }
    if (reviewProgress.text !== bookmark.text) reviewProgress = { text: bookmark.text, checked: new Map(), fixes: new Map() };
    const controller = new AbortController();
    documentJob = controller; documentPending = false;
    try {
      const result = await reviewWholeText(bookmark.text,
        async (input) => {
          try { return await provider.reviewDocument!(input, controller.signal); }
          catch (error) {
            if (!controller.signal.aborted && synchronized()) report(error, 'review');
            throw error;
          }
        },
        async (input) => {
          if (Date.now() < correctionCooldown) {
            documentCooldown = Math.max(documentCooldown, correctionCooldown);
            throw Object.assign(new Error('Document corrections are paused briefly.'), { status: 429 });
          }
          try { return await provider.correctDocument!(input, controller.signal); }
          catch (error) {
            if (!controller.signal.aborted && synchronized()) report(error, 'review-correct');
            throw error;
          }
        }, controller.signal, reviewProgress, documentBudget);
      if (controller.signal.aborted || !synchronized()) return;
      if (!doc.isDocumentCurrent(bookmark)) { documentPending = true; return; }
      options.onError?.(null, 'review');
      if (result.updates.length && paint(() => doc.correctDocument(bookmark, result.updates), 'document-correction')) {
        settle();
        documentPending = documentBudget.remaining > 0;
      }
      reviewedDocument = documentPending ? '' : doc.text;
    } catch (error) {
      if (!controller.signal.aborted && synchronized() && error instanceof Error && 'status' in error && error.status === 429) documentPending = true;
    } finally {
      if (documentJob === controller) { documentJob = undefined; scheduleDocumentReview(); }
    }
  }

  async function analyze(paused = false, depth = 0, retry = false): Promise<void> {
    if (!synchronized() || !doc.text) return;
    if (Date.now() < analysisCooldown) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void analyze(true, 0, true), analysisCooldown - Date.now() + 50);
      return;
    }
    const snapshot = doc.snapshot(editor.getState().selectionStart, paused);
    if (!sentenceEnabled()) { snapshot.sentence = undefined; delete snapshot.input.sentence; }
    if (!snapshot.input.boundaries.length && !snapshot.words.length && !snapshot.sentence) return;
    if (analyses.size >= 12) {
      const oldest = analyses.values().next().value;
      oldest?.abort(); if (oldest) analyses.delete(oldest);
    }
    const controller = new AbortController(); analyses.add(controller);
    try {
      const result = await provider.analyze(snapshot.input, controller.signal);
      if (controller.signal.aborted || !synchronized() || snapshot.epoch !== doc.epoch) return;
      options.onError?.(null, 'analyze');
      if (paint(() => {
        const spaced = doc.applySpacing(snapshot, result.boundaries);
        const capitalized = capitalize();
        return spaced || capitalized;
      }, 'spacing')) settle(depth);
      if (snapshot.sentence && (result.sentencePlausibility ?? 1) <= 0.2) void reviewSentence(snapshot.sentence);
      for (const typo of result.typos) {
        const bookmark = snapshot.words.find((word) => word.key === typo.key);
        if (bookmark && needsCorrection(bookmark, typo)) void correct(bookmark);
      }
    } catch (error) {
      if (!controller.signal.aborted && synchronized() && snapshot.epoch === doc.epoch) {
        const problem = report(error, 'analyze');
        if (!retry && 'status' in problem && (problem.status === 429 || problem.status === 503)) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => void analyze(true, 0, true), Math.max(2100, analysisCooldown - Date.now() + 50));
        }
      }
    } finally { analyses.delete(controller); }
  }

  function input() {
    if (!editable()) return;
    const next = editor.getState().text;
    if (next === doc.text) return;
    const finished = completedSentence(doc.text, next);
    const needsReview = documentPending || !!documentJob || finished;
    if (finished) documentBudget = { remaining: 3 };
    documentJob?.abort(); documentJob = undefined; clearTimeout(documentTimer);
    const { appended } = doc.edit(next);
    sentenceJob?.controller.abort(); sentenceJob = undefined;
    if (!appended) cancel();
    paint(capitalize, 'capitalization');
    if (!doc.text) {
      options.onError?.(null, 'analyze'); options.onError?.(null, 'correct'); options.onError?.(null, 'review');
      reviewed.clear(); reviewedDocument = '';
      reviewProgress = { text: '', checked: new Map(), fixes: new Map() };
    }
    for (const [key, job] of corrections) {
      if (!doc.isCurrent(job.bookmark)) { job.controller.abort(); corrections.delete(key); }
    }
    lastInput = Date.now();
    clearTimeout(idleTimer); clearTimeout(settleTimer);
    void analyze();
    idleTimer = setTimeout(() => void analyze(true), idleDelay);
    documentPending = !!doc.text && needsReview && documentEnabled();
    scheduleDocumentReview();
  }

  function history(redo: boolean) {
    if (!synchronized()) return false;
    cancel();
    return paint(() => redo ? doc.redo() : doc.undo(), redo ? 'redo' : 'undo', false);
  }

  return {
    get text() { return doc.text; }, input,
    compositionStart() { if (!disposed) { composing = true; doc.epoch++; cancel(); } },
    compositionEnd() { if (!disposed) { composing = false; input(); } },
    undo: () => history(false), redo: () => history(true), flush: () => analyze(true),
    reset() {
      if (disposed) return;
      cancel(); attempted.clear(); reviewed.clear(); composing = false;
      analysisCooldown = 0; correctionCooldown = 0; documentCooldown = 0;
      reviewedDocument = ''; documentBudget = { remaining: 3 };
      reviewProgress = { text: '', checked: new Map(), fixes: new Map() };
      doc = new WritingDocument(editor.getState().text);
      options.onError?.(null, 'analyze'); options.onError?.(null, 'correct'); options.onError?.(null, 'review');
    },
    destroy() { disposed = true; cancel(); }
  };
}
