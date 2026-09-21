import { describe, expect, it } from 'vitest';
import { WritingDocument } from '../src/document.js';

function boundary(doc: WritingDocument, after: string, probability = 0.99) {
  const snapshot = doc.snapshot(doc.text.length);
  const candidate = snapshot.input.boundaries.find((b) => b.left === after)!;
  return { snapshot, results: [{ id: candidate.id, probability }] };
}

describe('asynchronous writing', () => {
  it('preserves every manual replacement around an automatic space', () => {
    for (let start = 0; start <= 11; start++) {
      for (let end = start; end <= 11; end++) {
        for (const replacement of ['', 'X', ' ', '🙂']) {
          const doc = new WritingDocument();
          doc.edit('helloworld');
          const { snapshot, results } = boundary(doc, 'hello');
          doc.applySpacing(snapshot, results);
          const expected = doc.text.slice(0, start) + replacement + doc.text.slice(end);
          doc.edit(expected);
          expect(doc.text).toBe(expected);
        }
      }
    }
  });
  it('applies a late space while later characters continue to arrive', () => {
    const doc = new WritingDocument();
    doc.edit('hellow');
    const { snapshot, results } = boundary(doc, 'hello');
    doc.edit('helloworld');
    expect(doc.applySpacing(snapshot, results)).toBe(true);
    expect(doc.text).toBe('hello world');
  });

  it('rejects stale boundary decisions after manual editing', () => {
    const doc = new WritingDocument();
    doc.edit('helloworld');
    const { snapshot, results } = boundary(doc, 'hello');
    doc.edit('yelloworld');
    expect(doc.applySpacing(snapshot, results)).toBe(false);
    expect(doc.text).toBe('yelloworld');
  });

  it('newer negative evidence can remove a premature space; older results cannot restore it', () => {
    const doc = new WritingDocument();
    doc.edit('something');
    const early = boundary(doc, 'some');
    doc.applySpacing(early.snapshot, early.results);
    expect(doc.text).toBe('some thing');
    const newer = boundary(doc, 'some', 0.01);
    doc.applySpacing(newer.snapshot, newer.results);
    doc.applySpacing(early.snapshot, early.results);
    expect(doc.text).toBe('something');
  });

  it('respects a user deleting an automatic space', () => {
    const doc = new WritingDocument();
    doc.edit('helloworld');
    const { snapshot, results } = boundary(doc, 'hello');
    doc.applySpacing(snapshot, results);
    doc.edit('helloworld');
    expect(doc.text).toBe('helloworld');
    expect(doc.snapshot(doc.text.length).input.boundaries.some((b) => b.left === 'hello')).toBe(false);
  });

  it('applies a correction to an untouched word while the next word grows', () => {
    const doc = new WritingDocument();
    doc.edit('teh cat');
    const word = doc.snapshot(doc.text.length).words[0];
    doc.edit('teh cat is sleeping');
    expect(doc.correct(word, 'the')).toBe(true);
    expect(doc.text).toBe('the cat is sleeping');
  });

  it('corrects a word recognized after automatic spacing', () => {
    const doc = new WritingDocument();
    doc.edit('tehcatissleeping');
    for (const left of ['teh', 'tehcat', 'tehcatis']) {
      const { snapshot, results } = boundary(doc, left);
      doc.applySpacing(snapshot, results);
    }
    const word = doc.snapshot(doc.text.length).words[0];
    expect(word.word).toBe('teh');
    expect(doc.correct(word, 'the')).toBe(true);
    expect(doc.text).toBe('the cat is sleeping');
  });

  it('discards a typo fix if the user already corrected it', () => {
    const doc = new WritingDocument();
    doc.edit('teh cat');
    const word = doc.snapshot(doc.text.length).words[0];
    doc.edit('the cat');
    expect(doc.correct(word, 'the')).toBe(false);
    expect(doc.text).toBe('the cat');
  });

  it('does not complete a word after the user resumes typing it', () => {
    const doc = new WritingDocument();
    doc.edit('recieve');
    const word = doc.snapshot(doc.text.length, true).words[0];
    doc.edit('reciever');
    expect(doc.correct(word, 'receive')).toBe(false);
  });

  it('preserves explicit spaces, newlines, emoji and a selection across an insertion', () => {
    const doc = new WritingDocument();
    doc.edit('🙂 hi\nhelloworld');
    const caret = doc.anchor(doc.text.length);
    const { snapshot, results } = boundary(doc, '🙂 hi\nhello');
    doc.applySpacing(snapshot, results);
    expect(doc.text).toBe('🙂 hi\nhello world');
    expect(doc.resolve(caret)).toBe(doc.text.length);
  });

  it('undo restores the previous document and invalidates in-flight work', () => {
    const doc = new WritingDocument();
    doc.edit('helloworld');
    const { snapshot, results } = boundary(doc, 'hello');
    doc.applySpacing(snapshot, results);
    doc.undo();
    expect(doc.text).toBe('helloworld');
    expect(doc.applySpacing(snapshot, results)).toBe(false);
    doc.redo();
    expect(doc.text).toBe('hello world');
  });

  it('does not let a typo replacement overwrite newly resegmented text', () => {
    const doc = new WritingDocument();
    doc.edit('tehcat ');
    const word = doc.snapshot(doc.text.length).words[0];
    const { snapshot, results } = boundary(doc, 'teh');
    doc.applySpacing(snapshot, results);
    expect(doc.correct(word, 'thecat')).toBe(false);
  });

  it('inserts an apostrophe without changing surrounding spaces or caret position', () => {
    const doc = new WritingDocument();
    doc.edit('Lets test this');
    const word = doc.snapshot(doc.text.length).words[0];
    const caret = doc.anchor(doc.text.length);
    expect(doc.correct(word, "Let's")).toBe(true);
    expect(doc.text).toBe("Let's test this");
    expect(doc.resolve(caret)).toBe(doc.text.length);
    doc.undo();
    expect(doc.text).toBe('Lets test this');
  });

  it('discards a pending apostrophe if the user already inserted one', () => {
    const doc = new WritingDocument();
    doc.edit('Lets test this');
    const word = doc.snapshot(doc.text.length).words[0];
    doc.edit("Let's test this");
    expect(doc.correct(word, "Let's")).toBe(false);
    expect(doc.text).toBe("Let's test this");
  });
});
