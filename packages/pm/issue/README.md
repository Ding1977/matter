---
description: "Issue domain for Matter: ctx.issues — zod-validated issue records over the storage domain form, with every durable write projected into the activity journal."
kind: "package-reference"
---

# @matter/issue

English | [中文](README.zh.md)

## Summary

`@matter/issue` is the first business domain of the P2 entity layer: the `IssueProps` zod schema, the `defineDomain` declaration it feeds, and the write path that projects every durable change into the activity journal. It mounts `ctx.issues` and is the only writer of issue records — reads are synchronous from the domain's in-memory state. It is also the first cross-package consumer of `@matter/storage-journal`, so the activity log stops being an empty table once this package is assembled.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Assembly is four plugins, and **file order does not matter** — each one gates on a service key via `ctx.inject`.

```ts
// Storage (definition) → storage-json (provider) → storage-domain (form) → issue (this)
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: "/var/lib/matter/records" })
await ctx.plugin(StorageDomain, { backend: "json" })
await ctx.plugin(Journal, { root: "/var/lib/matter" })
await ctx.plugin(Issue)
```

Then write through `ctx.issues`:

```ts
const created = await ctx.issues.create({
  id: "ISS-1", title: "first", status: "todo", kind: "feature", created: "2026-11-17",
})
await ctx.issues.update(issueId("ISS-1"), { status: "in_review" }, { actor: "linmo" })

ctx.journal.list({ entity: "issues/ISS-1" }).rows
// → issue-created · issue-delivered（payload: { field: "status", from: "todo", to: "in_review" }）
```

### What you get

- **Records are validated at the boundary.** `IssueProps` is a `z.strictObject`: an unknown key is an error, not a silently dropped field. Both `create` and `update` reject with the raw `ZodError`, whose `issues[].path` names the offending field.
- **Audit comes from the diff.** `update` compares the previous snapshot with the next one and emits one event per changed field — you cannot forget to log a write, because there is only one write path.
- **Field provenance is on the schema.** Every field carries `.meta({ writable, widget, indexable })`, and `z.toJSONSchema(IssueProps)` keeps it — a UI can build a field editor without a second source of truth.
- **Idempotent replay.** Re-appending the same event (same entity, event, and moment) writes no second row, so a migration script can be re-run.

### Failures and recovery

| Error | When | Fix |
|---|---|---|
| `ZodError` | a value breaks the schema (bad status, malformed `ISS-*` id, unknown key) | fix the value; `error.issues[].path` says which field |
| `IssueExistsError` | `create` on an id that already exists | use `update`, or pick another id |
| `IssueNotFoundError` | `update` on an absent id | `create` first, or check with `get` |

Domain-level failures (`already-open`, `invalid-record`, `closed`, backend errors) pass through from `@matter/storage-domain` — this layer does not rewrap them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design concept

`@matter/storage-domain` emits `domain/changed` **after** durability, and its payload carries the **new value only** — by design, a consumer that wants a diff keeps its own previous snapshot. Subscribing and diffing would therefore make this package the second owner of the record state. Instead the diff happens inside the write chain, where the previous version is already in hand: read previous → `put` → emit (domain layer) → append audit. The activity-log shape is decided in exactly one place.

The ordering is load-bearing. A `domain/changed` listener observes the journal **before** the audit row exists (`tests/domain.test.ts` asserts `count() === 0` at that moment). Writing the audit first would let a rejected backend write leave behind an event that never happened — indistinguishable on disk from a real one.

### Source map

| File | Holds |
|---|---|
| `src/spec.ts` | `IssueProps` (12 core fields + `.meta()`), `IssuePatch`, the three vocabularies, `IssueDomain` |
| `src/events.ts` | event names, `diffEntries`, `bodyFingerprint`, `logValue`, `issueEntry` (the idempotency-key shape) |
| `src/index.ts` | `IssuesFacility` (`ctx.issues`), `openIssues`, `apply`, the two domain errors |

### Why optional fields are `.optional().meta(...)`, never `.meta(...).optional()`

zod 4.6.6: `z.string().meta({…}).optional()` returns a **new optional wrapper**, so `schema.meta()` on it reads back `undefined` — while `z.toJSONSchema()` still merges the inner metadata out. That split is the worst kind: JSON schema looks right, and every consumer that reads `.meta()` directly gets nothing. Putting `.meta()` last keeps one location.

### Why `.transform()` is not used for the id brand

`z.string().transform(...)` makes `z.toJSONSchema()` throw under the default `io: "output"`. The brand has no runtime meaning here — it lives in the type layer (`Branded<"IssueId">`) — so the schema carries it as `.meta({ branded: ... })` instead, which round-trips cleanly.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **12 of 41 fields.** `forge-pm/lib/domain.js`'s `FIELD_META` yields 41 fields for the issues domain (measured, not quoted). Only the 12 with a real consumer today are built; the rest are listed as a TODO block in `src/spec.ts`. A field with no writer and no reader is a key that is permanently empty, and an empty key is indistinguishable on disk from "not written yet".
- **`picture of mdAt`**: `issueEntry` stores the event's own timestamp in the `mdAt` column. On the old tree that column held the markdown sidecar's `at:`. Without it, two genuinely distinct occurrences of the same transition (`in_review` → `todo` → `in_review`) collapse into one row, because `stablePayload` deliberately excludes `at`. The name is therefore misleading here; renaming it means touching the P1 journal contract, which is out of this package's scope (reported).
- **Non-1 `known` leaks into the payload.** `@matter/storage-journal`'s `stablePayload` excludes `entity`/`event`/`actor`/`at`/`mdAt`/`uid` but not `known`, so passing an explicit `known` puts it into `payload_json` and the uid. This package omits it when it is `1` (the default) and only passes it otherwise. Reported as a defect against the journal seam rather than worked around here.
- **No cross-restart repair.** A stored record that fails the schema rejects `open`. Nothing rewrites it into the current shape.
- **`update` is read-modify-write, not a compare-and-swap.** The facility serialises its own writes, so concurrent updates through one facility cannot interleave; two processes sharing one medium are not protected, because the layer below offers no CAS.
- **Audit failure does not roll back the record.** If the journal append throws, the record stays written and a warning is logged. The reverse direction — rolling back a successful record write to keep the audit complete — would make "it worked but it threw" routine.
- **No `relations` / `blocked_by` projection yet.** The journal's edge table projects `relations`, `parent`, and `blocked_by`; only `parent` exists in this schema today, and the edge rebuild is a separate concern (`ctx.journal.rebuild()`).
