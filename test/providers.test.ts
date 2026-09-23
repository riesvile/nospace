import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyze, buildQuestions, correct, correctSentence, correctDocument, reviewDocument } from '../src/server/providers.js';
import { WritingDocument } from '../src/document.js';
import { needsCorrection } from '../src/correction-routing.js';

afterEach(() => vi.unstubAllGlobals());

describe('word correction routing and validation', () => {
  it('routes the spaced Teh in tehcatdrinksmilk to Luna and applies The', async () => {
    const doc = new WritingDocument();
    doc.edit('tehcatdrinksmilk');
    doc.capitalizeSentences();
    const unspaced = doc.snapshot(doc.text.length, true);
    doc.applySpacing(unspaced, unspaced.input.boundaries.map((boundary) => ({
      id: boundary.id, probability: ['Teh', 'Tehcat', 'Tehcatdrinks'].includes(boundary.left) ? 1 : 0
    })));
    expect(doc.text).toBe('Teh cat drinks milk');
    const snapshot = doc.snapshot(doc.text.length, true);
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      const request = JSON.parse(options.body);
      expect(request.state.spelling[0]).toEqual({
        candidate: 'Teh', text: 'Teh cat drinks milk', last_word: false
      });
      expect(request.questions.typo_0.instructions).toContain('`spelling[0].text`');
      return new Response(JSON.stringify({ answers: {
        ...Object.fromEntries(Object.entries(request.questions).filter(([key]) => key.startsWith('spacing_')).map(([key, question]) => [key, {
          probabilities: Object.fromEntries(Object.keys((question as { criteria: Record<string, string> }).criteria).map((option, i) => [option, Number(i === 0)]))
        }])),
        typo_0: { noul: 0.72 }, typo_1: { noul: 0.02 }, typo_2: { noul: 0.03 }, typo_3: { noul: 0.05 }, sentence: { noul: 0.1 }
      } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await analyze({ ...snapshot.input, boundaries: [] }, { typesafeKey: 'test-key' }, new AbortController().signal);
    const referred = snapshot.words.filter((word, i) => needsCorrection(word, result.typos[i]));
    expect(referred.map((word) => word.word)).toEqual(['Teh']);
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
      status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"correction":"The"}' }] }]
    })));
    const replacement = await correct(referred[0], { openaiKey: 'test-key' }, new AbortController().signal);
    expect(replacement).toBe('The');
    expect(doc.correct(referred[0], replacement!)).toBe(true);
    expect(doc.text).toBe('The cat drinks milk');
  });

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

