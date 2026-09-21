import type { AnalysisInput, CorrectionInput, NoSpaceProvider } from '../types.js';
import { ProviderError } from './providers.js';

export interface RequestHandlerOptions {
  /** Additional exact origins when the browser and backend have different hosts.
   * Set CORS response headers in the host application as needed. */
  allowedOrigins?: readonly string[];
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
    typeof input.paused === 'boolean' && Array.isArray(input.boundaries) && input.boundaries.length <= 63 &&
    input.boundaries.every((b: unknown) => record(b) && Number.isSafeInteger(b.id) && string(b.left, 64) && string(b.right, 64) && b.left + b.right === input.raw) &&
    Array.isArray(input.words) && input.words.length <= 6 && input.words.every((w: unknown) => record(w) &&
      string(w.key, 600) && string(w.word, 48) && string(w.before, 160) && string(w.after, 100) && typeof w.terminal === 'boolean');
}

function isCorrection(input: unknown): input is CorrectionInput {
  return record(input) && string(input.word, 48) && /^[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*$/u.test(input.word) &&
    string(input.before, 160) && string(input.after, 100);
}

/** Standard Request -> Response handlers; mount behind your app's auth/rate limits. */
export function createRequestHandlers(provider: NoSpaceProvider, options: RequestHandlerOptions = {}) {
  const wrap = (run: (input: unknown, signal: AbortSignal) => Promise<unknown>) => async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    try { return json(await run(await readBody(request, options), request.signal)); }
    catch (error) {
      return json({ error: error instanceof ProviderError ? error.message : 'The request could not be completed.' },
        error instanceof ProviderError ? error.status : 500);
    }
  };
  return {
    analyze: wrap(async (input, signal) => {
      if (!isAnalysis(input)) throw new ProviderError('Invalid analysis request.', 400);
      return provider.analyze(input, signal);
    }),
    correct: wrap(async (input, signal) => {
      if (!isCorrection(input)) throw new ProviderError('Invalid correction request.', 400);
      if (!provider.correct) throw new ProviderError('Correction is not configured.', 503);
      return { correction: await provider.correct(input, signal) };
    })
  };
}
