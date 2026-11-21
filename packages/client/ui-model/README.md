# @matter/client-ui-model

## Summary

`@matter/client-ui-model` is Matter's minimal model selector seat (ISS-543) — P4's fifth and final client package. It renders a two-level panel — a provider-grouped model list with search keyboard navigation (up/down cycles with wrap-around, Enter accepts, Escape returns) and a model detail level — over a ctx-injected stub directory. Product text uses a typed locale dictionary. The detail back key reuses the 2305 primitive seat (`Button`) with ui-theme tokens, so the package ships no private CSS and imports no sibling UI package. Coverage is 100%. Three management pages are out of scope (P7+); no backend is built (llm domain is P5+).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Import the client surface from `@matter/client-ui-model/client`: `ModelSelect`, `ModelPanel`, `ModelDetail`, `onPanelKeyDown`, `stubDirectory`, and the `ModelRow` / `ModelDirectory` contracts. The mounting party injects a stub directory and a message set via props; `ModelSelect` assembles the two-level panel. The host half exposes an empty cordis plugin entry.

## Understand the implementation

The package has a dual-plane tsconfig (host half = empty plugin entry; client half = DOM lib + jsx, three layers: `contract/`, `panel/`, `apply.ts`). Search, grouping and highlight pure functions live in `contract/`; the `panel/` domain renders the list (provider groups, `aria-activedescendant` focus discipline) and the detail level; `apply.ts` is the only cross-domain assembly point. The keyboard handler attaches to the root section so Escape works in the detail level too. The soul test injects a stub directory through `ModelSelect` and asserts real DOM: provider groups, up/down wrap-around, Enter to detail, Escape back. Model name matching is a case-insensitive ordered subsequence (DSH `ModelSelect.tsx` morphology).

## Known Limitations and Deferred Work

- No backend: the directory is a stub injected by the mounting party; real llm-domain data is P5+.
- Three management pages are not built (P7+); this is a UI seat only.
- No visual shell or screenshot in this issue; real-machine visual evidence is deferred to the P4 shell.
