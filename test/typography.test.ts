import { describe, expect, it } from 'vitest';
import { WritingDocument } from '../src/document.js';
import { typographyEdits } from '../src/typography.js';
import { completedSentence } from '../src/document-review.js';

function format(text: string) {
  for (const edit of typographyEdits(text).toReversed()) {
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.start + edit.original.length);
  }
  return text;
}

describe('prose typography', () => {
  it.each([
    ["What's new", 'What’s new'],
    ['"What\'s new"', '“What’s new”'],
    ['"hello" and "goodbye"', '“hello” and “goodbye”'],
    ["'hello' and 'goodbye'", '‘hello’ and ‘goodbye’'],
    ['"She said \'hello\'."', '“She said ‘hello’.”'],
    ["'She said \"hello\"'", '‘She said “hello”’'],
    ["The dogs' bowls and John's coat", 'The dogs’ bowls and John’s coat'],
    ["'Tis the '90s. Get 'em!", '’Tis the ’90s. Get ’em!'],
    ['That‘s good', 'That’s good'],
    ['Wait... really?', 'Wait… really?'],
    ['Version 3.14, 127.0.0.1, and file.txt', 'Version 3.14, 127.0.0.1, and file.txt'],
    ['It is 5\'10" tall.', 'It is 5\'10" tall.'],
    ['The answer is "42".', 'The answer is “42”.'],
    ['"It is 5\'10\" tall."', '“It is 5\'10" tall.”'],
    ['well-known words and 10-20', 'well-known words and 10-20'],
    ["https://example.com/what's/... and o'hara@example.com", "https://example.com/what's/... and o'hara@example.com"],
    ['"https://example.com/path"', '“https://example.com/path”'],
    ["'https://example.com/path'", '‘https://example.com/path’'],
    ["'o'hara@example.com'", "‘o'hara@example.com’"],
    ['`"code"...` and "prose"', '`"code"...` and “prose”'],
    ['```\nconst x = "hello"; // ...\n```\n"Hello"', '```\nconst x = "hello"; // ...\n```\n“Hello”'],
    ['An unfinished `"code"...', 'An unfinished `"code"...']
  ])('formats %s', (input, expected) => {
    expect(format(input)).toBe(expected);
    expect(format(expected)).toBe(expected);
  });

  it('keeps quote direction correct as a quoted contraction is typed', () => {
    const doc = new WritingDocument();
    for (const char of '"What\'snew"') {
      doc.edit(doc.text + char);
      doc.formatTypography(true);
    }
    expect(doc.text).toBe('“What’snew”');
    const snapshot = doc.snapshot(doc.text.length);
    const boundary = snapshot.input.boundaries.find((item) => item.left === '“What’s')!;
    doc.applySpacing(snapshot, [{ id: boundary.id, probability: 0.99 }]);
    doc.formatTypography(true);
    expect(doc.text).toBe('“What’s new”');
  });

  it('restores a literal apostrophe when typing becomes an email address', () => {
    const doc = new WritingDocument();
    for (const char of "o'hara@example.com") {
      doc.edit(doc.text + char);
      doc.formatTypography(true);
    }
    expect(doc.text).toBe("o'hara@example.com");
  });

  it('groups Luna apostrophe formatting with the correction for undo/redo', () => {
    const doc = new WritingDocument();
    doc.edit('Whats new');
    const bookmark = doc.snapshot(doc.text.length).words[0];
    const caret = doc.anchor(doc.text.length);
    expect(doc.correct(bookmark, "What's")).toBe(true);
    expect(doc.formatTypography(true)).toBe(true);
    expect(doc.text).toBe('What’s new');
    expect(doc.resolve(caret)).toBe(doc.text.length);
    doc.undo();
    expect(doc.text).toBe('Whats new');
    doc.redo();
    expect(doc.text).toBe('What’s new');
  });

  it('preserves a middle caret, automatic spaces and stale-repair protection', () => {
    const doc = new WritingDocument();
    doc.edit('"What\'s new"');
    const caret = doc.anchor(7);
    const pending = doc.documentSnapshot();
    doc.formatTypography();
    expect(doc.resolve(caret)).toBe(7);
    expect(doc.isDocumentCurrent(pending)).toBe(false);
    doc.undo();
    expect(doc.text).toBe('"What\'s new"');
  });

  it('formats multiple Luna edits together without adding an undo step', () => {
    const doc = new WritingDocument();
    doc.edit('Its working. Whats new?');
    const bookmark = doc.documentSnapshot();
    doc.correctDocument(bookmark, [
      { start: 0, original: 'Its', replacement: "It's" },
      { start: 13, original: 'Whats', replacement: "What's" }
    ]);
    doc.formatTypography(true);
    expect(doc.text).toBe('It’s working. What’s new?');
    doc.undo();
    expect(doc.text).toBe(bookmark.text);
  });

  it('allows spelling repairs inside single quotes', () => {
    const doc = new WritingDocument();
    doc.edit("'teh' cat");
    doc.formatTypography(true);
    const word = doc.snapshot(doc.text.length).words[0];
    expect(doc.correct(word, 'the')).toBe(true);
    expect(doc.text).toBe('‘the’ cat');
  });

  it('keeps cursor placement and spacing opportunities after an ellipsis', () => {
    const doc = new WritingDocument();
    doc.edit('Wait...really');
    const caret = doc.anchor(doc.text.indexOf('really'));
    doc.formatTypography(true);
    expect(doc.text).toBe('Wait…really');
    expect(doc.resolve(caret)).toBe(5);
    const snapshot = doc.snapshot(doc.text.length);
    expect(snapshot.input.boundaries.some((item) => item.left === 'Wait…')).toBe(true);
    expect(completedSentence('Wait', 'Wait…')).toBe(true);
    doc.undo();
    expect(doc.text).toBe('');
  });
});
