# Architecture

`nospace` is a headless editing tool. Applications supply the UI, backend,
credentials and policy for when text may be sent to a provider.

```text
Your input / editor
        ↕ text + selection + user events
Editor adapter                 @riesvile/nospace/dom (optional)
        ↕
Editing engine                 @riesvile/nospace
        ↕ analyze / word, sentence, document review
HTTP transport or custom provider
        ↕ application-authenticated requests
Your application server
        ↕
Request handlers + provider    @riesvile/nospace/server (optional)
        ↕ server credentials
Jev / Luna
```

## Boundaries

| Entry | Responsibility | Excluded |
| --- | --- | --- |
| `@riesvile/nospace` | Document identities, selection mapping, history, typography, review scheduling, provider contract, HTTP client | DOM, Svelte, styles, credentials, vocabulary |
| `@riesvile/nospace/dom` | Native input/textarea events, IME, selection, cleanup, form reset | Layout, focus policy, network configuration |
| `@riesvile/nospace/server` | Candidate vocabulary, Jev/Luna adapters, validated Web handlers, quota hook | Node-only modules, environment loading, routing, authentication, deployment |
| `@riesvile/nospace/server/node` | Optional persistent SQLite request/concurrency limits | Client identity discovery, routing, application data |

One package with explicit subpath exports keeps installation simple while keeping
the vocabulary and provider code out of the browser import graph. The package
uses an allowlist of shipped files. Verification walks the browser import graph
and exercises a clean extracted tarball, including the vocabulary. See
[Node's entry point documentation](https://nodejs.org/api/packages.html#package-entry-points)
and [npm's files allowlist](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files).

## Async editing contract

The document stores original UTF-16 units with stable IDs and tracks automatic
spaces separately. Requests capture the relevant IDs, editing epoch and request
sequence. Appending text keeps compatible work alive; replacements, undo, reset
and IME composition invalidate older work. Automatic spacing additionally obeys
request order; a word correction must still match the original letters, IDs and
word boundaries. Sentence and document repairs also capture a document revision: any intervening text change makes them stale. Batch repairs keep identities between changed excerpts and form one undo step.

The adapter must apply a change synchronously so its next `getState()` returns the
new text. The engine will refuse to write if the host text has changed without a
matching `input()`/`reset()`. Provider cancellation is best effort; every response
is guarded even if a custom provider ignores its AbortSignal.

The library uses the library's undo history. A rich-text editor with its
own history should use `WritingDocument` primitives to map changes into native
transactions, or supply a dedicated integration. Do not rewrite `innerHTML` from
a plain string: marks, embedded content, collaborative positions and history need
editor-specific mappings.

## Review and quota boundaries

The engine schedules per-input analysis, paused sentence repair and sentence-completion
full-text review. Optional provider methods keep custom spacing-only providers valid.
Whole-draft review scans bounded sections, caches completed checks across 429 pauses,
and shares a three-correction budget across sections and successful follow-up passes.
It waits for fast corrections to settle and never applies a stale document snapshot.

Spacing, corrections and full-text checks have independent retry deadlines. All Luna
operations use the same host `correct` quota. Full-text Jev checks use `review`, so they
cannot exhaust the keystroke `analyze` allowance. `reserve` runs after input validation
and before a provider call; the optional Node limiter reserves atomically in SQLite.

The browser/core and portable `/server` entry do not import the SQLite limiter. Package
verification traverses both graphs and imports every export from an extracted tarball.

## Repository separation

The existing demo remains an application in its own repository. It can later
install a pinned version of this package, use the DOM adapter, keep its own
resize/scroll behavior, and mount the server handlers with its own environment.
Its homepage, analytics, fonts, domains, service definitions and secrets stay there.

The extraction was copied from source modules rather than copying the demo's Git
history. Only tests and library files are included, together with the existing
Apache license and the vocabulary's MIT attribution.

## Next steps after real integration feedback

1. Make the demo a consumer of a pinned library version and compare live typing.
2. Add focused integrations for the actual editors people use, starting with one
   editor and its transaction/history model.
3. Add measured configuration for thresholds, languages and larger documents
   when usage supports those decisions.
4. Publish versioned npm releases after selecting a stable public API. CI currently
   builds and tests; it does not publish packages or deploy a demo.

The API deliberately makes providers replaceable without claiming automatic
compatibility with every editor or every language.
