# Integration guide

Type without spaces. Add automatic word spacing to an existing text input while
keeping control of its appearance, state and backend.

**Experimental, English prose.** The core preserves character identities, manual
spaces, selections, composition and undo while asynchronous spacing decisions
arrive. An optional server provider uses Jev to choose spacing and flag likely
typos, and GPT-6 Luna to make small word, sentence and full-text repairs. Smart punctuation runs locally. You can supply your own provider.

This repository contains the library, tests and integration documentation. The
demo website, styles, fonts, analytics and deployment configuration live separately.
There are no runtime npm dependencies. ESM JavaScript and TypeScript declarations
are built into `dist/`.

## Install from GitHub

Requires Node.js 22.12+ for development and the example backend, and a modern browser
for the DOM adapter. The package has **not been published to npm**. The optional SQLite limiter requires Node.js 22.13+; the portable server adapter does not import Node-only modules.

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
  openaiModel: 'gpt-6-luna',
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
requests, propagate cancellation, and return `Cache-Control: no-store`. Both routes also accept the new review modes: the analysis route handles full-text Jev checks, and the correction route handles word, sentence and document repairs. **Mount them behind your application's authentication and rate limits** before exposing a paid provider. Origin checks are not authentication. If the frontend uses a
different origin, pass `{ allowedOrigins: ['https://your-frontend.example'] }` and
handle CORS/preflight in your application. The browser transport supports custom
application headers, credentials and a custom `fetch` function.

For spacing without spelling correction, omit `openaiKey` on the server and
`correctUrl` in the browser. The editor only schedules sentence/full-text corrections when the provider implements the relevant optional methods. The host can also call `provider.analyze()` and
`provider.correct()` directly from its own server routes instead of using the
provided HTTP handlers.

## Optional persistent limits

`createRequestHandlers` accepts a `reserve(operation, request)` hook. It runs only
after validation and before the paid call. Return a release callback for a concurrency
lease; failed/aborted provider calls still consume their reserved usage. Throw the
exported `RateLimitError(seconds)` for HTTP 429 with `Retry-After`. Other reservation
errors fail closed without contacting a provider. You can use this hook with your
existing quota system, including a shared store for multiple application instances.

For a Node server with persistent disk, the demo's SQLite implementation is available
through a separate import. This SvelteKit example gets the client address from the
server framework; apply equivalent trusted connection handling in other frameworks:

```ts
import { createRequestHandlers } from '@riesvile/nospace/server';
import { UsageLimiter } from '@riesvile/nospace/server/node';

// Create once, outside the request handler. Keep this file outside release folders.
const limiter = new UsageLimiter('/var/lib/my-app/nospace-limits.sqlite');

// The analyze route. Use .correct(request) in the matching correction route.
export async function POST({ request, getClientAddress }) {
  const handlers = createRequestHandlers(provider, {
    reserve: (operation) => limiter.reserve(operation, getClientAddress()),
  });
  return handlers.analyze(request);
}
// Close the limiter on graceful application shutdown: limiter.close().
```

Share the limiter/database between both routes. Never trust an arbitrary forwarded-IP
header: your reverse proxy/framework must overwrite and validate it. IPv4 addresses
share one allowance; IPv6 addresses share a /64. People behind the same NAT share a
limit. SQLite is suitable for processes sharing a local persistent file; a multi-host
or ephemeral/serverless deployment should use a shared quota service through `reserve`.
No limiter is enabled automatically, since the library cannot infer your trusted
client identity or persistence location.

| Operation | Per IP/minute | Per IP/hour | Per IP/day | Concurrent per IP |
| --- | ---: | ---: | ---: | ---: |
| Spacing | 1,500 | 20,000 | 50,000 | 12 |
| All Luna corrections | 30 | 150 | 500 | 3 |
| Full-text Jev sections | 30 | 150 | 500 | 1 |

Site-wide limits leave headroom for 100 ordinary visitors; exported `USAGE_LIMITS`
and the `Policies` constructor argument expose the defaults and allow overrides.
The limits count requests, not exact tokens or money. Word/sentence output is capped
at 120 tokens, and full-text repair batches at 480. Counters survive restarts and
releases. Use both host request limits and provider billing controls as appropriate.

## Upgrading from 0.1

Update both browser and server packages to 0.2. The same two URLs support all modes;
no additional route is needed. The `analyze`/`correct` custom-provider methods and
`WritingDocument(initialText)` constructor remain supported. The three new review
methods are optional; providers implementing only the old contract remain supported.

