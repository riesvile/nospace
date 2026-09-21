import type { AnalysisResult, NoSpaceProvider } from './types.js';

export class HttpError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'HttpError'; }
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

/** Browser transport. This never receives or reads Jev/OpenAI API keys. */
export function createHttpProvider(options: HttpProviderOptions): NoSpaceProvider {
  async function post(url: string, input: unknown, signal: AbortSignal) {
    const headers = new Headers(typeof options.headers === 'function' ? options.headers() : options.headers);
    headers.set('Content-Type', 'application/json');
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: 'POST', headers, body: JSON.stringify(input), signal,
      credentials: options.credentials ?? 'same-origin'
    });
    if (!response.ok) throw new HttpError(`nospace request failed (HTTP ${response.status}).`, response.status);
    try { return await response.json(); }
    catch { throw new HttpError('nospace returned invalid JSON.', 502); }
  }
  return {
    async analyze(input, signal): Promise<AnalysisResult> {
      const result = await post(options.analyzeUrl, input, signal);
      const probability = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
      if (!result || !Array.isArray(result.boundaries) || !Array.isArray(result.typos) ||
          result.boundaries.some((b: AnalysisResult['boundaries'][number]) => !b || !Number.isSafeInteger(b.id) || !probability(b.probability)) ||
          result.typos.some((t: AnalysisResult['typos'][number]) => !t || typeof t.key !== 'string' || !probability(t.probability) ||
            (t.apostropheProbability !== undefined && !probability(t.apostropheProbability)))) {
        throw new HttpError('nospace returned invalid analysis.', 502);
      }
      return result;
    },
    ...(options.correctUrl ? { async correct(input, signal) {
      const result = await post(options.correctUrl!, input, signal);
      if (!result || !(result.correction === null || typeof result.correction === 'string')) throw new HttpError('nospace returned invalid correction.', 502);
      return result.correction as string | null;
    } } satisfies Pick<NoSpaceProvider, 'correct'> : {})
  };
}
