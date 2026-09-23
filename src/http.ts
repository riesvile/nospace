import { retryDelay } from './retry.js';
import type { AnalysisResult, NoSpaceProvider, SentenceInput, TextUpdate } from './types.js';

export class HttpError extends Error {
  constructor(message: string, public status: number, public retryAfterMs?: number) { super(message); this.name = 'HttpError'; }
}

export interface HttpProviderOptions {
  analyzeUrl: string;
  /** Omit for spacing-only operation. URLs point to YOUR application server. */
  correctUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Application authentication headers only; never provider API keys. */
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

const probability = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Browser transport. This never receives or reads Jev/OpenAI API keys. */
export function createHttpProvider(options: HttpProviderOptions): NoSpaceProvider {
  async function post(url: string, input: unknown, signal: AbortSignal) {
    const headers = new Headers(typeof options.headers === 'function' ? options.headers() : options.headers);
    headers.set('Content-Type', 'application/json');
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: 'POST', headers, body: JSON.stringify(input), signal,
      credentials: options.credentials ?? 'same-origin'
    });
    // Reverse proxies may throttle with HTML rather than JSON.
    if (!response.ok) throw new HttpError(`nospace request failed (HTTP ${response.status}).`, response.status,
      response.status === 429 ? retryDelay(response.headers.get('retry-after')) : undefined);
    try { return await response.json(); }
    catch { throw new HttpError('nospace returned invalid JSON.', 502); }
  }
  const correction = (result: unknown): string | null => {
    if (!result || typeof result !== 'object' || !('correction' in result) ||
        !(result.correction === null || typeof result.correction === 'string')) throw new HttpError('nospace returned invalid correction.', 502);
    return result.correction;
  };
  return {
    async analyze(input, signal): Promise<AnalysisResult> {
      const result = await post(options.analyzeUrl, input, signal);
      if (!result || !Array.isArray(result.boundaries) || !Array.isArray(result.typos) ||
          result.boundaries.some((b: AnalysisResult['boundaries'][number]) => !b || !Number.isSafeInteger(b.id) || !probability(b.probability)) ||
          result.typos.some((t: AnalysisResult['typos'][number]) => !t || typeof t.key !== 'string' || !probability(t.probability) ||
            (t.apostropheProbability !== undefined && !probability(t.apostropheProbability))) ||
          (result.sentencePlausibility !== undefined && !probability(result.sentencePlausibility))) {
        throw new HttpError('nospace returned invalid analysis.', 502);
      }
      return result;
    },
    ...(options.correctUrl ? {
      async correct(input, signal) { return correction(await post(options.correctUrl!, input, signal)); },
      async correctSentence(input, signal) { return correction(await post(options.correctUrl!, { mode: 'sentence', sentence: input }, signal)); },
      async reviewDocument(input, signal) {
        const result = await post(options.analyzeUrl, { mode: 'document', document: input }, signal);
        if (!result || !['ok', 'needs_update'].includes(result.decision) || !probability(result.probability)) {
          throw new HttpError('nospace returned invalid document review.', 502);
        }
        return result;
      },
      async correctDocument(input, signal) {
        const result = await post(options.correctUrl!, { mode: 'document', document: input }, signal);
        // Accept the original demo's single-edit envelope as well as batches.
        const updates = result?.updates ?? (result?.update ? [result.update] : result?.update === null ? [] : undefined);
        if (!validUpdates(updates, input)) throw new HttpError('nospace returned invalid document corrections.', 502);
        return updates;
      }
    } satisfies Pick<NoSpaceProvider, 'correct' | 'correctSentence' | 'reviewDocument' | 'correctDocument'> : {})
  };
}

function validUpdates(updates: unknown, input: SentenceInput): updates is TextUpdate[] {
  if (!Array.isArray(updates) || updates.length > 6) return false;
  let end = 0;
  for (const edit of [...updates].sort((a, b) => (a?.start ?? 0) - (b?.start ?? 0))) {
    if (!edit || !Number.isSafeInteger(edit.start) || edit.start < end || typeof edit.original !== 'string' || !edit.original ||
        edit.original.length > 160 || typeof edit.replacement !== 'string' || !edit.replacement || edit.replacement.length > 180 ||
        input.text.slice(edit.start, edit.start + edit.original.length) !== edit.original) return false;
    end = edit.start + edit.original.length;
  }
  return true;
}
