import { describe, expect, it, vi } from 'vitest';
import { createHttpProvider } from '../src/http.js';
import { createRequestHandlers } from '../src/server/http.js';
import { RateLimitError } from '../src/server/limits.js';
import { createJevLunaProvider } from '../src/server/index.js';
import { UsageLimiter } from '../src/server/node.js';
import type { AnalysisInput, NoSpaceProvider } from '../src/types.js';

const empty = { boundaries: [], typos: [], durationMs: 0 };
const sentence = { text: 'This is cool a shell.', before: '', after: '' };
const input: AnalysisInput = { raw: 'hello', contextBefore: '', contextAfter: '', boundaries: [], words: [], paused: false };
const request = (value: unknown) => new Request('https://app.example/nospace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const signal = () => new AbortController().signal;

describe('review HTTP contract', () => {
  it('round-trips all review operations through validated handlers with shared correction quotas', async () => {
    const provider: NoSpaceProvider = { analyze: async () => empty, correctSentence: vi.fn(async () => 'This is cool as hell.'),
      reviewDocument: vi.fn(async () => ({ decision: 'needs_update', probability: 0.99 })),
      correctDocument: vi.fn(async () => [{ start: 8, original: 'cool a shell', replacement: 'cool as hell' }]) };
    const release = vi.fn(); const reserve = vi.fn(() => release);
    const handlers = createRequestHandlers(provider, { reserve });
    const client = createHttpProvider({ analyzeUrl: 'https://app.example/analyze', correctUrl: 'https://app.example/correct',
      fetch: async (url, init) => (String(url).endsWith('correct') ? handlers.correct : handlers.analyze)(new Request(url, init)) });
    expect(await client.correctSentence!(sentence, signal())).toBe('This is cool as hell.');
    expect(await client.reviewDocument!(sentence, signal())).toEqual({ decision: 'needs_update', probability: 0.99 });
    expect(await client.correctDocument!(sentence, signal())).toEqual([{ start: 8, original: 'cool a shell', replacement: 'cool as hell' }]);
    expect(reserve.mock.calls.map(([kind]) => kind)).toEqual(['correct', 'review', 'correct']);
    expect(release).toHaveBeenCalledTimes(3);
  });
  it.each([
    ['analyze', { ...input, sentence, paused: false }],
    ['analyze', { ...input, boundaries: [{ id: 1, left: 'h', right: 'ello', space: 'yes' }] }],
    ['analyze', { ...input, mode: 'unknown' }],
    ['analyze', { mode: 'document', document: { ...sentence, text: 'x'.repeat(1201) } }],
    ['analyze', { mode: 'document', document: { ...sentence, before: 'x'.repeat(161) } }],
    ['correct', { mode: 'sentence', sentence: { ...sentence, text: 'x'.repeat(161) } }],
    ['correct', { mode: 'sentence', sentence: { ...sentence, after: 'x'.repeat(81) } }],
    ['correct', { mode: 'document', document: null }],
    ['correct', { mode: 'document', document: { ...sentence, text: '   ' } }]
  ])('rejects malformed %s before reserving paid usage', async (kind, body) => {
    const reserve = vi.fn(); const call = vi.fn();
    const handlers = createRequestHandlers({ analyze: call, correctSentence: call, correctDocument: call, reviewDocument: call }, { reserve });
    expect((await handlers[kind as 'analyze' | 'correct'](request(body))).status).toBe(400);
    expect(call).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it('returns unsupported capabilities without charging a quota', async () => {
    const reserve = vi.fn(); const handlers = createRequestHandlers({ analyze: async () => empty }, { reserve });
    expect((await handlers.analyze(request({ mode: 'document', document: sentence }))).status).toBe(503);
    expect((await handlers.correct(request({ mode: 'sentence', sentence }))).status).toBe(503);
    expect((await handlers.correct(request({ mode: 'document', document: sentence }))).status).toBe(503);
    expect(reserve).not.toHaveBeenCalled();
  });
  it('rejects exhausted quotas before provider calls, with an actionable retry delay', async () => {
    const call = vi.fn(); const reserve = vi.fn(() => { throw new RateLimitError(45); });
    const handlers = createRequestHandlers({ analyze: call, correctDocument: call }, { reserve });
    const response = await handlers.correct(request({ mode: 'document', document: sentence }));
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('45');
    expect(await response.json()).toMatchObject({ retryAfter: 45 }); expect(call).not.toHaveBeenCalled();
  });
  it('fails closed on quota storage errors and releases leases when the provider fails', async () => {
    const analyze = vi.fn().mockRejectedValue(new Error('private provider detail'));
    const handlers = createRequestHandlers({ analyze }, { reserve: () => { throw new Error('database path'); } });
    const unavailable = await handlers.analyze(request(input));
    expect(unavailable.status).toBe(500); expect(await unavailable.text()).not.toContain('database'); expect(analyze).not.toHaveBeenCalled();
    const release = vi.fn(); const working = createRequestHandlers({ analyze }, { reserve: () => release });
    const response = await working.analyze(request(input));
    expect(response.status).toBe(500); expect(await response.text()).not.toContain('private'); expect(release).toHaveBeenCalledOnce();
  });
  it('connects the Node limiter to all handlers without importing it into the portable entry', async () => {
    const limiter = new UsageLimiter(':memory:', {
      analyze: { windows: [{ seconds: 60, perIp: 1, site: 100 }], perIpConcurrent: 1, siteConcurrent: 100, leaseSeconds: 20 },
      review: { windows: [{ seconds: 60, perIp: 1, site: 100 }], perIpConcurrent: 1, siteConcurrent: 100, leaseSeconds: 20 },
      correct: { windows: [{ seconds: 60, perIp: 1, site: 100 }], perIpConcurrent: 1, siteConcurrent: 100, leaseSeconds: 30 }
    });
    try {
      const handlers = createRequestHandlers({ analyze: async () => empty, correct: async () => 'the', correctSentence: async () => null }, { reserve: (kind) => limiter.reserve(kind, '192.0.2.1') });
      expect((await handlers.correct(request({ word: 'teh', before: '', after: ' cat' }))).status).toBe(200);
      const response = await handlers.correct(request({ mode: 'sentence', sentence }));
      expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBeTruthy();
      expect((await handlers.analyze(request(input))).status).toBe(200);
    } finally { limiter.close(); }
  });
  it.each(['17', 'invalid'])('honors a proxy Retry-After value %s even with an HTML response', async (header) => {
    const client = createHttpProvider({ analyzeUrl: '/analyze', fetch: async () => new Response('<html>busy</html>', { status: 429, headers: { 'Retry-After': header } }) });
    await expect(client.analyze(input, signal())).rejects.toMatchObject({ status: 429, retryAfterMs: header === '17' ? 17000 : 2000 });
  });
  it('understands an HTTP-date retry delay and caps absurd delays', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-23T00:00:00Z'));
    try {
      const client = createHttpProvider({ analyzeUrl: '/analyze', fetch: async () => new Response('', { status: 429, headers: { 'Retry-After': 'Wed, 23 Sep 2026 00:00:30 GMT' } }) });
      await expect(client.analyze(input, signal())).rejects.toMatchObject({ retryAfterMs: 30000 });
      const capped = createHttpProvider({ analyzeUrl: '/analyze', fetch: async () => new Response('', { status: 429, headers: { 'Retry-After': '9999999' } }) });
      await expect(capped.analyze(input, signal())).rejects.toMatchObject({ retryAfterMs: 86400000 });
    } finally { vi.useRealTimers(); }
  });
  it.each([
    { updates: [{ start: 8, original: 'not matching', replacement: 'no' }] },
    { updates: [{ start: 8, original: 'cool a shell', replacement: 'cool as hell' }, { start: 8, original: 'cool a shell', replacement: 'cool as hell' }] },
    { updates: [{ start: -1, original: 'This', replacement: 'That' }] },
    { updates: [null] }, {}
  ])('rejects invalid full-text repair responses', async (response) => {
    const client = createHttpProvider({ analyzeUrl: '/analyze', correctUrl: '/correct', fetch: async () => Response.json(response) });
    await expect(client.correctDocument!(sentence, signal())).rejects.toMatchObject({ status: 502 });
  });
  it('uses GPT-6 Luna and the appropriate token ceiling for each correction method', async () => {
    const fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe('gpt-6-luna'); expect(body.store).toBe(false);
      return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(body.max_output_tokens === 480 ? { edits: [] } : { correction: null }) }] }] });
    });
    const provider = createJevLunaProvider({ openaiKey: 'test', fetch });
    await provider.correct!({ word: 'teh', before: '', after: ' cat' }, signal());
    await provider.correctSentence!(sentence, signal()); await provider.correctDocument!(sentence, signal());
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string).max_output_tokens)).toEqual([120, 120, 480]);
  });
  it('preserves upstream throttling through the provider, server handler and browser client', async () => {
    const provider = createJevLunaProvider({ openaiKey: 'test', fetch: async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }) });
    const handlers = createRequestHandlers(provider);
    const client = createHttpProvider({ analyzeUrl: 'https://app.example/analyze', correctUrl: 'https://app.example/correct', fetch: async (url, init) => handlers.correct(new Request(url, init)) });
    await expect(client.correctSentence!(sentence, signal())).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
  });
});
