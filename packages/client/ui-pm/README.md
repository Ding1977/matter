# @matter/client-ui-pm

## Summary

`@matter/client-ui-pm` is Matter's issue list skeleton (ISS-540), the fourth client package. It renders injected issue rows driven by a `ViewConfig` read from `@matter/issue`'s `ViewConfigStore` — a real consumer, not a parallel store. Three layers — `contract/`, `list/`, `detail/` — are assembled by `apply.ts`. Product text uses a typed locale dictionary (i18n gate active). The list reuses the 2305 primitive seat (`Button`); its `--dsw-alias-*` tokens come from ui-theme's host-installed bridge, so the package ships no private CSS and imports no sibling UI package. Coverage threshold is 100% — the second client package above the 80% baseline.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Import the client surface from `@matter/client-ui-pm/client`: `IssueList`, `IssueDetail`, `resolveMessages`, `orderRows`, and the `IssueRow` / `IssueListModel` contracts. The mounting party reads a `ViewConfig` from `ViewConfigStore.list()/get()`, projects issue records into `IssueRow[]`, and passes both to `IssueList` as props. The host half exposes an empty cordis plugin entry.

## Understand the implementation

The package has a dual-plane tsconfig (host half = empty plugin entry; client half = DOM lib + jsx, three layers). The list applies the configuration's basic shape — view name as title, `type` / `group` / `filter` as data attributes, first `sort` rule as row order; unknown fields fall back to an empty string. ViewConfig type comes from `@matter/issue`; no parallel store is created. The soul test opens a real `ViewConfigStore` over a fake KV unit, reads a `ViewConfig`, and asserts the rendered DOM carries that configuration and the issue rows.

## Known Limitations and Deferred Work

- This is a skeleton: only the list shape is wired; two full views (list + table) and switch/persistence land in the next issue (#5).
- No visual shell or screenshot in this issue; real-machine visual evidence is deferred to the P4 shell.
- The issue row is a minimal display projection, not the full `IssueProps` schema.
