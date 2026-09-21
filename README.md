# nospace

Type without spaces. Add automatic word spacing to an existing text input while
keeping control of its appearance, state and backend.

**Experimental, English prose.** The core preserves character identities, manual
spaces, selections, composition and undo while asynchronous spacing decisions
arrive. An optional server provider uses Jev to choose spacing and flag likely
typos, and Luna to correct a single word. You can supply your own provider.

This repository contains the library, tests and integration documentation. The
demo website, styles, fonts, analytics and deployment configuration live separately.
There are no runtime npm dependencies. ESM JavaScript and TypeScript declarations
are built into `dist/`.

## Install from GitHub

Requires Node.js 22.12+ for development and the example backend, and a modern browser
for the DOM adapter. This first version has **not been published to npm**.

```sh
npm install git+ssh://git@github.com/riesvile/nospace.git
```

The package name is `@riesvile/nospace`. Git installs build the package through the
`prepare` script. For development, clone this repo, run `npm ci`, then `npm run verify`.
For reproducible Git installs, pin a commit or release tag with `#<ref>`.

## Add it to an input

```ts
import { createHttpProvider } from '@riesvile/nospace';
import { attachNoSpace } from '@riesvile/nospace/dom';

const textarea = document.querySelector<HTMLTextAreaElement>('#message')!;
const session = attachNoSpace(textarea, {
  provider: createHttpProvider({
    analyzeUrl: '/api/nospace/analyze',
    correctUrl: '/api/nospace/correct',
  }),
  onChange(state, reason) {
    // Synchronize your application/framework state after an automatic edit.
    // The textarea value and selection have already been updated.
    console.log(state.text, reason);
  },
  onError(error, operation) {
    // error === null clears a previous error for this operation.
    if (error) console.warn(operation, error.message);
  },
});

// On unmount:
session.destroy();
```

The DOM adapter supports `<textarea>` and `<input type="text|search|tel|url">`.
It attaches listeners and temporarily disables native spelling/capitalization
features that could conflict with its edits. It restores those attributes on
`destroy()`. It does not apply styles, resize the control, move page scroll, focus
the control, or emit synthetic `input` events. Use `onChange` to synchronize state
or notify your application of library edits; native `input` events cover user edits.

For controlled React/Vue/Svelte inputs, keep framework state synchronized on **both**
native input and `onChange`. A callback ref/effect/action should attach once and
destroy on unmount. The plain DOM adapter owns this control's undo history.

## Provide the backend

Browser code calls your application server. Only that server receives provider
credentials. Mount these standard `Request -> Promise<Response>` handlers using
your framework's route API:

```ts
// Server-only module. Never import this into your browser application.
import { createJevLunaProvider, createRequestHandlers } from '@riesvile/nospace/server';

const provider = createJevLunaProvider({
  typesafeKey: process.env.TYPESAFE_API_KEY,
  openaiKey: process.env.OPENAI_API_KEY,
  jevModel: 'jev-latest',
  openaiModel: 'gpt-5.6-luna',
});

const handlers = createRequestHandlers(provider);

// POST /api/nospace/analyze -> handlers.analyze(request)
// POST /api/nospace/correct -> handlers.correct(request)
export const analyzeRequest = handlers.analyze;
export const correctRequest = handlers.correct;
```

For a framework where `POST` receives a Web `Request` directly, export the
corresponding handler as `POST`. In SvelteKit, use
`export const POST = ({ request }) => handlers.analyze(request)` in the analysis
route, and the equivalent correction handler in its route. In a Worker-style
runtime, read credentials from its environment bindings instead of `process.env`.

The library never reads `.env` or environment variables itself. Each application
provides its own credentials through server configuration or a secret store. No
provider key belongs in the browser, a public environment variable, a URL, or Git.
The `/server` export is disabled for browser-aware bundlers and the provider factory
also rejects creation in a browser. Treat the import boundary as an aid; your host
application is responsible for keeping its configuration on the server.

Handlers validate bounded JSON bodies (24 KB), check origin, reject malformed
requests, propagate cancellation, and return `Cache-Control: no-store`. **Mount
them behind your application's authentication and rate limits** before exposing
a paid provider. Origin checks are not authentication. If the frontend uses a
different origin, pass `{ allowedOrigins: ['https://your-frontend.example'] }` and
handle CORS/preflight in your application. The browser transport supports custom
application headers, credentials and a custom `fetch` function.

