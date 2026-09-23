import { describe, expect, it } from 'vitest';
import { WritingDocument } from '../src/document.js';
import { needsCorrection } from '../src/correction-routing.js';

describe('referring spelling checks to Luna', () => {
  it('keeps the stricter guard for an unfinished last word', () => {
    const doc = new WritingDocument();
    doc.edit('I want someth');
    const word = doc.snapshot(doc.text.length, true).words.at(-1)!;
    expect(needsCorrection(word, { key: word.key, probability: 0.72 })).toBe(false);
  });

  it('leaves a low-scoring proper name alone', () => {
    const doc = new WritingDocument();
    doc.edit('I use Svelte for this site.');
    const word = doc.snapshot(doc.text.length, true).words.find((word) => word.word === 'Svelte')!;
    expect(needsCorrection(word, { key: word.key, probability: 0.04 })).toBe(false);
  });

  it('still refers missing apostrophes separately from spelling', () => {
    const doc = new WritingDocument();
    doc.edit('Lets test this.');
    const word = doc.snapshot(doc.text.length, true).words[0];
    expect(needsCorrection(word, { key: word.key, probability: 0.1, apostropheProbability: 0.95 })).toBe(true);
  });
});
