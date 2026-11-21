---
description: "Document domain for Matter (ctx.documents): all 25 authoritative DocProps fields, a blocks-slot body persisted as flat {props, blocks}, and every durable write projected into the activity journal."
kind: "package-reference"
---

# @matter/document

English | [中文](README.zh.md)

## Summary

`@matter/document` is the E-2 business domain of the P2 entity layer. Its `DocProps` schema carries all 25 authoritative fields measured from `fieldsForDomain('documents')`, each with `.meta({ writable, widget, indexable })`. Its body lives in a blocks slot, not a `body` string: the table declares `@matter/blocks`' `BlockArray` as `blocksSchema`, so each stored record is the flat `{props, blocks}` shape (ISS-525). The package mounts `ctx.documents` as the single write path and projects every durable change into the activity journal, following the E-0/E-1 assembly.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Import the schema and validate at the boundary. The record value is `{props, blocks}` — props and blocks are flat siblings, not nested.

```ts
import { DocProps, BlockArray, DOCUMENT_TABLE, DocumentDomain } from "@matter/document"

const props = DocProps.parse({
  id: "DOC-1", title: "first", author: "linmo",
  created: "2026-11-20T00:00:00Z", updated: "2026-11-20T00:00:00Z",
})
const blocks = BlockArray.parse([{ id: "b1", type: "paragraph", rich: [{ text: "hello" }] }])
console.log(DocumentDomain.name, DOCUMENT_TABLE, props.title, blocks.length)
```

Assembly is four plugins; file order does not matter — each gates on a service key via `ctx.inject`:

```ts
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: "/var/lib/matter/records" })
await ctx.plugin(StorageDomain, { backend: "json" })
await ctx.plugin(Journal, { root: "/var/lib/matter" })
await ctx.plugin(Document)
```

Then write through `ctx.documents`:

```ts
const created = await ctx.documents.create({ props, blocks })
await ctx.documents.update("DOC-1", { blocks: [/* new block array */] }, { actor: "linmo" })
ctx.journal.list({ entity: "documents/DOC-1" }).rows
// -> created · body-change（payload: { field: "blocks", fromHash, toHash, blockDelta }）
```

### What you get

- **All 25 fields are built.** No "core subset": the schema mirrors `fieldsForDomain('documents')`, with each field's write tier, widget and index flag on the schema itself.
- **The body is a block tree.** `BlockArray` validates the 28-type discriminated union at the durable boundary; a leaf with `children` is a validation error, and a bad block on disk rejects `open` with `invalid-record`.
- **Flat `{props, blocks}` on disk.** One JSON document per record, with props and blocks as sibling keys — no wrapper beyond the backend's `{version, record}` envelope.
- **Audit comes from the diff.** `update` compares the previous snapshot: blocks emit `body-change` (fingerprint only, never the body), `status` emits `status-change`, other props emit `field-change`.

### Failures and recovery

| Error | When | Fix |
|---|---|---|
| `ZodError` | a value breaks the schema (bad enum, malformed date, unknown key, bad block) | fix the value; `error.issues[].path` says which field |
| `DocumentExistsError` | `create` on an id that already exists | use `update`, or pick another id |
| `DocumentNotFoundError` | `update` on an absent id | `create` first, or check with `get` |
| `invalid-record` (domain) | a stored record fails its schema on reopen | repair the on-disk document; `open` rejects the whole domain otherwise |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design concept

The E-2 domain is the first consumer of the ISS-525 blocks slot. `domainTable<string, DocProps, BlockType[]>(DocProps, BlockArray)` makes `B` non-`never`, so `TableValueOf` derives `{props, blocks}` while E-0/E-1 tables (no `blocksSchema`) keep their bare-props shape byte-for-byte. The facility's `parse` validates the whole flat record; its key is `record.props.id`.

`domain/changed` carries only the new value, so the diff is computed inside the write chain where the previous version is still in hand. The ordering is load-bearing: a `domain/changed` listener observes the journal before the audit row exists; writing the audit first would leave a row for a write the backend rejected.

### Source map

| File | Holds |
|---|---|
| `src/spec.ts` | `DocProps` (25 fields + `.meta()`), vocabularies, `BlockArray`, `DocRecord`, `DocPatch`, `DocumentDomain` |
| `src/events.ts` | event names, `diffEntries`, `blocksFingerprint`, `documentEntry` |
| `src/index.ts` | `DocumentsFacility` (`ctx.documents`), `openDocuments`, `apply`, the two domain errors |

### Why id is a bare string key

`@matter/storage`'s brand module exports only `IssueId`; a `DocId` brand would have to be added to that P1 package, which is outside this package's write scope. The key is therefore a plain `string`, while the schema's `id` field still carries `.meta({ branded: "DocId" })` so a UI can read the intent. Adding the branded type is deferred until the storage seam is reopened.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **PATCH replaces `props` / `blocks` as whole slots.** `DocPatch` does not deep-merge individual props fields; changing one property means passing the full props object. Deep PATCH needs a writer with a real consumer first.
- **Block-tree algorithms and rendering are not here.** Traversal, reference resolution, sync propagation and renderers are E-3b / P3 work; this package only stores and validates blocks.
- **No migration of legacy frontmatter.** A stored document that fails the 25-field schema rejects `open`; there is no rewrite-to-current-shape path yet.
- **`update` is read-modify-write, not compare-and-swap.** One facility serialises its own writes; two processes sharing the same medium are not protected because the layer below offers no CAS.
- **Audit failure does not roll back the record.** A failed journal append logs a warning; the record stays written. Rolling back a durable write to keep the audit complete was judged the worse direction.
