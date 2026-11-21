# @matter/client-ui-kb

## Summary

`@matter/client-ui-kb` is Matter's minimal knowledge-base page: a doc list plus a detail view that renders a document body. It is the first real consumer of `ui-blocks` (W7) — the detail gets the editor surface only through the `blocks.editor.surface` slot, with zero package imports of ui-blocks. Three client layers — `contract/` (row types + slot key), `list/`, `detail/` — are assembled by `apply.ts`. Styles use ui-theme tokens; product text uses a typed locale dictionary (i18n gate active, no exemption). The P3 data path is in-process (vitest boots cordis); no connection or gateway.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Import the client surface from `@matter/client-ui-kb/client`: `DocList`, `DocDetail`, `resolveMessages`, and the `EDITOR_SURFACE_SLOT` key. The mounting party supplies `loadDoc` (bound to controller.get → ctx.documents) and `renderSurface` (bound to the slot's `renderSlot` prop face).

## Understand the implementation

The package has a dual-plane tsconfig (host half = empty plugin entry; client half = DOM lib + jsx, three layers). Cross-package UI goes only through the slot key — ui-kb neither imports nor re-exports any ui-blocks value. The W7 test boots a cordis context with document-controller + ctx.documents + a registered ui-blocks surface, then asserts the body text appears in the rendered DOM.

## Known Limitations and Deferred Work

- No connection / gateway / remotes in P3 — data is injected in-process.
- The body text projector in the test is a minimal display shape, not the full 28-type block union.
- No visual shell or screenshot in P3; real-machine rendering is deferred to the P4 shell.
