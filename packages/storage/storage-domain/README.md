---
description: "Domain data form for Matter: ctx.storage.domain / ctx.storageDomain — schema-validated, change-emitting KV domains over storage backends."
kind: "package-reference"
---

# @matter/storage-domain

English | [中文](README.zh.md)

## Summary

`@matter/storage-domain` is the **third corner** of the storage seam: the data form (consumer). It mounts one facility that turns a backend's opaque KV unit into a **schema-validated, change-emitting domain** — zod validation at the durable boundary, one write chain per domain, and a `domain/changed` event after every durable write. It provides **two Context keys holding the same object**: `ctx.storageDomain` (service key, so `ctx.inject` can gate on it) and `ctx.storage.domain` (hub form key, so consumers read it through the hub). Mount it when a package keeps records that must survive a restart with a checked shape.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Declare a domain once; the runtime and the type surface both derive from it.

```ts
import { z } from "zod"
import { defineDomain, domainTable } from "@matter/storage-domain"

const spec = defineDomain({
  name: "demo",
  version: 1,
  global: { schema: z.object({ theme: z.string() }), initial: { theme: "plain" } },
  tables: { items: domainTable<string, { label: string; count: number }>(
    z.object({ label: z.string(), count: z.number().int() }),
  ) },
})
```

Assembly: the Definition first, then a Provider, then this package. The order **in the assembly file does not matter** — `apply` declares `ctx.inject([storage.backend.<name>])` for every backend its config mentions, so the facility activates only once those keys exist.

```ts
import { storageBackendServiceKey } from "@matter/storage"

// rows: Storage (definition) → storage-json (provider) → storage-domain (this)
const domain = await ctx.storage.domain.open(spec)
await domain.table("items").put("a", { label: "first", count: 1 })
ctx.on("domain/changed", (change) => { /* push to peers, invalidate a cache, … */ })
```

### What you get

- **Validation at the durable boundary**: a stored record that fails its zod schema rejects the whole `open` with `DomainError('invalid-record')` carrying `detail: { table, key }` — not a silent skip.
- **One write chain per domain**: `update`'s transform runs at its queue slot, so 50 concurrent increments land 50. The unit contract explicitly does not serialize writes; this package is what does.
- **Emit after durability, never before**: every event carries the new value only, in write order.
- **Quarantine on an unknown medium**: if a backend reports `unknown-state`, reads and later writes reject with that error instead of serving memory that may no longer match the medium. `close()` still works.

### Failures and recovery

| Code | When | Fix |
|---|---|---|
| `already-open` | opening one domain name twice on a facility | one `open` per name; `close()` frees it |
| `facet-unsupported` | routed backend has no `kv` facet; or `config.backend` is empty | route to a backend that serves `kv` |
| `invalid-record` | a stored record/global fails its schema | fix the data, or declare `invalidRecords: 'backup-and-skip'` for disposable data |
| `missing-key` | `update` on an absent record | `put` first, or check with `get` |
| `closed` | read/write after `close()` | the handle is dead; reopen the domain |

Backend failures (`backend-not-found`, `version-mismatch`, `malformed-medium`, `unknown-state`) pass through as `StorageError` — this layer does not rewrap them, so a consumer switching on `code` can tell which side broke.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design concept

The unit contract (`@matter/storage` `src/backend.ts`) says plainly that a `KvUnit` **does not serialize concurrent writes** — ordering is the caller's job. This package is that caller: each domain owns a promise chain, every write is a job on it, and the job awaits durability **first**, then mutates memory, then emits. A rejected backend write therefore leaves memory untouched, so reads and the medium never diverge.

### Source map

| File | Holds |
|---|---|
| `src/index.ts` | `name` / `inject` / `Config` / `apply` + `DomainFacility` (routing, open, snapshot validation) |
| `src/spec.ts` | `DomainSpec` / `defineDomain` (four load-time checks) / `domainTable` / `descriptorOf` |
| `src/domain.ts` | `DomainImpl` — write chain, drain barrier, quarantine |
| `src/table.ts` | `KvTableImpl` + the `TableHost` seam it shares with `DomainImpl` |
| `src/events.ts` | `DomainChanged` closed union + the `domain/changed` declaration merge |
| `src/error.ts` | `DomainErrorCode` (5) + `DomainError` with `detail` |

`table.ts` is split out of `domain.ts` for the 400-line file ceiling, not because the two halves have different owners.

### Why `deleteMany` writes memory in one pass and emits in another

The batch is one job on the chain. Memory is brought to the **committed batch state** before the first listener runs, so every `domain/changed` observes the same removed set as the medium. Emitting inside the delete loop would let the first listener read a *prefix* state (`b` and `c` still present) — a discrepancy that throws nothing and shows up only as a consumer's stale cache.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Only `per-record` layout is real.** `defineDomain` rejects `layout: 'single'` at load time rather than accepting a declaration the provider does not read — accepting it would let the declared shape and the on-disk shape diverge silently. There is no consumer for `single` in this repo (ISS-510).
- **`compatibleVersions` is document-granular here.** `@matter/storage-json` reads a document whose version it does not accept as *absent* (dropped, not migrated), rather than rejecting the whole unit. Old unlisted records therefore go silently missing on load — that is the per-record contract, not a bug, but do not read it as a migration.
- **Config validation is hand-rolled, not schemastery.** That package is not installable in this repo (P0 decision), so `Config` is a plain TS interface plus `normalizeConfig()` at load time. Validation strength is equivalent for the two fields that exist; it is not a general schema.
- **`ctx.emit` is as far as change push goes.** Cross-process RPC frames for `domain/changed` are a later phase; today a listener runs in-process only.
- **No cross-restart repair.** A record that fails its schema rejects `open` (or, under `backup-and-skip`, is moved aside and logged). Nothing rewrites it into the current shape.
- **The write chain is per domain, not per table or per key.** Two hot keys in one domain serialize; if that becomes the bottleneck, the split belongs in a later issue with a measurement, not here.
