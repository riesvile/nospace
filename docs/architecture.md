# Architecture

`nospace` is a headless editing tool. Applications supply the UI, backend,
credentials and policy for when text may be sent to a provider.

```text
Your input / editor
        ↕ text + selection + user events
Editor adapter                 @riesvile/nospace/dom (optional)
        ↕
Editing engine                 @riesvile/nospace
        ↕ analyze / correct
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
| `@riesvile/nospace` | Document identities, selection mapping, history, request scheduling, provider contract, HTTP client | DOM, Svelte, styles, credentials, vocabulary |
| `@riesvile/nospace/dom` | Native input/textarea events, IME, selection, cleanup, form reset | Layout, focus policy, typography, network configuration |
| `@riesvile/nospace/server` | Candidate vocabulary, Jev/Luna adapters, validated Web request handlers | Environment loading, routing, account authentication, deployment |

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
word boundaries.

The adapter must apply a change synchronously so its next `getState()` returns the
new text. The engine will refuse to write if the host text has changed without a
matching `input()`/`reset()`. Provider cancellation is best effort; every response
is guarded even if a custom provider ignores its AbortSignal.

This first release uses the library's undo history. A rich-text editor with its
own history should use `WritingDocument` primitives to map changes into native
transactions, or supply a dedicated integration. Do not rewrite `innerHTML` from
a plain string: marks, embedded content, collaborative positions and history need
editor-specific mappings.

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

The 0.1 API deliberately makes providers replaceable without claiming automatic
compatibility with every editor or every language.
