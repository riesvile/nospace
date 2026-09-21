import { describe, expect, it, vi } from 'vitest';
import { createRequestHandlers } from '../src/server/http.js';
import { createHttpProvider } from '../src/http.js';
import { createJevLunaProvider } from '../src/server/index.js';
import type { AnalysisInput, AnalysisResult, NoSpaceProvider } from '../src/types.js';

const input: AnalysisInput = { raw: 'hello', contextBefore: '', contextAfter: '', boundaries: [], words: [], paused: false };
const output: AnalysisResult = { boundaries: [], typos: [], durationMs: 0 };
const request = (body: unknown = input, extra: RequestInit = {}) => new Request('https://app.example/api/analyze', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra
});

describe('framework-independent backend', () => {
  it('validates input, returns no-store responses, and propagates cancellation', async () => {
    const analyze = vi.fn().mockResolvedValue(output);
    const handler = createRequestHandlers({ analyze });
    const req = request(); const response = await handler.analyze(req);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(output);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(analyze).toHaveBeenCalledWith(input, req.signal);
  });

  it.each([null, {}, { ...input, raw: 'x'.repeat(65) }, { ...input, boundaries: [null] },
    { ...input, boundaries: [{ id: 1, left: 'wrong', right: 'text' }] },
    { ...input, words: [{ key: 'a', word: 'hello', before: '', after: '', terminal: 'yes' }] }
  ])('rejects malformed analysis before contacting a provider', async (body) => {
    const analyze = vi.fn(); const response = await createRequestHandlers({ analyze }).analyze(request(body));
    expect(response.status).toBe(400); expect(analyze).not.toHaveBeenCalled();
  });

  it('enforces methods, content type, exact origins, JSON parsing and byte limits', async () => {
    const analyze = vi.fn(); const handler = createRequestHandlers({ analyze });
    expect((await handler.analyze(new Request('https://app.example/api'))).status).toBe(405);
    expect((await handler.analyze(request(input, { headers: { 'Content-Type': 'text/plain' } }))).status).toBe(415);
    expect((await handler.analyze(request(input, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } }))).status).toBe(403);
    expect((await handler.analyze(request(input, { body: '{broken' }))).status).toBe(400);
    expect((await handler.analyze(request({ raw: '🙂'.repeat(7000) }))).status).toBe(413);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('supports explicitly allowed cross-origin frontends', async () => {
    const handler = createRequestHandlers({ analyze: async () => output }, { allowedOrigins: ['https://frontend.example'] });
    const response = await handler.analyze(request(input, { headers: { 'Content-Type': 'application/json', Origin: 'https://frontend.example' } }));
    expect(response.status).toBe(200);
  });

  it('sanitizes unexpected provider exceptions', async () => {
    const handler = createRequestHandlers({ analyze: async () => { throw new Error('secret example credential'); } });
    const response = await handler.analyze(request());
    expect(response.status).toBe(500); expect(await response.text()).not.toContain('credential');
  });

  it('supports optional correction and rejects multiword correction input', async () => {
    const handler = createRequestHandlers({ analyze: async () => output });
    expect((await handler.correct(request({ word: 'teh', before: '', after: ' cat' }))).status).toBe(503);
    expect((await handler.correct(request({ word: 'two words', before: '', after: '' }))).status).toBe(400);
  });

  it('round-trips the browser transport through the handlers', async () => {
    const provider: NoSpaceProvider = { analyze: async () => output, correct: async () => 'the' };
    const handlers = createRequestHandlers(provider);
    const client = createHttpProvider({ analyzeUrl: 'https://app.example/analyze', correctUrl: 'https://app.example/correct',
      fetch: async (url, init) => (String(url).endsWith('correct') ? handlers.correct : handlers.analyze)(new Request(url, init)) });
    const signal = new AbortController().signal;
    expect(await client.analyze(input, signal)).toEqual(output);
    expect(await client.correct!({ word: 'teh', before: '', after: ' cat' }, signal)).toBe('the');
  });

  it('preserves HTTP status on failures even when the proxy sends HTML', async () => {
    const client = createHttpProvider({ analyzeUrl: '/api/analyze', fetch: async () => new Response('<html>busy</html>', { status: 429 }) });
    await expect(client.analyze(input, new AbortController().signal)).rejects.toMatchObject({ status: 429 });
  });

  it('rejects malformed successful responses', async () => {
    const client = createHttpProvider({ analyzeUrl: '/api/analyze', fetch: async () => Response.json({ ...output, boundaries: [{ id: 1, probability: 7 }] }) });
    await expect(client.analyze(input, new AbortController().signal)).rejects.toMatchObject({ status: 502 });
  });

  it('uses only explicitly supplied provider credentials and supports spacing without Luna', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ answers: { typo_0: { noul: 0.01 } } }));
    const provider = createJevLunaProvider({ typesafeKey: 'test-key-only', fetch: fetcher });
    expect(provider.correct).toBeUndefined();
    await provider.analyze({ ...input, raw: '', words: [{ key: 'word', word: 'hello', before: '', after: ' ', terminal: false }] }, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledWith('https://api.typesafe.ai/v1/systemone', expect.objectContaining({
      headers: { Authorization: 'Bearer test-key-only', 'Content-Type': 'application/json' }
    }));
    const unconfigured = createJevLunaProvider({});
    await expect(unconfigured.analyze({ ...input, words: [{ key: 'word', word: 'hello', before: '', after: '', terminal: false }] }, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
  });
});