describe('contextual spacing ambiguity', () => {
  it('shows local spacing alternatives inside the same sentence context', () => {
    const doc = new WritingDocument();
    doc.edit('You may buy a pen at penisland');
    const { questions, runs } = buildQuestions(doc.snapshot(doc.text.length, true).input);
    const run = runs.find((run) => run.current === 'penisland')!;
    const question = questions[run.key];
    expect(question.type).toBe('choice');
    if (question.type !== 'choice') throw new Error('Expected spacing choices');
    expect(Object.values(question.criteria)).toContain('You may buy a pen at pen island');
    expect(Object.values(question.criteria)).toContain('You may buy a pen at penisland');
  });

  function joinedPlace() {
    const doc = new WritingDocument();
    doc.edit('Youmaybuyapenatpenisland');
    const initial = doc.snapshot(doc.text.length);
    const breaks = ['You', 'Youmay', 'Youmaybuy', 'Youmaybuya', 'Youmaybuyapen', 'Youmaybuyapenat'];
    doc.applySpacing(initial, initial.input.boundaries.map((b) => ({ id: b.id, probability: Number(breaks.includes(b.left)) })));
    expect(doc.text).toBe('You may buy a pen at penisland');
    return doc;
  }

  function mockChoices(weights?: Record<string, number>) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, options) => {
      const request = JSON.parse(options.body);
      return Response.json({ answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
        if (key === 'sentence') return [key, { noul: 0.9 }];
        if (!key.startsWith('spacing_')) return [key, { noul: 0 }];
        const entries = Object.entries((question as { criteria: Record<string, string> }).criteria);
        return [key, { probabilities: Object.fromEntries(entries.map(([option, candidate]) => [option, weights ? weights[candidate] ?? 0 : 1 / entries.length])) }];
      })) });
    }));
  }

  it('routes rejected on-screen spacing to a guarded repair when boundary marginals disagree', async () => {
    const doc = joinedPlace();
    const snapshot = doc.snapshot(doc.text.length, true);
    mockChoices({ 'You may buy a pen at pen island': 0.48, 'You may buy a pen at penis land': 0.48, [doc.text]: 0.04 });
    const result = await analyze(snapshot.input, { typesafeKey: 'test' }, new AbortController().signal);
    // Neither uncertain boundary crosses 0.65, but the joined reading has only
    // 4% support. The existing sentence gate must get a chance to resolve it.
    expect(doc.applySpacing(snapshot, result.boundaries)).toBe(false);
    expect(result.sentencePlausibility).toBeCloseTo(0.04);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ correction: 'You may buy a pen at Pen Island' }) }] }]
    })));
    const repair = await correctSentence(snapshot.sentence!, { openaiKey: 'test' }, new AbortController().signal);
    expect(doc.correctSentence(snapshot.sentence!, repair!)).toBe(true);
    expect(doc.text).toBe('You may buy a pen at Pen Island');
    const next = doc.snapshot(doc.text.length);
    doc.applySpacing(next, next.input.boundaries.map((b) => ({ id: b.id, probability: b.left.length <= 'Youmaybuyapenat'.length ? Number(b.space) : 0 })));
    expect(doc.text).toBe('You may buy a pen at Pen Island');
    doc.undo();
    expect(doc.text).toBe('You may buy a pen at penisland');
  });

  it('keeps supported current readings and does not escalate diffuse uncertainty', async () => {
    const doc = joinedPlace();
    const input = doc.snapshot(doc.text.length, true).input;
    mockChoices({ [doc.text]: 0.9, 'You may buy a pen at pen island': 0.1 });
    expect((await analyze(input, { typesafeKey: 'test' }, new AbortController().signal)).sentencePlausibility).toBeCloseTo(0.9);
    mockChoices();
    expect((await analyze(input, { typesafeKey: 'test' }, new AbortController().signal)).sentencePlausibility).toBeCloseTo(0.9);
  });

  it('does not infer the displayed reading for older clients or while typing', async () => {
    const doc = joinedPlace();
    const input = doc.snapshot(doc.text.length, true).input;
    const legacy = { ...input, boundaries: input.boundaries.map(({ space: _space, ...boundary }) => boundary) };
    mockChoices({ 'You may buy a pen at pen island': 1 });
    expect((await analyze(legacy, { typesafeKey: 'test' }, new AbortController().signal)).sentencePlausibility).toBe(0.9);
    expect((await analyze({ ...input, paused: false }, { typesafeKey: 'test' }, new AbortController().signal)).sentencePlausibility).toBeUndefined();
  });

  it('does not send the current sentence to Luna for rejected spacing in a different sentence', async () => {
    const doc = joinedPlace();
    const input = doc.snapshot(doc.text.length, true).input;
    mockChoices({ 'You may buy a pen at pen island': 1 });
    const result = await analyze({ ...input, sentence: { text: 'This sentence is fine.', before: doc.text, after: '' } }, { typesafeKey: 'test' }, new AbortController().signal);
    expect(result.sentencePlausibility).toBe(0.9);
  });
});

describe('sentence correction', () => {
  it('asks the sentence question only on a paused snapshot', () => {
    const input = {
      raw: 'Thisiscoolashell', boundaries: [], words: [], contextBefore: '', contextAfter: '', paused: true,
      sentence: { text: 'This is cool a shell', before: '', after: '' }
    };
    expect(buildQuestions(input).questions.sentence).toMatchObject({ type: 'noul' });
    expect(buildQuestions({ ...input, paused: false }).questions.sentence).toBeUndefined();
  });

  it.each([
    ['This is cool a shell', 'This is cool as hell', 'This is cool as hell'],
    ['I have alot of time.', 'I have a lot of time.', 'I have a lot of time.'],
    ['Teh cat drinks milk', 'The cat drinks milk', 'The cat drinks milk'],
    ['I went too school', 'I went to school', 'I went to school'],
    ['This is cool as hell', null, null],
    ['This is cool a shell', 'This is very impressive.', null],
    ['I have 12 small cats', 'I have 13 small cats', null],
    ['I want to buy a car', 'I want to buy a carpet', null],
    ['This is cool a shell', 'This is cool as hell!', null]
  ])('validates a sentence repair: %s → %s', async (text, proposed, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ correction: proposed }) }] }]
    }))));
    expect(await correctSentence({ text, before: '', after: '' }, { openaiKey: 'test-key' }, new AbortController().signal)).toBe(expected);
  });
});

