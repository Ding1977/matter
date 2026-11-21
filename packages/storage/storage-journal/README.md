---
description: "Activity journal seam for Matter: ctx.journal — append-only event log with idempotent uid, plus derived full-text search and edge views. Owns its own SQLite database; imports nothing from the storage hub."
kind: "package-reference"
---

# storage-journal

English | [中文](README.zh.md)

## Summary

`storage-journal` is the **activity journal seam**: an append-only event log (`activity_log`) plus two views derived from it — full-text search (`pm_search`, FTS5 with the trigram tokenizer) and edges (`edges`, projected from `relations` / `parent` / `blocked_by`). It mounts `ctx.journal` and opens its own SQLite database. It is deliberately **not** a facet on the storage hub: the hub's KV facet hardcodes `key`/`value` columns and keeps its handle private, so a journal, a search index, and an edge table have nowhere to live there.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Give it a directory; it keeps `journal.db` there.

```ts
// Assembly: one plugin, one config field. `root` has no default on purpose —
// falling back to process.cwd() scatters databases wherever the process happened to start.
plugins:
  - id: storage-journal
    config:
      root: /var/lib/matter
```

Then append, read, and search through `ctx.journal`:

```ts
const seq = ctx.journal.append({
  entity: 'issues/2026-11-16-ISS-1.md',
  event: 'issue-noted',
  actor: 'linmo',
  mdAt: '2026-11-16T12:50:49.694Z',   // the sidecar's own timestamp; part of the identity
  body: 'PM 调度器与事件流',
})

ctx.journal.list({ since: seq, entity: 'issues/2026-11-16-ISS-1.md' })
ctx.journal.rebuild()                    // regenerate both derived views from the truth source
ctx.journal.search({ query: '调度器' })   // FTS5 trigram; falls back to LIKE under 3 characters
ctx.journal.inboundEdges('ISS-501')     // who points at me
```

### What you get

- **Idempotent append**: `append` writes one `INSERT ... ON CONFLICT(uid) DO NOTHING`. Running the same event twice leaves one row and returns the same `seq`. Re-running a migration cannot produce a second copy.
- **A cursor, not a list**: `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so `list({ since })` is a real replay cursor rather than a full read.
- **Two disposable views**: `search` and `edges` have no independent contract and no independent version axis. `resetDerived()` drops both; `rebuild()` brings them back from `activity_log` alone.
- **Failures that stay loud**: a closed handle throws `closed` instead of returning empty collections; a foreign database file is refused with `foreign-database` instead of being claimed.

### Failures and recovery

| Code | When | Fix |
|---|---|---|
| `foreign-database` | The file's `application_id` belongs to another application, or the file has user tables but no identity | Point `config.root` at a directory this package owns |
| `closed` | Read or write after `close()` | The handle is dead; open a new facility |
| `malformed-event` | `append` without a non-empty `entity` or `event` | Caller bug — supply both |
| `io` | Filesystem or engine failure (directory cannot be created, file cannot be opened) | Fix the path or its permissions |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design concept

One truth source, two derived views, and the version axis kept off the one column the neighbouring SQLite package already owns.

`activity_log` is the only non-rebuildable data in this seam. `pm_search` and `edges` are projections of it: the FTS5 table keys its rows by `activity_log.seq` (`rowid = seq`), so "is the index consistent?" is a single set difference rather than bookkeeping across two identifiers. `edges` is recomputed last-write-wins over the payloads of `relations` / `parent` / `blocked_by`, which answers "who points at whom **now**" rather than "who ever pointed".

Version identity is `PRAGMA application_id = 0x4d4a524e`, not `user_version`. The neighbouring SQLite backend rejects any `user_version` outside `0` and `1`; sharing that column would mean two packages writing one axis, and the collision is silent — each side reads a value it considers legal.

### Source map

| File | Holds |
|---|---|
| `src/index.ts` | `name` / `inject` / `Config` / `apply` + `JournalFacility` (append, list, search, edges, rebuild) |
| `src/schema.ts` | Open sequence, `JOURNAL_APPLICATION_ID`, `JOURNAL_SCHEMA_VERSION`, `resetDerivedSchema` |
| `src/journal.ts` | `appendJournal` (the only INSERT), `listJournal`, `activityUid`, `stablePayload` |
| `src/search.ts` | FTS5 projection, `rebuildSearch` / `reconcileSearch`, `searchText`, `toMatchQuery` |
| `src/edges.ts` | Edge projection from the three payload fields, plus forward and reverse queries |
| `src/error.ts` | `JournalErrorCode` (4) + `JournalError` |

### Why trigram, and why a LIKE fallback

FTS5's default `unicode61` tokenizer treats a whole run of CJK as one token, so Chinese substrings match nothing. `trigram` slices by three characters, which makes both Chinese and English substrings findable. The cost is that a query must be at least three characters; two-character Chinese words ("派单", "审查") are common, so shorter queries fall back to `LIKE` inside the same database rather than degrading to a full scan in JavaScript.

### Why the uid algorithm is copied character for character

`activityUid = sha1(entity|event|md_at|stable_payload)` is taken verbatim from the previous tree's `pm-store.js`. It is the only guarantee that a repeated import produces no second row. `tests/journal.test.ts` pins four golden vectors whose expected values were computed by loading the old module, so any drift in the separator, the field order, or the `""` default fails a test instead of quietly duplicating history.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No migration script.** This package creates empty databases only. Importing the previous tree's 18k events is a separate phase; the tests never read a production database.
- **`edges` covers three fields, not four.** `relations`, `parent`, and `blocked_by` are projected. Whether `project` or `subtasks` belong in the edge table is an open question — the previous tree stores both as scalars, and guessing would produce a table nobody can trust.
- **`rebuild()` is O(events), not incremental.** The seam's scale is thousands to tens of thousands of events. An incremental sync would introduce a new class of bug (edge table drifting from the event stream) in exchange for latency that has not been shown to matter.
- **Only comment bodies enter the search index.** State changes are indexed by their `event` and payload scalars, not by re-slicing the whole entity, so writing one comment does not reindex a document.
- **`inject` is empty by design.** This package depends on neither the storage hub nor any backend, so it activates unconditionally. That is the definition of "another seam", not an oversight.
- **No cross-process change notification.** `append` returns a `seq`; pushing it to other processes is a later phase.
