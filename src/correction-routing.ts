import type { AnalysisResult, WordCandidate } from './types.js';

export function needsCorrection(word: WordCandidate, decision: AnalysisResult['typos'][number]): boolean {
  // This only refers a word to Luna for validation; it does not apply an edit.
  // Keep a higher threshold for the final word, which may still be incomplete.
  const threshold = word.terminal ? 0.85 : 0.65;
  return decision.probability >= threshold || (decision.apostropheProbability ?? 0) >= 0.8;
}