Typography and reviews are enabled by default when supported. To retain the old
behavior while updating a backend separately, set `typography: false`,
`sentenceReview: false` and `documentReview: false` on the editor session. Update
exhaustive switches over change reasons or error operations for the new values.
The default correction model is now `gpt-6-luna`; `openaiModel` remains configurable.

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
    // Optional: async correctSentence({ text, before, after }, signal) { return null; }
    // Optional: async reviewDocument({ text, before, after }, signal) {
    //   return { decision: 'ok', probability: 0.05 }; // probability of needs_update
    // }
    // Optional: async correctDocument({ text, before, after }, signal) { return []; }
  },
  capitalize: true,  // local sentence capitalization
  typography: true,  // curly apostrophes/quotes and ellipses; false for literal inputs
  sentenceReview: true, // needs provider.correctSentence
  documentReview: true, // needs provider.reviewDocument + correctDocument
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
it back would lose structure and editor history. See [architecture](architecture.md)
for the intended adapter boundary and next steps. For lower-level integration,
`WritingDocument`, `Snapshot`, `Bookmark`, `SentenceBookmark`, `DocumentBookmark` and `typographyEdits` are exported separately.

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
  with sentence-completion review covering the whole draft in bounded sections. This is designed for short prose input; the
  current document/history implementation is not optimized for very large files.
- A ranked English vocabulary proposes segmentations. Jev chooses among them;
  the dictionary alone never inserts spaces. Dictionary/prefix candidates have reserved search capacity so unknown fragments cannot crowd every natural phrase out. Paused choices include the visible reading in its sentence context. A boundary is inserted at probability
  ≥0.65 and removed at ≤0.25; intermediate evidence retains the existing choice.
- A completed word is referred to Luna at typo probability ≥0.65. The final word
  keeps ≥0.85; missing-apostrophe checks use ≥0.8. Jev sees the already-spaced
  spelling context. Word corrections remain a single word or `null`.
- A paused sentence with plausibility ≤0.2 can request a minimal repair. The same
  route also resolves competing spacing alternatives when Jev rejects the visible
  reading with high confidence. Phrases are capped at 160 characters and 80 characters
  of context on each side. Moving spaces is allowed; letter edits stay within two.
- A new `.`, `!`, `?`, ellipsis or newline queues a whole-draft check after at least
  900ms of quiet and after fast fixes settle. Sections contain at most 1,200 characters,
  with 160 characters of context. Only a `needs_update` probability ≥0.8 sends a
  section to Luna. Each response may contain up to six small non-overlapping edits.
  Repaired text is rechecked, with at most three document correction requests shared
  across all sections and follow-up passes per sentence completion. One accepted
  batch is one undo step. Rate-limit pauses resume already-reviewed sections.
- Sentence/document repairs preserve wording, informal language, punctuation and
  numbers; ambiguous repairs and broad rewrites are rejected. New typing invalidates
  pending sentence/document snapshots, even when it only appends text.
- Local typography formats apostrophes (`What’s`), paired quotes (`“hello”`) and
  ellipses (`…`). URLs, email addresses, backtick-delimited code and numeric
  measurements keep literal punctuation. It shares the triggering edit's undo step
  and adds no model call. Use `typography: false` for literal input fields.
- Sentence capitalization is local and optional. Other scripts are preserved but
  currently have no spacing dictionary. Ambiguous words and names can be wrong;
  every automatic edit can be undone.
- A provider failure leaves the input usable and is surfaced through `onError` with
  operation `analyze`, `correct` or `review`. Transient analysis failures get a bounded
  retry. Spacing, corrections and document review have independent backoff deadlines.
  The HTTP transport honors `Retry-After` seconds or dates, even from an HTML proxy
  response. Custom providers can throw an error with `status: 429` and `retryAfterMs`.
- `onChange`/`setState` reasons now also include `typography`, `sentence-correction`
  and `document-correction`. Existing `spacing`, `correction`, `capitalization`,
  `undo` and `redo` values are retained.

## Data and licensing

The default provider sends bounded text windows and, when enabled, whole-draft
sections to TypeSafe. Selected words, phrases or flagged sections plus context go
to OpenAI. OpenAI Responses requests use `store: false`. The core and portable server
have no database, telemetry or analytics. The opt-in Node limiter stores counters
and salted network identifiers, never text or provider keys. A custom provider controls
its own data handling. Tests use mocks and need no keys or paid API calls.

The project uses the existing [Apache-2.0 license](../LICENSE). The vocabulary is
derived from [Wordninja](https://github.com/keredson/wordninja), with its MIT license
retained in [WORDNINJA-LICENSE](../src/server/data/WORDNINJA-LICENSE) and in packages.

Provider references: [TypeSafe API](https://docs.typesafe.ai/api),
[Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna),
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
