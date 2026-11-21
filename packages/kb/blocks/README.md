---
description: "Block engine library for Matter's knowledge base: a 28-type zod discriminated union with container/reference validation and V5 (leaf blocks forbid children), plus the runtime half — walk, index and reference extraction over the block tree, and view-query predicates. Data, helpers and pure algorithms; no rendering."
kind: "package-reference"
---

# @matter/blocks

English | [中文](README.zh.md)

## Summary

`@matter/blocks` is the block engine library of Matter's knowledge base. The schema half (P2) is a zod discriminated union over all 28 `BlockType`s with the container/reference vocabularies and V5 at the boundary; the runtime half (P3-B1) adds three pure algorithms on the same package: `walkBlocks` (DFS pre-order with a 256 depth ceiling), `indexBlocks` / `extractReferences` (id→path index and four reference tiers over one traversal), and `evaluateViewQuery` (filter AND / sort / limit predicates with caller-injected field metadata). Still a plain library — no rendering, no ctx key, no executor assembly.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Import the schema and validate a value at the boundary. No plugin assembly is needed — this is a plain library.

```ts
import { Block, isContainer, isReference, blockChildren, blockRef } from "@matter/blocks"

const container = Block.parse({
  id: "b1",
  type: "columns",
  children: [{ id: "b2", type: "paragraph", rich: [{ text: "hello" }] }],
})
if (isContainer(container)) console.log(blockChildren(container).length) // 1

const ref = Block.parse({ id: "b3", type: "issueRef", ref: "ISS-526" })
if (isReference(ref)) console.log(blockRef(ref)) // ISS-526
```

### Walk, index and extract references

Traversal, indexing and reference extraction are one DFS pre-order pass away — container recursion and the depth ceiling are shared, not re-implemented per consumer.

```ts
import { Block, extractReferences, indexBlocks, walkBlocks } from "@matter/blocks"
import type { Block as BlockValue } from "@matter/blocks"

const blocks: BlockValue[] = [
  Block.parse({ id: "b1", type: "paragraph", rich: [{ text: "hi" }] }),
  Block.parse({
    id: "b2",
    type: "columns",
    children: [Block.parse({ id: "b3", type: "issueRef", ref: "ISS-529" })],
  }),
]

// DFS pre-order: parent before children, siblings in array order.
const ids: string[] = []
walkBlocks(blocks, (block, path, depth) => {
  ids.push(block.id)
  if (depth > 0) console.log(path.at(-1), "nested at depth", depth)
})

// id -> { document, path }: nested blocks (issueRef inside columns) are indexed too.
const index = indexBlocks(blocks, "DOC-1")
console.log(index.get("b3")?.path) // ["b2", "b3"]

// Four reference types in three tiers: block (syncedBlock) / entity (issueRef, docRef) / config (view).
const refs = extractReferences(blocks)
console.log(refs.entity.map((site) => site.block.ref)) // ["ISS-529"]
```

### Evaluate a view query

`view` blocks point at a query config. The spec is zod-validated; field metadata is injected by the caller — this package knows no issue/document fields.

```ts
import { evaluateViewQuery } from "@matter/blocks"
import type { ViewFieldCatalog, ViewRow } from "@matter/blocks"

const rows: readonly ViewRow[] = [
  { id: "i1", status: "open", priority: "high" },
  { id: "i2", status: "closed", priority: "low" },
]
const fields: ViewFieldCatalog = { id: "string", status: "string", priority: "string" }

const out = evaluateViewQuery(
  rows,
  { filter: [{ field: "status", values: ["open"] }], sort: [{ field: "priority", dir: "desc" }], limit: 10 },
  fields,
)
console.log(out.map((row) => row.id)) // ["i1"]
```

### What you get

- **One discriminated union, 28 members.** `Block` discriminates on `type`; A/B/C vocabulary predicates plus a trailing `assertNever` close the union — registering a new type in its vocabulary is the only change needed.
- **V5 at the boundary.** `Block.safeParse({ id, type: "paragraph", children: [] })` fails — leaves are strict objects without a `children` key. Containers parse the same value successfully.
- **Recursion is validated.** `children` is a lazy reference back to `Block`, so nested blocks are checked against the same union at parse time.
- **Vocabularies and grouping.** `BLOCK_TYPES`, `CONTAINER_TYPES`, `REFERENCE_TYPES` and the A/B/C lists are exported for generators and UI code.
- **Three tree algorithms, one recursion.** `walkBlocks`, `indexBlocks` and `extractReferences` share a single DFS pre-order implementation with a 256-level wire-safety ceiling (`WalkDepthLimitError`) — consumers never re-implement container recursion.
- **View-query predicates without domain imports.** `evaluateViewQuery` runs filter (clauses AND, values OR, input order preserved) → sort (multi-key, stable) → limit over plain rows, validating the spec with `ViewQuerySpec` and every referenced field against the injected `ViewFieldCatalog`.

### Failures and recovery

