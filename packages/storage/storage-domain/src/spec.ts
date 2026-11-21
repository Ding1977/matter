/**
 * Domain declaration vocabulary. A spec object is the single source of a
 * domain's identity, layout, and record schemas: the owning package defines
 * it once with {@link defineDomain} and both the type surface and the runtime
 * (validation, descriptor projection) derive from it. Record schemas are zod
 * (`z.infer` keeps types un-duplicated); plugin `Config` is hand-rolled plain
 * TS (see `index.ts` — schemastery is not available in this repo).
 * @module @matter/storage-domain/src/spec
 */

import type { ZodType } from "zod"
import { UNIT_NAME_RE, type KvUnitDescriptor } from "@matter/storage"
import { DomainError } from "./error.ts"

/** Global singleton declaration: schema plus the value used before the first write. */
export interface DomainGlobalSpec<G> {
  /** Validates the stored global at the durable boundary. */
  readonly schema: ZodType<G>
  /** Value served when the medium holds no global yet; not written until the first `set`. */
  readonly initial: G
}

/**
 * One table declaration. `K` is a phantom key type (typically a branded
 * string) carried for compile-time projection only; keys are plain strings on
 * the medium. `V` is the props value type; `B` is the optional block-tree type.
 */
export interface DomainTableSpec<K extends string = string, V = unknown, B = never> {
  /** Validates every stored record's props at the durable boundary. */
  readonly valueSchema: ZodType<V>
  /**
   * Optional block-tree schema. When declared, the stored record value is the
   * flat shape `{props: V, blocks: B}` (DOC-512 §2.1) and this schema validates
   * `blocks` at the durable boundary. When absent (the default `B = never`),
   * the record value is the bare props `V` and this key is **not present at
   * runtime** — E-0/E-1 keep their exact object shape and behavior.
   */
  readonly blocksSchema?: ZodType<B>
  /** Phantom carrier for the key type; never present at runtime. */
  readonly __key?: K
}

/** Static declaration of one domain: identity, version, and record layout. */
export interface DomainSpec {
  /** Domain name; must match `UNIT_NAME_RE` (doubles as the backend unit name). */
  readonly name: string
  /** Current domain format version; reads enforce it according to the selected layout. */
  readonly version: number
  /**
   * Document layout for the backend unit.
   *
   * **Matter 只实现 `per-record`**：一条记录一个文档（`@matter/storage-json` 的
   * 唯一布局，ISS-510 · DOC-512 §2.5）。字段类型仍含 `'single'`，只为与
   * `KvUnitDescriptor` 的契约文本一致（那是 DSH 双布局的共同词表）。
   * ⛔ **填 `'single'` 会被 {@link defineDomain} 当场拒绝**，不是静默降级：
   * Provider 根本不读这个字段，接受它等于让声明与落盘形态悄悄分叉。
   */
  readonly layout?: "single" | "per-record"
  /**
   * Older domain versions whose stored records the current record schemas
   * also accept (the declaring owner vouches for that, typically by
   * declaring the fields older records lack as optional).
   *
   * 现状：`@matter/storage-json` 的 per-record 布局按**文档粒度**判版本 —— 版本不被
   * 接受的文档**读作不存在**（丢弃，不迁移），而不是整个 unit 拒绝打开。
   * ⇒ 列进来的旧版本不会让旧记录"变新"，它们只是继续可读；未列出的旧版本记录
   * 会在 `loadAll` 里静默缺席（这正是 per-record 的既定语义，不是缺陷）。
   */
  readonly compatibleVersions?: readonly number[]
  /**
   * What `open` does with a stored table record that fails its zod schema.
   * Absent (the default), the whole open rejects with `invalid-record` —
   * right for authoritative data. `'backup-and-skip'` is for domains whose
   * records are disposable derived data: the backend moves the record's
   * document aside (`KvUnit.backupRecord`), the failure is logged with
   * its cause, and the open continues with the record absent. A backend
   * without `backupRecord` falls back to the rejecting default.
   * The global slot always rejects.
   */
  readonly invalidRecords?: "backup-and-skip"
  /** Optional global singleton slot. */
  readonly global?: DomainGlobalSpec<unknown>
  /**
   * Table declarations keyed by table name; each name must match `UNIT_NAME_RE`.
   * The `B` slot is widened to `unknown` so a table declaring a concrete
   * `blocksSchema` is accepted by `defineDomain`; props-only tables (E-0/E-1,
   * `B = never`) stay assignable and their `TableValueOf` derivation is unchanged.
   */
  readonly tables: Record<string, DomainTableSpec<string, unknown, unknown>>
}

/** Key type of one declared table, recovered from its phantom carrier. */
export type TableKeyOf<S extends DomainSpec, N extends keyof S["tables"]> =
  S["tables"][N] extends DomainTableSpec<infer K, infer _V, infer _B> ? K : never

/**
 * Value type of one declared table. For a props-only table (`B = never`, the
 * E-0/E-1 case) this stays the bare props `V` — byte-identical to before the
 * blocks slot existed. For a table declaring `blocksSchema`, the value is the
 * flat `{props, blocks}` shape that is persisted verbatim by the backend.
 */
export type TableValueOf<S extends DomainSpec, N extends keyof S["tables"]> =
  S["tables"][N] extends DomainTableSpec<string, infer V, infer B>
    ? [B] extends [never] ? V : { props: V; blocks: B }
    : never

/** Global value type of a spec; `never` when the spec declares no global. */
export type GlobalValueOf<S extends DomainSpec> =
  S["global"] extends DomainGlobalSpec<infer G> ? G : never

