import { describe, expect, it } from 'vitest';
import { spacingCandidates } from '../src/server/candidates.js';
import { editDistance } from '../src/server/providers.js';

describe('candidate generation', () => {
  it('offers natural multiword candidates without ever modifying letters', () => {
    for (const [raw, expected] of [
      ['helloworld', 'hello world'],
      ['thisisatest', 'this is a test'],
      ['thequickbrownfox', 'the quick brown fox'],
      ['tehcat', 'teh cat']
    ]) {
      const candidates = spacingCandidates(raw);
      expect(candidates).toContain(expected);
      expect(candidates).toContain(raw);
      expect(candidates.every((candidate) => candidate.replaceAll(' ', '') === raw)).toBe(true);
    }
  });

  it('offers an unfinished final word and preserves unknown languages', () => {
    expect(spacingCandidates('hellowor')).toContain('hello wor');
    expect(spacingCandidates('ahojčau')).toEqual(['ahojčau']);
  });

  it.each([
    ['Letstestthis', 'Lets test this'],
    ["Let'stestthis", "Let's test this"],
    ['Let’stestthis', 'Let’s test this'],
    ["Don'tstoptyping", "Don't stop typing"],
    ["It'sworking", "It's working"]
  ])('keeps contractions together while the following words grow: %s', (raw, spaced) => {
    expect(spacingCandidates(raw)).toContain(spaced);
  });

  it('counts accidental transposition as one edit, but rejects rewrites', () => {
    expect(editDistance('teh', 'the')).toBe(1);
    expect(editDistance('recieve', 'receive')).toBe(1);
    expect(editDistance('cat', 'feline')).toBeGreaterThan(2);
  });
});
