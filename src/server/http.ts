import type { AnalysisInput, CorrectionInput, NoSpaceProvider, SentenceInput } from '../types.js';
import { ProviderError } from './providers.js';
import type { ModelRoute } from './limits.js';

export interface RequestHandlerOptions {
  /** Additional exact origins when the browser and backend have different hosts.
   * Set CORS response headers in the host application as needed. */
  allowedOrigins?: readonly string[];
  /** Reserve a quota slot after validation, before a provider call. Return a
   * release callback for concurrency leases. Throw RateLimitError on rejection.
   * The host must derive identity from its authenticated user/trusted connection. */
  reserve?(operation: ModelRoute, request: Request): void | (() => void) | Promise<void | (() => void)>;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
});

async function readBody(request: Request, options: RequestHandlerOptions): Promise<unknown> {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin && !options.allowedOrigins?.includes(origin)) {
    throw new ProviderError('Cross-origin requests are not allowed.', 403);
  }
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ProviderError('Expected JSON.', 415);
  }
  const limit = 24000;
  if (Number(request.headers.get('content-length')) > limit) throw new ProviderError('Request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ProviderError('Expected a request body.', 400);
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new ProviderError('Request is too large.', 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text); }
  catch { throw new ProviderError('Invalid JSON.', 400); }
}

function isAnalysis(input: unknown): input is AnalysisInput {
  return record(input) && string(input.raw, 64) && string(input.contextBefore, 400) && string(input.contextAfter, 200) &&
    typeof input.paused === 'boolean' && (input.sentence === undefined || (input.paused && isSentence(input.sentence, 160, 80))) && Array.isArray(input.boundaries) && input.boundaries.length <= 63 &&
    input.boundaries.every((b: unknown) => record(b) && Number.isSafeInteger(b.id) && string(b.left, 64) && string(b.right, 64) && b.left + b.right === input.raw && (b.space === undefined || typeof b.space === 'boolean')) &&
    Array.isArray(input.words) && input.words.length <= 6 && input.words.every((w: unknown) => record(w) &&
      string(w.key, 600) && string(w.word, 48) && string(w.before, 160) && string(w.after, 100) && typeof w.terminal === 'boolean');
}

function isSentence(input: unknown, length: number, context: number): input is SentenceInput {
  return record(input) && string(input.text, length) && !!input.text.trim() && string(input.before, context) && string(input.after, context);
}

function isCorrection(input: unknown): input is CorrectionInput {
  return record(input) && string(input.word, 48) && /^[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*$/u.test(input.word) &&
    string(input.before, 160) && string(input.after, 100);
}

/** Standard Request -> Response handlers; mount behind your app's authentication. */
export function createRequestHandlers(provider: NoSpaceProvider, options: RequestHandlerOptions = {}) {
  async function run<T>(kind: ModelRoute, request: Request, work: () => Promise<T>): Promise<T> {
    const release = await options.reserve?.(kind, request);
    try { return await work(); }
    finally { if (typeof release === 'function') release(); }
  }
  const wrap = (handle: (input: unknown, request: Request) => Promise<unknown>) => async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    try { return json(await handle(await readBody(request, options), request)); }
    catch (error) {
      const known = error instanceof ProviderError;
      const delay = known && error.status === 429 ? Math.max(1, Math.ceil((error.retryAfterMs ?? 2000) / 1000)) : undefined;
      return json({ error: known ? error.message : 'The request could not be completed.', ...(delay ? { retryAfter: delay } : {}) },
        known ? error.status : 500, delay ? { 'Retry-After': String(delay) } : {});
    }
  };
  return {
    analyze: wrap(async (input, request) => {
      if (record(input) && input.mode === 'document') {
        if (!isSentence(input.document, 1200, 160)) throw new ProviderError('Invalid document review.', 400);
        if (!provider.reviewDocument) throw new ProviderError('Document review is not configured.', 503);
        return run('review', request, () => provider.reviewDocument!(input.document as SentenceInput, request.signal));
      }
      if ((record(input) && input.mode !== undefined) || !isAnalysis(input)) throw new ProviderError('Invalid analysis request.', 400);
      return run('analyze', request, () => provider.analyze(input, request.signal));
    }),
    correct: wrap(async (input, request) => {
      if (record(input) && input.mode === 'document') {
        if (!isSentence(input.document, 1200, 160)) throw new ProviderError('Invalid document correction.', 400);
        if (!provider.correctDocument) throw new ProviderError('Document correction is not configured.', 503);
        const updates = await run('correct', request, () => provider.correctDocument!(input.document as SentenceInput, request.signal));
        return { updates, update: updates[0] ?? null };
      }
      if (record(input) && input.mode === 'sentence') {
        if (!isSentence(input.sentence, 160, 80)) throw new ProviderError('Invalid sentence correction.', 400);
        if (!provider.correctSentence) throw new ProviderError('Sentence correction is not configured.', 503);
        return { correction: await run('correct', request, () => provider.correctSentence!(input.sentence as SentenceInput, request.signal)) };
      }
      if ((record(input) && input.mode !== undefined) || !isCorrection(input)) throw new ProviderError('Invalid correction request.', 400);
      if (!provider.correct) throw new ProviderError('Correction is not configured.', 503);
      return { correction: await run('correct', request, () => provider.correct!(input, request.signal)) };
    })
  };
}
