export interface Boundary {
  id: number;
  left: string;
  right: string;
  space?: boolean;
}

export interface WordCandidate {
  key: string;
  word: string;
  before: string;
  after: string;
  terminal: boolean;
}

export interface AnalysisInput {
  contextBefore: string;
  raw: string;
  contextAfter: string;
  boundaries: Boundary[];
  words: WordCandidate[];
  paused: boolean;
  sentence?: SentenceInput;
}

export interface AnalysisResult {
  boundaries: { id: number; probability: number }[];
  typos: { key: string; probability: number; apostropheProbability?: number }[];
  durationMs: number;
  sentencePlausibility?: number;
}

export interface SentenceInput {
  text: string;
  before: string;
  after: string;
}

export interface CorrectionInput {
  word: string;
  before: string;
  after: string;
}

export interface DocumentDecision {
  decision: 'needs_update' | 'ok';
  probability: number;
}

export interface TextUpdate { start: number; original: string; replacement: string }

/** Implement these functions locally or forward them to your own backend. */
export interface NoSpaceProvider {
  analyze(input: AnalysisInput, signal: AbortSignal): Promise<AnalysisResult>;
  correct?(input: CorrectionInput, signal: AbortSignal): Promise<string | null>;
  correctSentence?(input: SentenceInput, signal: AbortSignal): Promise<string | null>;
  reviewDocument?(input: SentenceInput, signal: AbortSignal): Promise<DocumentDecision>;
  correctDocument?(input: SentenceInput, signal: AbortSignal): Promise<TextUpdate[]>;
}

/** Offsets use UTF-16, matching native text controls and JavaScript strings. */
export interface EditorState {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection?: 'forward' | 'backward' | 'none';
}

export type ChangeReason = 'spacing' | 'correction' | 'capitalization' | 'typography' | 'sentence-correction' | 'document-correction' | 'undo' | 'redo';

/** Apply state synchronously, including updating the host framework's state. */
export interface EditorAdapter {
  getState(): EditorState;
  setState(state: EditorState, reason: ChangeReason): void;
  isEditable?(): boolean;
}