| Error | When | Fix |
|---|---|---|
| `ZodError` (`invalid_union`) | a value breaks every member — unknown type, missing required field, or `children` on a leaf | inspect `error.issues[].path`; remove the stray key or fill the required field |
| `WalkDepthLimitError` | the tree is deeper than 256 levels | fix the data that produced the chain; the ceiling is a wire-safety guard, not a tunable |
| `ViewQueryError` (`VIEW_QUERY_UNKNOWN_FIELD`) | filter/sort references a field missing from the catalog | add the field to the injected `ViewFieldCatalog` or fix the spec |
| `ViewQueryError` (`VIEW_QUERY_FIELD_TYPE_MISMATCH`) | a row value's type contradicts the catalog declaration | align the row data or the catalog — comparison is type-checked, never coerced |
| compile `TS2345` | a new BlockType was added but not registered in its A/B/C vocabulary | register the new type in the matching A/B/C vocabulary in `src/index.ts` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design concept

The union is built from 25 non-recursive `z.strictObject` leaf schemas plus three container schemas whose `children` field is a `z.lazy` back to `Block`. Using `strictObject` is load-bearing for V5: `z.object` silently drops unknown keys, so a leaf with `children` would pass and the container/leaf boundary would collapse without any error. The `ZodType<Block>` annotation sits only on the lazy `children` field — annotating a whole union member erases the discriminator metadata that `z.discriminatedUnion` requires.

The TypeScript `Block` type mirrors the runtime union as a true discriminated union: 25 `z.infer` members plus three inline container literals. That is what lets the three A/B/C type predicates narrow `block.type` to `never` at the end of `blockGroup`, where `assertNever` closes it.

The runtime half reuses that closure instead of re-building it: `extractReferences` narrows with `isReference` (whose narrowing type is **derived from the `REFERENCE_TYPES` vocabulary**, not hand-written literals — the vocabulary is the single source of truth), switches over the four reference types, and closes with `assertNever`; an unregistered type is a compile error, and an off-vocabulary runtime value throws the same `UnhandledBlockTypeError` as `blockGroup`. `isReference`'s narrowing was originally structural (`Extract<Block, { ref: string }>`), which pulled in `template` (it structurally has `ref` but is not a reference block) and broke the exhaustive switch — ISS-529 fixed it to derive from the vocabulary.

### Source map

| File | Holds |
|---|---|
| `src/spec.ts` | the 28 zod schemas, `Block` union + type, the five vocabularies, V5 enforcement |
| `src/index.ts` | `assertNever`, `blockGroup` (A/B/C vocabulary predicates), `isContainer` / `isReference` / `blockChildren` / `blockRef`, package re-exports |
| `src/walk.ts` | `walkBlocks` DFS pre-order, `MAX_WALK_DEPTH = 256`, `WalkDepthLimitError` |
| `src/tree-index.ts` | `indexBlocks` (id → document + path), `extractReferences` (four reference types, three tiers) |
| `src/view-query.ts` | `ViewQuerySpec` (zod), `evaluateViewQuery`, `ViewQueryExecutor` seam, `ViewQueryError` |
| `tests/spec.test.ts` | 28-type positives, V5 positives/negatives, reference fields, grouping |
| `tests/walk.test.ts`, `tests/tree-index.test.ts`, `tests/view-query.test.ts` | the three algorithms, each written so a wrong implementation turns red |

### Why still no `ctx.blocks` service

The block-tree algorithms landed as pure functions on purpose (P3-B1): they have no state, so a service would only wrap them. A `ctx.blocks` key becomes worth mounting when a consumer needs cross-document caching (P8 syncedBlock) or an injected executor (P4 views) — both are named triggers in the plan, and both would still evolve this same package without splitting it.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No rendering.** Walk/index/query are data-plane algorithms; renderers are U-2 and stay outside this package.
- **References are extracted, never resolved.** `extractReferences` reports where references sit; target existence, reverse lookup (edges table) and sync propagation belong to document-domain storage (P8/P9).
- **View queries run in memory.** `evaluateViewQuery` filters arrays; no SQLite plan, no pagination, no executor assembly — the `ViewQueryExecutor` interface is the seam P4 will implement when views.json exists.
- **Indexing is rebuild-every-time.** No incremental index and no invalidation protocol — same philosophy as the edges table.
- **One walk shape only.** DFS pre-order covers today's consumers (U-2 render, P9 export, P8 location); pre/post/breadth/async forms wait for a consumer that needs them.
- **V5 checks the `children` key only.** Deeper rules — container-inside-container depth beyond the walk ceiling, reference-target existence — are not in the schema gate; the latter needs real storage (E-2/E-3b).
- **Rich text and marks are placeholders.** `Rich` carries `text` plus a string `marks` array; the 12 mark variants from DOC-512 §2.4 are deferred to P3.
- **Media fields hold opaque ids/URLs.** The package does not verify that a `url` resolves or an `asset` exists — media is a cross-cutting attachment, not an entity owned here.