For spacing without spelling correction, omit `openaiKey` on the server and
`correctUrl` in the browser. The host can also call `provider.analyze()` and
`provider.correct()` directly from its own server routes instead of using the
provided HTTP handlers.

## Custom editors and providers

`createNoSpace()` has no DOM or framework dependency. Give it an adapter that
reads and synchronously applies plain text and selection offsets:

```ts
import { createNoSpace, type EditorState } from '@riesvile/nospace';

let state: EditorState = {
  text: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
};

const session = createNoSpace({
  editor: {
    getState: () => state,
    setState(next, reason) {
      state = next;
      // Apply a transaction to your editor and synchronize framework state.
    },
  },
  provider: {
    async analyze(input, signal) {
      // Return probabilities for the boundary IDs and word keys in input.
      // Forward to your backend, or use your own local/remote model.
      return { boundaries: [], typos: [], durationMs: 0 };
    },
    // Optional: async correct({ word, before, after }, signal) { return null; }
  },
  capitalize: true,  // default; set false to preserve casing
  idleDelayMs: 700,  // last-word check after a pause
});

// After your editor commits a user edit, update `state`, then:
session.input();
// Forward IME start/end to session.compositionStart()/compositionEnd().
// Route history commands to session.undo()/redo() if using its history.
// After loading a different document, update `state`, then session.reset().
// On unmount: session.destroy().
```

Selection offsets are UTF-16, like JavaScript strings and textarea selections.
Adapters for contenteditable, ProseMirror, TipTap, Lexical, CodeMirror or native
apps must map their document positions and transactions to this contract. A
generic rich-text adapter is not included: flattening arbitrary HTML and writing
it back would lose structure and editor history. See [architecture](docs/architecture.md)
for the intended adapter boundary and next steps. For lower-level integration,
`WritingDocument`, `Snapshot` and `Bookmark` are exported separately.

`session.flush()` starts a paused analysis immediately and resolves after that
analysis, not after dependent correction requests/follow-ups. `reset()` cancels
pending work and adopts current host text with empty history. Undo/redo cancels
pending work and leaves the user's decision alone until the next edit. `destroy()`
is idempotent and prevents later callbacks.

## Behavior and limits

- User text appears immediately. Each committed edit triggers analysis; at most
  12 analyses and 3 word corrections are in flight. A pause checks the final word.
- Stable character IDs let useful results survive continued typing. Manual edits,
  undo and composition invalidate conflicting results. Deleting an automatic
  space blocks that boundary until the underlying text is replaced.
- The rolling window is at most 64 raw characters, plus bounded surrounding
  context and up to six word candidates. Large pastes are analyzed near the caret,
  rather than rewritten in full. This is designed for short prose input; the
  current document/history implementation is not optimized for very large files.
- A ranked English vocabulary proposes segmentations. Jev chooses among them;
  the dictionary alone never inserts spaces. A boundary is inserted at probability
  ≥0.65 and removed at ≤0.25; intermediate evidence retains the existing choice.
- Typo probability ≥0.85 or missing-apostrophe probability ≥0.8 can trigger Luna.
  Luna returns one corrected word or `null`. The built-in server rejects rewrites,
  multiword output and changes beyond a small spelling edit distance.
- Sentence capitalization is local and optional. Other scripts are preserved but
  currently have no spacing dictionary. Ambiguous words and names can be wrong;
  every automatic edit can be undone.
- A provider failure leaves the input usable and is surfaced through `onError`.
  Transient analysis failures get a bounded retry; rate-limit responses back off.

## Data and licensing

The default provider sends bounded text windows to TypeSafe and selected words
plus context to OpenAI. OpenAI Responses requests use `store: false`. The library
has no database, telemetry, analytics or persistence. A custom provider controls
its own data handling. Tests use mocks and need no keys or paid API calls.

The project uses the existing [Apache-2.0 license](LICENSE). The vocabulary is
derived from [Wordninja](https://github.com/keredson/wordninja), with its MIT license
retained in [WORDNINJA-LICENSE](src/server/data/WORDNINJA-LICENSE) and in packages.

Provider references: [TypeSafe API](https://docs.typesafe.ai/api),
[Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
