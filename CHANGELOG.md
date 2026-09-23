# Changelog

## 0.2.0

- Port contextual typo detection (completed words ≥0.65; unfinished final words ≥0.85) and GPT-6 Luna.
- Add paused sentence review and bounded full-text review with up to six exact repairs per response, rechecks, and a shared three-call document correction budget.
- Improve spacing candidate coverage, contextual alternative comparisons, and guarded ambiguity repair.
- Add optional local smart apostrophes, quotation marks and ellipses, preserving technical spans and undo/caret behavior.
- Preserve stale-result checks across append, edit, reset, composition, undo and teardown.
- Add independent Retry-After backoff, extended HTTP review modes and a host quota-reservation hook.
- Export an optional Node SQLite limiter with persistent per-IP/site budgets and concurrency caps.
- Keep the existing provider methods, headless/DOM adapters and initial-text document constructor. New provider capabilities are optional. See the integration guide for opt-outs and new callback reasons.

## 0.1.0

Initial headless library, native-control adapter, HTTP transport and optional Jev/Luna server provider.
