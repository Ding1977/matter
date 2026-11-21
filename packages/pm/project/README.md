---
description: "Project domain for Matter: ctx.projects — zod-validated project records over the storage domain form, with every durable write projected into the activity journal."
kind: "package-reference"
---

# @matter/project

English | [中文](README.zh.md)

## Summary

`@matter/project` is the second business domain of the P2 entity layer: the `ProjectProps` zod schema, the `defineDomain` declaration it feeds, and the write path that projects every durable change into the activity journal. It mounts `ctx.projects` and is the only writer of project records — reads are synchronous from the domain's in-memory state. It covers 11 fields (the 10 core ones plus `created`); `milestones` and `phases` are deliberately absent because the old tree normalizes them on read, not on write.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Assembly is five plugins, and **file order does not matter** — each one gates on a service key via `ctx.inject`.

```ts
// Storage (definition) → storage-json (provider) → storage-domain (form) → journal → project (this)
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: "/var/lib/matter/records" })
await ctx.plugin(StorageDomain, { backend: "json" })
await ctx.plugin(Journal, { root: "/var/lib/matter" })
await ctx.plugin(Project)
```

Then write through `ctx.projects`:

```ts
const created = await ctx.projects.create({
  id: "PRJ-1", title: "first", status: "active", created: "2026-11-17",
})
await ctx.projects.update("PRJ-1", { status: "paused" }, { actor: "linmo" })

ctx.journal.list({ entity: "projects/PRJ-1" }).rows
// → created · status-change（payload: { field: "status", from: "active", to: "paused" }）
```

### What you get

- **Records are validated at the boundary.** `ProjectProps` is a `z.strictObject`: an unknown key is an error, not a silently dropped field. Both `create` and `update` reject with the raw `ZodError`, whose `issues[].path` names the offending field.
- **Audit comes from the diff.** `update` compares the previous snapshot with the next one and emits one event per changed field — you cannot forget to log a write, because there is only one write path.
- **Field provenance is on the schema.** Every field carries `.meta({ writable, widget, indexable })`, and `z.toJSONSchema(ProjectProps)` keeps it — a UI can build a field editor without a second source of truth.
- **Idempotent replay.** Re-appending the same event (same entity, event, and moment) writes no second row, so a migration script can be re-run.

### Failures and recovery

| Error | When | Fix |
|---|---|---|
| `ZodError` | a value breaks the schema (bad status, malformed `PRJ-*` id, unknown key) | fix the value; `error.issues[].path` says which field |
| `ProjectExistsError` | `create` on an id that already exists | use `update`, or pick another id |
| `ProjectNotFoundError` | `update` on an absent id | `create` first, or check with `get` |

Domain-level failures (`already-open`, `invalid-record`, `closed`, backend errors) pass through from `@matter/storage-domain` — this layer does not rewrap them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design concept

`@matter/storage-domain` emits `domain/changed` **after** durability, and its payload carries the **new value only** — by design, a consumer that wants a diff keeps its own previous snapshot. Subscribing and diffing would therefore make this package the second owner of the record state. Instead the diff happens inside the write chain, where the previous version is already in hand: read previous → `put` → emit (domain layer) → append audit. The activity-log shape is decided in exactly one place.

The ordering is load-bearing. Writing the audit first would let a rejected backend write leave behind an event that never happened — indistinguishable on disk from a real one (`tests/domain.test.ts` asserts the journal is still empty when `domain/changed` fires).

### Source map

| File | Holds |
|---|---|
| `src/spec.ts` | `ProjectProps` (11 fields + `.meta()`), `ProjectPatch`, the three vocabularies, `ProjectDomain` |
| `src/events.ts` | event names, `diffEntries`, `logValue`, `projectEntry` (the idempotency-key shape) |
| `src/index.ts` | `ProjectsFacility` (`ctx.projects`), `openProjects`, `apply`, the two domain errors |

### Why `milestones` / `phases` are not in the schema

The tool surface calls them read-only derived views. The old tree shows that this is one thing written twice, not two storage shapes: `forge-pm/lib/md-store.js:51,105` normalize them **on read** (`normMilestones`, `normPhases`), and there is no write-side normalizer at all. The stored shape is whatever the caller passed — and both shapes exist in real data (`$DSH_HOME/pm/projects`, 26 entities): `milestones` is always an object array, while `phases` is a **string array**.

