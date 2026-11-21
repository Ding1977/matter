# @matter/document-controller

## Summary

`@matter/document-controller` is the first package in Matter's api group: the document domain's `@Remote` host Service. It extends `TypertRemoteService` and declares three endpoints — `list`, `get`, `update` — over `ctx.documents`, the document facility that owns the single write path and the activity journal. The shape is isomorphic to DSH's session-controller (`super(ctx, 'document')`, `@Remote('...')` decorators, exact `@deepseek-ai/dsh-typert-protocol@0.2.2-rc.2`), so wiring the P4 gateway needs no rework. It does not include typert-generator: P3 has no cross-process consumer and the generated artifact would have no reader. The P3 data path is in-process (vitest boots a cordis context); no connection, gateway, or remotes are shipped.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Install as a cordis plugin. The constructor registers the service at `ctx.document`; every read/write goes through `ctx.documents`. Call the three methods directly in-process (P3) or through the future gateway (P4).

## Understand the implementation

The package is a host-only half with a single tsconfig — no DOM, no client half. `@Remote` decorators are standard TypeScript decorators lowered by tsdown in the build and by a pre-transform plugin in the test runner. `get` on a missing id throws a declared `RemoteError('document/not-found')`.

## Known Limitations and Deferred Work

- No typert-generator wiring or `./remote` artifact; the P4 gateway single owns it.
- No connection / gateway / remotes in P3 — in-process only.
- `list` reads all rows (optional id-prefix filter); no pagination until a real consumer needs it.
