---
description: "Per-record JSON storage backend for Matter: one human-readable document per record under a configured root, registered as backend `json` on ctx.storage."
kind: "package-reference"
---

# @matter/storage-json

English | [中文](README.zh.md)

## Summary

`@matter/storage-json` is the **Provider** role of the storage seam. It owns one medium — a directory tree under a configured `root` — and serves the `kv` facet of `ctx.storage.backend` under the name `json`. The default on-disk layout is **`per-record`**: `<root>/<unit>/<table>/<key>.json`, one document per record, plus `<root>/<unit>/global.json` for the global slot. A unit declaring `layout: "single"` instead keeps its whole state in one document `<root>/<name>.json` (used by `views.json`, ISS-535). Every write publishes by atomic rename; `per-record` rewrites one record, `single` rewrites the whole document.

Mount it whenever a composition persists application data through `ctx.storage`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

### What you get

A `StorageBackend` registered as `json`, plus a lifecycle-only service key `storage.backend.json` that domain-form providers inject so activation cannot race backend registration.

```ts
import { apply as jsonStorage } from "@matter/storage-json"

await ctx.plugin(jsonStorage, { root: "/var/lib/matter/storage" })
const backend = ctx.storage.backend.get("json")
const unit = await backend.kv!.open({ name: "pm_issue", version: 1, tables: ["issues"], hasGlobal: true })
```

`root` has **no default on purpose**: a `process.cwd()` fallback would scatter unit files wherever the process happens to start. A missing or non-string `root` fails at load time instead of silently skipping.

### Failures and recovery

| Situation | Behaviour |
|---|---|
| A record document is malformed | That record reads as **absent**; the rest of the unit is unaffected |
| A record document is stamped with an unaccepted version | That record reads as **absent**. It is **not** migrated and its bytes stay on disk |
| A record key is not path-safe | Rejected **before writing** (`[a-zA-Z0-9_-]+`) |
| A batch delete cannot restore its staged documents | The unit rejects with `unknown-state`; every later call rejects until `close()` |
| A write fails mid-flight | The temporary file is removed and the previous document survives intact |

The distinction that matters: **per-record discards, whole-unit refuses.** Because there is exactly one document per unit in the `single` layout, a bad file there must reject loudly; in this layout one bad record must not brick the unit, so it reads as absent. That asymmetry is the contract, not an oversight.

## Understand the implementation

### Design concept

**The directory is the state.** `loadAll()` re-reads the tree on every call and the unit holds no in-memory records — the live tables belong to the domain layer, which seeds them from the open-time `loadAll()` and serializes writes through its own write chain. A cache here would drift from the disk, and "the directory is the data" is the whole point of this layout.

Writes are atomic: same-directory temp file → `sync()` → `rename()` → fsync of the parent directory. Rename is an atomic replace on POSIX and on Windows, and replacement (not no-clobber) is the correct semantics because one unit document has exactly one writer.

### The atomic publish protocol

1. `open(<tmp>, 'wx', 0o600)` in the **same** directory as the target, so the rename never crosses a filesystem.
2. `writeFile` then `handle.sync()` — the bytes reach the platter before the name is published.
3. `rename(tmp, target)` — readers see either the old document or the new one, never a partial write.
4. `fsyncDirectory(dirname)` on POSIX — the new directory entry survives a crash.

Any error path removes the temp file, so a crash leaves no half-written document and no `.tmp` residue.

### Batch delete: stage, then clean up

Documents are renamed to `<key>.json.deleting` first; only once the whole batch is staged are they unlinked. The renames already hide the batch from readers, so the unlink is cleanup — and a failed unlink leaves an unreadable file rather than a readable entry. If staging fails, the staged renames are rolled back; if the rollback itself fails, readable state is unknown and the unit is quarantined with `unknown-state`. A half-deleted state is worse than an undeleted one.

### Source map

| File | Responsibility |
|---|---|
| `src/index.ts` | `name` / `inject` / `Config` / `apply`, `JsonStorageBackend`, descriptor validation, `layout` dispatch |
| `src/per-record-unit.ts` | `PerRecordJsonUnit` + `openPerRecordUnit`; tree read, put, batch delete, backup |
| `src/single-unit.ts` | `SingleJsonUnit` + `openSingleUnit`; whole-unit in-memory state, whole-file atomic publish |
| `src/atomic.ts` | `writeAtomic`, `fsyncDirectory` |
| `src/format.ts` | whole-unit `{unit, global, tables}` serialize / parse + per-record `{version, record}` serialize / parse |

`apply()` unregisters the name **before** closing the medium. Reversing the two opens a window where a concurrent writer still resolves the backend out of the registry and finds it closed — which surfaces as an occasional `closed` error, not a crash.

## Known Limitations and Deferred Work

- **Both `per-record` and `single` layouts exist.** `descriptor.layout === "single"` opens one whole-unit document `<root>/<name>.json` (`single-unit.ts`); the default (including `undefined`) stays `per-record`. `single` was deliberately skipped under ISS-510 because no consumer needed it; ISS-535's `views.json` (`@matter/issue` view configs, stored whole in the global slot) is now that consumer, so the decision is **superseded** — the whole-unit `serialize`/`parse` and `single-unit.ts` were ported back from DSH. All other semantics (atomic whole-file publish, corrupt file rejects loudly) match the DSH precedent.
- **No legacy bootstrap.** DSH migrates a pre-per-record whole-unit file (`<root>/<name>.json`) into the new tree on first open. Matter never shipped that layout, so there is no old data to migrate. (The `single` layout written by ISS-535 uses the same filename, but is self-describing via its unit header and needs no migration.)
- **Keys are path segments.** `ISS-506` passes `SAFE_KEY_RE` but a unit or table name must also pass `UNIT_NAME_RE` (`[a-z][a-z0-9_]*`) — so an issue id can be a record key but never a unit name.
- **The unit does not serialize concurrent writes.** Write ordering is the caller's responsibility; the domain layer runs one write chain per unit.
- **The shared conformance suite asserts `single`-layout semantics in three cases** (unsafe keys round-trip; an unaccepted version rejects on open). Those conflict with this backend's contract by design and are tracked on ISS-510 rather than worked around here.