Putting the normalized `{id,name,targetDate}` into the schema would lock two things in, neither of which has a consumer yet. First, string-form `phases` in existing data would fail validation, and `@matter/storage-domain` answers a failing stored record with `invalid-record` — the whole domain refuses to open. Second, a phase id is derived from its container (`<container id>:ph-N`), and the container id is this record's own `id`; a schema that knows the field but not the container would move derivation into storage. Normalising the old shapes belongs to the P9 migration, which has both the full frontmatter and the container identity.

### Display-field `widget` values

`widget` describes the **shape of the data**, not the React component that draws it (same convention as `person` / `tags` / `markdown`). This package adds three values; `E-3` and the front end render against them:

| Field | `widget` | Consumer that fixes the meaning |
|---|---|---|
| `color` | `color` | `forge-pm/src/pm/shared/icon-picker.tsx:42` `PROJECT_ICON_COLORS` (12-swatch palette) |
| `icon` | `icon` | same file `:44` `iconById()` (lucide icon set, keyed by id name) |
| `subtitle` | `text` | `forge-pm/src/pm/shared/blocks/subtitle-input.tsx` (single-line, in-place edit) |
| `cover` | `image` | `forge-pm/src/pm/shared/blocks/cover-image.tsx` (file upload → `assets/<id>/`) |

### Why optional fields are `.optional().meta(...)`, never `.meta(...).optional()`

zod 4.6.6: `z.string().meta({…}).optional()` returns a **new optional wrapper**, so `schema.meta()` on it reads back `undefined` — while `z.toJSONSchema()` still merges the inner metadata out. That split is the worst kind: JSON schema looks right, and every consumer that reads `.meta()` directly gets nothing. Putting `.meta()` last keeps one location.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **11 of 21 fields.** `forge-pm/lib/domain.js`'s `FIELD_META` yields 21 project-exclusive fields (plus shared ones such as `priority`). Only the 10 core fields plus `created` are built; the rest are listed as a TODO block in `src/spec.ts`. Measured across the 26 project entities in `$DSH_HOME/pm/projects`: `color` 6/26 · `icon` 7/26 · `subtitle` 0/26 · `cover` 0/26 — the display fields wait for their real consumer.
- **No `ProjectId` brand.** `@matter/storage/src/brand.ts` exports `IssueId` only, so this package's record key is a bare `string`. Adding the brand means editing `packages/storage/*`, which this ticket's write scope excludes — reported rather than worked around. Today a `"DOC-1"` passed to `get()` type-checks and returns `undefined` at runtime.
- **No status signal layer.** Issues emit seven named events (`issue-started`, `issue-delivered`, …); projects emit the generic `status-change`, matching the old tree (`forge-pm/lib/entity-ops.js:671`). Copying the issue signal map would mint names the old tree never produced, and `known` would drop to 0 for them.
- **No `body` / `body-change`.** The core field list has no body, so neither the schema nor the event vocabulary carries it. An event name with no producer reads like someone is writing it.
- **Non-1 `known` leaks into the payload.** `@matter/storage-journal`'s `stablePayload` excludes `entity`/`event`/`actor`/`at`/`mdAt`/`uid` but not `known`, so passing an explicit `known` puts it into `payload_json` and the uid. This package omits it when it is `1` (the default) and only passes it otherwise. Reported as a defect against the journal seam (ISS-520) rather than worked around here.
- **`mdAt` carries the event's own timestamp.** On the old tree that column held the markdown sidecar's `at:`. Without it two genuinely distinct occurrences of the same transition collapse into one row, because `stablePayload` deliberately excludes `at`. The name is therefore misleading here; renaming it means touching the P1 journal contract.
- **No cross-restart repair.** A stored record that fails the schema rejects `open`. Nothing rewrites it into the current shape.
- **`update` is read-modify-write, not a compare-and-swap.** The facility serialises its own writes, so concurrent updates through one facility cannot interleave; two processes sharing one medium are not protected, because the layer below offers no CAS.
- **Audit failure does not roll back the record.** If the journal append throws, the record stays written and a warning is logged. The reverse direction — rolling back a successful record write to keep the audit complete — would make "it worked but it threw" routine.