/**
 * Declare one table.
 *
 * The second parameter is optional. Props-only domains (E-0/E-1) pass only
 * `schema`: the returned object is exactly `{ valueSchema: schema }` — no
 * `blocksSchema` key, `B = never` — so their runtime shape and type derivation
 * are unchanged. A domain that stores a block tree passes a `blocksSchema` too;
 * its records persist as the flat `{props, blocks}` value (DOC-512 §2.1).
 * @param schema - zod schema validating every stored record's props.
 * @param blocksSchema - optional zod schema validating each record's blocks.
 * @returns the table declaration, key-typed by `K`.
 */
export function domainTable<K extends string, V, B = never>(
  schema: ZodType<V>,
  blocksSchema?: ZodType<B>,
): DomainTableSpec<K, V, B> {
  return blocksSchema === undefined
    ? { valueSchema: schema }
    : { valueSchema: schema, blocksSchema }
}

/**
 * Identity helper that pins a spec's literal types and validates its fields.
 * Misconfiguration fails loud at the owning package's module load, before any
 * medium is touched: a domain or table name outside `UNIT_NAME_RE`, a version
 * that is not a non-negative integer, or a global schema that accepts `null`
 * all throw. The `null` rejection guards round-tripping: backends store the
 * global as opaque JSON with `null` as the "never written" sentinel, so a
 * nullable global would be indistinguishable from an absent one on reopen
 * (a stored `null` silently reverts to `initial`).
 *
 * 四类加载期自检（缺一条就等于把错误推到第一次 `open`）：
 *   ① 域名 / 表名必须匹配 `UNIT_NAME_RE`
 *   ② `version` 必须是非负整数；`compatibleVersions` 每项必须是非负整数且 < `version`
 *   ③ `layout` / `invalidRecords` 运行期取值必须合法（联合类型只在编译期成立，
 *      从配置构造的 spec 可以是任意值）
 *   ④ global schema **不许接受 `null`**（介质哨兵）
 * @param spec - The domain declaration.
 * @returns the same spec, narrowed to its literal type.
 */
export function defineDomain<S extends DomainSpec>(spec: S): S {
  assertName(spec.name, "domain name")
  assertVersion(spec)
  assertDiscriminants(spec)
  for (const table of Object.keys(spec.tables)) {
    assertName(table, `domain '${spec.name}' table name`)
  }
  assertGlobalIsNotNullable(spec)
  return spec
}

/**
 * ① 名字自检：域名与表名都必须是文件/标识符安全的形状。
 * @param name - 待检的名字
 * @param what - 报错里的字段称呼
 */
function assertName(name: string, what: string): void {
  if (!UNIT_NAME_RE.test(name)) {
    throw new DomainError("invalid-spec", `${what} '${name}' must match ${UNIT_NAME_RE}`)
  }
}

/**
 * ② 版本自检：`version` 非负整数；`compatibleVersions` 每项非负且严格小于 `version`。
 * @param spec - 待检的 domain 声明
 */
function assertVersion(spec: DomainSpec): void {
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new DomainError("invalid-spec", `domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`)
  }
  for (const compat of spec.compatibleVersions ?? []) {
    if (!Number.isInteger(compat) || compat < 0 || compat >= spec.version) {
      throw new DomainError(
        "invalid-spec",
        `domain '${spec.name}' compatibleVersions entries must be non-negative integers below version ${spec.version}, got ${compat}`,
      )
    }
  }
}

/**
 * ③ 判别字段自检：`layout` / `invalidRecords` 的运行期取值必须合法 —— 联合类型只在
 * 编译期成立，从配置构造的 spec 可以是任意值。
 * @param spec - 待检的 domain 声明
 */
function assertDiscriminants(spec: DomainSpec): void {
  if (spec.layout !== undefined) {
    // ⛔ 'single' 被拒的理由不是"还没实现"，是**Provider 不读它**：接受声明
    // 而按别的形态落盘，是本仓最贵的那类静默错（ISS-510 同款）。
    const layout: string = spec.layout
    if (layout !== "per-record") {
      throw new DomainError(
        "invalid-spec",
        `domain '${spec.name}' layout must be 'per-record' (the only layout @matter/storage-json implements), got ${layout}`,
      )
    }
  }
  if (spec.invalidRecords !== undefined) {
    const policy: string = spec.invalidRecords
    if (policy !== "backup-and-skip") {
      throw new DomainError("invalid-spec", `domain '${spec.name}' invalidRecords must be 'backup-and-skip' when present, got ${policy}`)
    }
  }
}

/**
 * ④ 哨兵自检：global schema 不许接受 `null`。介质用 `null` 表示"从未写过"，
 * 可接受 null 的 schema 会让「存了个 null」与「没写过」在重新打开时不可区分。
 * @param spec - 待检的 domain 声明
 */
function assertGlobalIsNotNullable(spec: DomainSpec): void {
  if (spec.global === undefined) return
  if (!spec.global.schema.safeParse(null).success) return
  throw new DomainError(
    "invalid-spec",
    `domain '${spec.name}' global schema must not accept null: `
    + 'null is the medium\'s "never written" sentinel, so a stored null could not round-trip',
  )
}

/**
 * Project a spec onto the backend-facing unit descriptor.
 * @param spec - The domain declaration.
 * @returns the descriptor handed to `KvFacet.open`.
 */
export function descriptorOf(spec: DomainSpec): KvUnitDescriptor {
  return {
    name: spec.name,
    version: spec.version,
    tables: Object.keys(spec.tables),
    hasGlobal: spec.global !== undefined,
    ...spec.layout === undefined ? {} : { layout: spec.layout },
    ...spec.compatibleVersions === undefined ? {} : { compatibleVersions: spec.compatibleVersions },
  }
}
