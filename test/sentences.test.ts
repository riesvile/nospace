import { describe, expect, it } from 'vitest';
import { WritingDocument } from '../src/document.js';

describe('sentence capitalization', () => {
  it.each([
    ['hello world', 'Hello world'],
    ['hello. lets test this', 'Hello. Lets test this'],
    ['hello!lets test this?yes', 'Hello!Lets test this?Yes'],
    ['  “hello.” “another sentence.”', '  “Hello.” “Another sentence.”'],
    ['hello\nthis is the same sentence', 'Hello\nthis is the same sentence'],
    ['ask dr. smith, e.g. about version 3.14 and example.com', 'Ask dr. smith, e.g. about version 3.14 and example.com']
  ])('capitalizes prose without splitting abbreviations: %s', (input, expected) => {
    const doc = new WritingDocument();
    doc.edit(input);
    expect(doc.capitalizeSentences()).toBe(true);
    expect(doc.text).toBe(expected);
    expect(doc.capitalizeSentences()).toBe(false);
  });

  it('retains the caret and supports undo/redo', () => {
    const doc = new WritingDocument();
    doc.edit('hello');
    const caret = doc.anchor(1);
    doc.capitalizeSentences();
    expect(doc.resolve(caret)).toBe(1);
    doc.undo();
    expect(doc.text).toBe('hello');
    doc.redo();
    expect(doc.text).toBe('Hello');
  });

  it('capitalizes after a period once Jev supplies the space', () => {
    const doc = new WritingDocument();
    doc.edit('Hello.lets');
    expect(doc.capitalizeSentences()).toBe(false);
    const snapshot = doc.snapshot(doc.text.length);
    const boundary = snapshot.input.boundaries.find((boundary) => boundary.left === 'Hello.')!;
    doc.applySpacing(snapshot, [{ id: boundary.id, probability: 0.99 }]);
    doc.capitalizeSentences();
    expect(doc.text).toBe('Hello. Lets');
  });
});
