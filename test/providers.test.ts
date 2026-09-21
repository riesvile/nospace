import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildQuestions, correct } from '../src/server/providers.js';

afterEach(() => vi.unstubAllGlobals());

describe('word correction routing and validation', () => {
  it('asks an independent contextual apostrophe question for an ambiguous contraction', () => {
    const { questions } = buildQuestions({
      contextBefore: '', contextAfter: '', raw: 'Letstestthis', boundaries: [], paused: true,
      words: [{ key: 'lets', word: 'Lets', before: '', after: ' test this', terminal: false }]
    });
    expect(questions.apostrophe_0).toMatchObject({
      type: 'noul', instructions: { candidate: 'Lets', contraction: "let's", after: ' test this' }
    });
    expect(questions.typo_0.type).toBe('noul');
  });

  it.each([
    ['Lets', "Let's", "Let's"],
    ['lets', null, null],
    ['lets', 'let us', null],
    ['test', 'rewrite', null]
  ])('validates a correction of %s to %s', async (word, proposed, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ correction: proposed }) }] }]
    }))));
    expect(await correct({ word, before: '', after: ' test this' }, { openaiKey: 'test-key' }, new AbortController().signal)).toBe(expected);
  });
});
