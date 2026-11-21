---
description: "Storage seam definition for Matter: the ctx.storage service holding a named backend registry. Performs no IO."
kind: "package-reference"
---

# @matter/storage

English | [中文](README.zh.md)

## Summary

`@matter/storage` is the **Definition** role of the storage seam. It contributes the `ctx.storage` service: a named backend registry (`ctx.storage.backend`) plus a mountable data-form table (`ctx.storage.mount` / `ctx.storage.form`). It performs **no IO** and has **no `Config`** — media live in a Provider such as `@matter/storage-json`, semantics live in the domain layer. Without any Provider mounted the service is still complete and usable: the registry is simply empty. Mount it whenever any composition persists application data.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the Definition first; providers register themselves into it.

```ts
import { Context } from "@deepseek-ai/cordis"
import Storage from "@matter/storage"

const ctx = new Context()
await ctx.plugin(Storage)

ctx.storage.backend.names() // [] until a provider registers
```

A provider registers a backend under a name and returns the disposer:

```ts
const dispose = ctx.storage.backend.register("json", backend)
```

Which backend serves which consumer is the **consumer's** configuration, never a hub-global choice — several backends stay mounted side by side.

### What you get

- A typed `ctx.storage` with no configuration surface to get wrong.
- Registration as an effect: `register()` / `mount()` return disposers, so unload is automatic with the owning fiber.
- Fail-loud misconfiguration with a stable `StorageError` code instead of a silent no-op.

### Failures and recovery

| Code | When | Fix |
|---|---|---|
| `backend-not-found` | resolving a name nobody registered | mount the provider package, or fix the configured name |
| `duplicate-backend` | the same name registers twice | a composition bug — two providers claim one name |
| `form-not-mounted` | reading a form before its owner mounts it | order the rows: form owner before consumer |
| `duplicate-mount` | the same form key mounts twice | one owner per form |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The hub is a pure registration table with two faces.

### Design concept

- **The Definition owns the contract, not the medium.** Zero IO and zero `Config` are deliberate: every medium parameter belongs to the Provider, so the hub cannot acquire a media dependency by accident.
- **Registration is an effect.** Both `register()` and `mount()` return disposers that remove *only their own contribution*.
- **Forms are a mergeable table.** `StorageForms` is an empty interface that form owners extend via declaration merging; the hub never enumerates the domain's keys.

### The stale-disposer guard

Both maps use the same identity check before deleting:

```ts
if (this.backends.get(name) === backend) this.backends.delete(name)
```

This is not defensive coding. When a Provider's fiber remounts, the **old** disposer can run **after** the new registration. Without the identity check the old disposer removes the new backend, and the symptom is "registration reported success but the backend cannot be found" — no error, no crash, just missing data. `tests/storage.test.ts` covers exactly this ordering.

### The backend contract

[`src/backend.ts`](src/backend.ts) is the normative contract for provider implementers; the shared suite in [`tests/contract.ts`](tests/contract.ts) checks it. A provider owns one medium and exposes optional data-shape facets; `kv` is the only facet today. `runKvBackendContract(label, create)` is called from the provider's own spec file — this is how the seam's third leg is verified, not by an interface declaration.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Storage` service, `StorageForms`, `storageBackendServiceKey` |
| [`src/registry.ts`](src/registry.ts) | `BackendRegistry`: name → backend, registration disposers |
| [`src/backend.ts`](src/backend.ts) | The contract: `UNIT_NAME_RE`, facets, units |
| [`src/error.ts`](src/error.ts) | `StorageError` and its stable codes |
| [`src/brand.ts`](src/brand.ts) | Branded ids (compile-time only, no format validation) |
| [`src/types.ts`](src/types.ts) | Type-only surface, zero runtime |
| [`tests/contract.ts`](tests/contract.ts) | Shared conformance suite, called by the provider |

</details>

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **This package performs no IO and has no `Config`.** There is nothing to configure here: every medium parameter (root directory, file mode, layout) belongs to the Provider. If you are looking for where data physically goes, you are in the wrong package.
- **`UNIT_NAME_RE` is `^[a-z][a-z0-9_]*$`, so an entity id cannot be a unit name.** A Matter entity id such as `ISS-506` satisfies the per-record key rule `[a-zA-Z0-9_-]+` and therefore works as a **record key**, but it fails `UNIT_NAME_RE` (uppercase letters and hyphens) and is rejected as a **unit or table name**. Unit names must be snake_case: `pm_issue`, not `pm-issue`.
- **`kv` is the only data shape.** The `log` facet for session event logs is not implemented and has no consumer yet.
- **Branded ids do not validate format.** `issueId()` is an identity cast; a malformed string is admitted and only fails later at a zod boundary. Format checking belongs to the business package that owns the id, not to the seam.
- **`mount` / `form` have no consumer in P0.** The domain layer (`ctx.storage.domain`) arrives with `@matter/storage-domain`; until then these methods are exercised only by this package's own tests.
