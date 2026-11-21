---
description: "BlockNote-backed block editor core for Matter's client: a headless editor boot, an explicit props/marks mapping layer between @matter/blocks records and BlockNote blocks, A-tier(9) and Marks(8) round-trip conversion. Data and mapping only; no default UI chrome and no visual surface in P3."
kind: "package-reference"
---

# @matter/client-ui-blocks

English | [中文](README.zh.md)

## Summary

`@matter/client-ui-blocks` is Matter's BlockNote-backed block editor core (P3-U2a). It ships three things: a headless editor boot (`bootHeadlessEditor`, no mount, no UI chrome) with a `BlockNoteViewRaw` display factory; an explicit mapping layer converting our `@matter/blocks` records to and from BlockNote blocks — names (`bulletList`→`bulletListItem`), granularity (one list block ↔ N list items), props and Rich inline content — with eight marks (seven styles plus `link` as inline content, bidirectionally); and runtime zod validation of our blocks. A-tier 9 and Marks 8 round-trip in jsdom tests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

### Boot a headless editor and round-trip blocks

Convert our A-tier blocks into a BlockNote document, read it back, and get our records again — no DOM mount needed.

```ts
import { bootHeadlessEditor, roundTripBlocks, type OurABlock } from "@matter/client-ui-blocks/client"

const blocks: OurABlock[] = [
  { id: "p1", type: "paragraph", rich: [{ text: "Hello", marks: [{ type: "bold" }] }] },
  { id: "l1", type: "bulletList", items: [{ text: "one", marks: [] }, { text: "two", marks: [] }] },
]

const editor = bootHeadlessEditor(blocks) // not mounted; editor.document is readable
const back = roundTripBlocks(blocks)      // our records again (field-for-field equal)
```

### Validate a record against the block schema

```ts
import { validateOurBlock } from "@matter/client-ui-blocks/client"

const result = validateOurBlock({ id: "h", type: "heading", level: 9, rich: [] })
// result.ok === false; result.issues[0].path === "level" (field named)
```

### Build a display view (headless, no default UI)

```ts
import { bootHeadlessEditor, createHeadlessView } from "@matter/client-ui-blocks/client"

const editor = bootHeadlessEditor([/* ... */])
const element = createHeadlessView({ editor }) // BlockNoteViewRaw element; no toolbar/menu
```

<a id="understand-the-implementation"></a>
## Understand the implementation

### Three-layer client structure

`src/client/` follows the `verify-client-domain-graph` layering: `contract/` (layer 0 — name maps, mark maps, our structured record types) → `mapping/` (layer 1 — inline/props/blocks conversion, validation, schema, headless boot, view) → `index.ts` (layer 2 assembly). The host half (`src/index.ts`) is an empty cordis registration; all BlockNote-dependent code lives in the client plane.

### Naming and granularity are explicit tables

`OUR_TO_BN_TYPE` / `BN_TO_OUR_TYPE` encode the four name/granularity differences (`bulletList`→`bulletListItem`, `orderedList`→`numberedListItem`, `todo`→`checkListItem`, `code`→`codeBlock`); everything else is same-named. The mapping layer expands one list block into N BlockNote list items and folds them back, and crops BlockNote default props (`backgroundColor`, `textColor`, `textAlignment`, …) that are not part of our records.

### Why link is inline content, not a style

BlockNote has seven built-in styles (`bold`, `italic`, `underline`, `strike`, `code`, `textColor`, `backgroundColor`) and models `link` as an inline-content node with `href`. Our eight marks map onto these; `link` is converted to and from a BlockNote link inline-content node, not stuffed into the style dictionary (verified by round-trip tests).

### Headless form and dependency discipline

The data plane boots `BlockNoteEditor.create({ schema, initialContent })` without mounting. The display plane uses `BlockNoteViewRaw`, which has no default UI wrapper — harder headless than switching eight DefaultUI flags off. Both `@blocknote/core` and `@blocknote/react` are pinned to exact `0.57.0` (MPL-2.0); no `xl-*` package (GPL/commercial) is used. `@matter/blocks` is a runtime dependency for zod validation (a pure library, allowed despite the feature-plugin import rule).

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The i18n gate (`verify-client-ui-i18n`) is a W12 prototype: it detects bare Chinese string literals in `packages/client/*/src` via a CJK proxy and exempts ui-theme's 21 token-description strings (ticket ISS-530). It does not parse JSX text, template interpolation, or prop passing; English hard-coded copy is out of scope for the prototype.
- Only A-tier 9 blocks and Marks 8 are mapped. B/C-tier blocks, four custom marks (`highlight` / `size` / `math` / `ref`), self-written layout blocks (columns / B5 toggle), the slot mechanism and IME handling are U-2b / later work.
- No visual surface: vitest's default `css: false` stubs BlockNote's stylesheet to an empty string; assertions are structural only. Real rendering (and macOS Pinyin IME "Enter selects a candidate, does not break the paragraph") must be verified on-device in U-2b.
- The BlockNoteViewRaw display factory is exposed but not mounted in this ticket (P3 has no shell). A `createElement` boundary uses one explicit `any` because the component's generic constraint is structurally incompatible with the package's fixed named schema types (documented in source).
- The public type aliases use BlockNote's named `Default*Schema` types rather than `typeof blockNoteSchema.*` because TypeScript 6.0.3 overflows the stack emitting the deeply-recursive inferred type; the runtime schema still contains only the nine A-tier block specs.