describe('full-text review providers', () => {
  it('accepts all the targeted repairs from a garbled multi-sentence draft together', async () => {
    const text = 'Trying this out just to see how it performs its kindadoingoiay actually. Inter stingidea idonothateit!';
    const edits = [
      { original: 'its kindadoingoiay', replacement: "it's kinda doing okay" },
      { original: 'Inter stingidea', replacement: 'Interesting idea' },
      { original: 'idonothateit', replacement: 'I do not hate it' }
    ];
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ edits }) }] }]
    }));
    vi.stubGlobal('fetch', fetchMock);
    const updates = await correctDocument({ text, before: '', after: '' }, { openaiKey: 'test-key' }, new AbortController().signal);
    expect(updates).toHaveLength(3);
    const doc = new WritingDocument();
    doc.edit(text);
    expect(doc.correctDocument(doc.documentSnapshot(), updates)).toBe(true);
    expect(doc.text).toBe("Trying this out just to see how it performs it's kinda doing okay actually. Interesting idea I do not hate it!");
    doc.undo();
    expect(doc.text).toBe(text);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.max_output_tokens).toBe(480);
    expect(payload.text.format.schema.properties.edits.maxItems).toBe(6);
  });

  it('keeps valid repairs when another edit rewrites wording or changes punctuation', async () => {
    const text = 'its kindadoingoiay actually. Inter stingidea idonothateit!';
    const edits = [
      { original: 'kindadoingoiay', replacement: 'kind of doing okay' },
      { original: 'Inter stingidea', replacement: 'Interesting idea.' },
      { original: 'idonothateit', replacement: 'I do not hate it' }
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ edits }) }] }]
    })));
    expect(await correctDocument({ text, before: '', after: '' }, { openaiKey: 'test-key' }, new AbortController().signal))
      .toEqual([{ start: text.indexOf('idonothateit'), ...edits[2] }]);
  });

  it('rejects duplicate, overlapping and ambiguous edits', async () => {
    const text = 'Teh cat sleeps. Teh cat eats. This is cool a shell.';
    const edits = [
      { original: 'Teh cat', replacement: 'The cat' },
      { original: 'cool a shell', replacement: 'cool as hell' },
      { original: 'cool a shell', replacement: 'cool as hell' },
      { original: 'This is cool a shell', replacement: 'This is cool as hell' }
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ edits }) }] }]
    })));
    expect(await correctDocument({ text, before: '', after: '' }, { openaiKey: 'test-key' }, new AbortController().signal))
      .toEqual([{ start: text.indexOf('cool a shell'), ...edits[1] }]);
  });

  it.each([[0.95, 'needs_update'], [0.55, 'ok'], [0.04, 'ok']])('requires a confident document flag: %s', async (probability, decision) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      answers: { review: { probabilities: { needs_update: probability, ok: 1 - Number(probability) } } }
    }))));
    expect(await reviewDocument({ text: 'An earlier sentence. A later one.', before: '', after: '' }, { typesafeKey: 'test-key' }, new AbortController().signal))
      .toMatchObject({ decision });
  });

  it.each([
    [{ original: 'cool a shell', replacement: 'cool as hell' }, { start: 8, original: 'cool a shell', replacement: 'cool as hell' }],
    [{ original: 'not in the text', replacement: 'a phrase' }, null],
    [{ original: 'cool a shell', replacement: 'really wonderful' }, null],
    [null, null]
  ])('only accepts an exact, minimal excerpt repair', async (edit, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ edits: edit ? [edit] : [] }) }] }]
    }))));
    expect(await correctDocument({ text: 'This is cool a shell. The cat drinks milk.', before: '', after: '' }, { openaiKey: 'test-key' }, new AbortController().signal)).toEqual(expected ? [expected] : []);
  });
});
