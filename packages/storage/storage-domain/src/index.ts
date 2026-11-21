/**
 * Domain data form (`ctx.storage.domain` + `ctx.storageDomain`): schema-validated,
 * change-emitting KV domains over storage backends. The single implementation of
 * the domain layer — consumers depend on this package and never touch backends
 * directly.
 *
 * 角色是 seam 的**第三角**（Data form / Consumer）：`@matter/storage` 定义
 * `ctx.storage` 与 `StorageForms`，Provider（如 `@matter/storage-json`）提供介质，
 * 本包把介质用成「有 schema、有事件、有写链」的 domain。
 *
 * ⚠️ **两个 Context 键是同一个对象**：`ctx.storageDomain`（服务键，供 `ctx.inject`
 * 依赖）与 `ctx.storage.domain`（hub 表单键，供 `ctx.storage.domain` 读）。
 * 缺一件都不算完整 —— `grep` 两处都在才算接上。
 * @module @matter/storage-domain
 */

import type { Context } from "@deepseek-ai/cordis"
import type { KvUnit, StorageBackend } from "@matter/storage"
import { storageBackendServiceKey } from "@matter/storage"
import { DomainError } from "./error.ts"
import { descriptorOf } from "./spec.ts"
import type { DomainSpec, DomainTableSpec } from "./spec.ts"
import { DomainImpl } from "./domain.ts"
import type { Domain } from "./domain.ts"

export { DomainError } from "./error.ts"
export type { DomainErrorCode, DomainErrorOptions, InvalidRecordDetail } from "./error.ts"
export { defineDomain, domainTable, descriptorOf } from "./spec.ts"
export type {
  DomainSpec, DomainGlobalSpec, DomainTableSpec,
  TableKeyOf, TableValueOf, GlobalValueOf,
} from "./spec.ts"
export type { DomainChanged } from "./events.ts"
export type { Domain, DomainGlobal, DomainGlobalHandleOf, KvTable } from "./domain.ts"

declare module "@matter/storage" {
  interface StorageForms {
    domain: DomainFacility
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    storageDomain: DomainFacility
  }
}

/** Cordis plugin name. */
export const name = "storage-domain"
/** The storage hub must be present before the form can mount. */
export const inject = ["storage"]

/**
 * Plugin config. Which backend serves which domain is decided here, not
 * globally on the hub: `backend` is the default route and `routes` overrides
 * it per domain name. A route naming an unregistered backend fails loud at
 * `open` with `backend-not-found`.
 *
 * ⚠️ 校验**不用 schemastery**（该包在本仓不可得，P0 已判）：沿用
 * `@matter/storage-json` 的 `normalizeConfig` 先例 —— 加载期窄校验，非法值当场抛，
 * 不静默回退默认值。判据：`storage-json/src/index.ts:54-63`。
 */
export interface Config {
  /** Default backend name for every domain without an explicit route. Required: there is no universally correct medium. */
  backend: string
  /** Per-domain overrides: domain name → backend name. */
  routes?: Record<string, string>
}

/**
 * Validate and normalize plugin config at load time.
 * @param raw - Raw config handed to `apply`.
 * @returns the validated config, with `routes` defaulted to an empty table.
 */
export function normalizeConfig(raw: Config): Config {
  const backend = (raw as { backend?: unknown } | undefined)?.backend
  if (typeof backend !== "string" || backend.length === 0) {
    throw new DomainError("facet-unsupported", "storage-domain: config.backend must be a non-empty string")
  }
  const rawRoutes = (raw as { routes?: unknown }).routes
  if (rawRoutes !== undefined && (typeof rawRoutes !== "object" || rawRoutes === null || Array.isArray(rawRoutes))) {
    throw new DomainError("facet-unsupported", "storage-domain: config.routes must be a table of domain name → backend name")
  }
  const routes: Record<string, string> = {}
  for (const [domainName, backendName] of Object.entries(rawRoutes ?? {})) {
    if (typeof backendName !== "string" || backendName.length === 0) {
      throw new DomainError(
        "facet-unsupported",
        `storage-domain: config.routes['${domainName}'] must be a non-empty backend name`,
      )
    }
    routes[domainName] = backendName
  }
  return { backend, routes }
}

/** One table's record map plus whether the stored record survived validation. */
type ParsedRecord =
  | { readonly present: true; readonly value: unknown }
  | { readonly present: false }

/**
 * The mounted domain facility. Opens declared domains over routed backends;
 * one facility instance owns the open-domain table and enforces single-open
 * per domain name.
 */
export class DomainFacility {
  private readonly domains = new Map<string, DomainImpl>()
  /** Names reserved by an in-flight or completed open, so concurrent opens of one name fail loud. */
  private readonly reserved = new Set<string>()

  /**
   * @param ctx - Context of the domain plugin; open-domain effects and change
   * events attach here.
   * @param config - Validated plugin config.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /**
   * Open one declared domain. Steps, each failing the whole call: reject a
   * name that is already open (`already-open`); resolve the backend route
   * (`backend-not-found` passes through from the hub); require its `kv` facet
   * (`facet-unsupported`); open the unit projected from the spec (backend
   * `version-mismatch`/`malformed-medium` pass through); load and validate
   * every stored record against the spec's zod schemas (`invalid-record`
   * with the offending table and key — unless the spec declares
   * `invalidRecords: 'backup-and-skip'` and the unit can move documents aside);
   * construct the domain.
   *
   * Lifecycle: the CALLER owns the returned handle and closes it via
   * `Domain.close()` (typically as its own `ctx.effect` disposer) — the
   * facility does not tie the domain to any consumer fiber. Domains still
   * open when the facility unmounts are closed by the plugin disposer.
   * @param spec - The domain declaration, typically from `defineDomain`.
   * @returns the opened domain handle, typed by the spec.
   */
  async open<S extends DomainSpec>(spec: S): Promise<Domain<S>> {
    if (this.reserved.has(spec.name)) {
      throw new DomainError("already-open", `domain '${spec.name}' is already open`)
    }
    this.reserved.add(spec.name)
    try {
      return await this.openReserved(spec)
    } catch (error) {
      // Any failure means the domain never registered (nothing can throw
      // after it), so releasing the name reservation is unconditional.
      this.reserved.delete(spec.name)
      throw error
    }
  }

  /**
   * The post-reservation half of {@link open}: route, facet check, unit open,
   * snapshot load, construction. Split out so no branch exceeds the nesting
   * ceiling (`max-depth: 4`, `.oxlintrc.next.json`) — `try/catch` counts as a
   * level, which `open` already spends on its reservation release.
   */
  private async openReserved<S extends DomainSpec>(spec: S): Promise<Domain<S>> {
    const backendName = this.config.routes?.[spec.name] ?? this.config.backend
    const backend: StorageBackend = this.ctx.storage.backend.get(backendName)
    if (!backend.kv) {
      throw new DomainError(
        "facet-unsupported",
        `backend '${backendName}' routed for domain '${spec.name}' has no kv facet`,
      )
    }
    const unit = await backend.kv.open(descriptorOf(spec))
    try {
      return await this.construct(spec, unit)
    } catch (error) {
      await unit.close()
      throw error
    }
  }

  /** Build the domain from a freshly opened unit; the caller closes the unit on failure. */
  private async construct<S extends DomainSpec>(spec: S, unit: KvUnit): Promise<Domain<S>> {
    const snapshot = await unit.loadAll()
    const tables = await this.loadTables(spec, unit, snapshot.tables)
    const globalValue = this.loadGlobal(spec, snapshot.global)
    // The onClosed hook runs strictly after teardown completes: writes
    // landing during the drain still emit domain/changed, and the name
    // frees up for reopening only once the domain is fully closed.
    const domain: DomainImpl = new DomainImpl(this.ctx, spec, unit, tables, globalValue, () => {
      this.domains.delete(spec.name)
      this.reserved.delete(spec.name)
    })
    this.domains.set(spec.name, domain)
    // The single type-erasure point: DomainImpl is the untyped runtime,
    // Domain<S> the spec-typed view; the unknown hop is required because
    // S's conditional global-handle type stays unresolved here.
    return domain as unknown as Domain<S>
  }

  /** Load and validate every declared table's records (empty maps included). */
  private async loadTables(
    spec: DomainSpec,
    unit: KvUnit,
    stored: Record<string, Record<string, unknown>>,
  ): Promise<Map<string, Map<string, unknown>>> {
    const tables = new Map<string, Map<string, unknown>>()
    for (const [table, tableSpec] of Object.entries(spec.tables)) {
      tables.set(table, await this.loadTable(spec, unit, table, tableSpec, stored))
    }
    return tables
  }

  /** Load one table, honoring `invalidRecords: 'backup-and-skip'` per record. */
  private async loadTable(
    spec: DomainSpec,
    unit: KvUnit,
    table: string,
    tableSpec: DomainTableSpec<string, unknown, unknown>,
    stored: Record<string, Record<string, unknown>>,
  ): Promise<Map<string, unknown>> {
    const records = new Map<string, unknown>()
    for (const [key, raw] of Object.entries(stored[table] ?? {})) {
      const parsed = await this.parseOrSkip(spec, unit, table, key, tableSpec, raw)
      if (parsed.present) records.set(key, parsed.value)
    }
    return records
  }

  /**
   * Validate one stored record. Under the backup-and-skip policy (disposable
   * derived data) a failing record's document is moved aside, the concrete
   * failure is logged, and the record is treated as absent. Backends that
   * cannot move a document keep the loud path.
   */
  private async parseOrSkip(
    spec: DomainSpec,
    unit: KvUnit,
    table: string,
    key: string,
    tableSpec: DomainTableSpec<string, unknown, unknown>,
    raw: unknown,
  ): Promise<ParsedRecord> {
    try {
      return { present: true, value: parseRecord(spec.name, table, key, () => parseStoredRecord(tableSpec, raw)) }
    } catch (error) {
      if (spec.invalidRecords !== "backup-and-skip" || unit.backupRecord === undefined) throw error
      const moved = await unit.backupRecord(table, key)
      // parseRecord always wraps the zod failure as the cause.
      const logger = this.ctx.logger("storage-domain")
      logger.error(
        `domain '${spec.name}': stored record '${key}' in table '${table}' failed schema validation; `
        + `moved to '${moved}' and treated as absent. Cause: ${String((error as DomainError).cause)}`,
      )
      return { present: false }
    }
  }

  /**
   * Validate the stored global. A null stored global means "never written":
   * serve `initial` without materializing it — the first `set` writes.
   */
  private loadGlobal(spec: DomainSpec, stored: unknown): unknown {
    const globalSpec = spec.global
    if (globalSpec === undefined) return undefined
    if (stored === null) return globalSpec.initial
    return parseRecord(spec.name, "", "", () => globalSpec.schema.parse(stored))
  }

  /**
   * Look up an open domain by name, untyped. Diagnostic surface; typed
   * consumers hold the handle returned by {@link open}.
   * @param domainName - Domain name.
   * @returns the open domain runtime, or `undefined` when not open.
   */
  get(domainName: string): DomainImpl | undefined {
    return this.domains.get(domainName)
  }

  /**
   * Close every domain still open on this facility. The unmount path for
   * consumers that never called `Domain.close()` themselves; closing is
   * idempotent, so double-closing an already-closed domain is harmless.
   * @returns resolution after every unit is released.
   */
  async closeAll(): Promise<void> {
    await Promise.all([...this.domains.values()].map(domain => domain.close()))
  }
}

/** Run one zod parse, translating failure to `invalid-record` with its location. */
function parseRecord<T>(domain: string, table: string, key: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    const slot = table === "" ? "global" : `record '${key}' in table '${table}'`
    throw new DomainError(
      "invalid-record",
      `domain '${domain}': stored ${slot} does not match its schema`,
      { detail: { table, key }, cause: error },
    )
  }
}

/**
 * Validate one stored record value against its table declaration.
 *
 * Props-only tables (`blocksSchema` absent — the E-0/E-1 case) validate the
 * bare value with `valueSchema`: the exact call the domain made before the
 * blocks slot existed, so their acceptance behavior is unchanged. A table that
 * declares `blocksSchema` stores the flat `{props, blocks}` shape; both fields
 * are validated here at the durable boundary, and either failure surfaces (via
 * {@link parseRecord}) as `invalid-record` carrying the table and key.
 * @param tableSpec - The declaring table's schemas.
 * @param raw - The opaque record value read back from the backend.
 * @returns the validated record value (bare props, or `{props, blocks}`).
 */
function parseStoredRecord(tableSpec: DomainTableSpec<string, unknown, unknown>, raw: unknown): unknown {
  const blocksSchema = tableSpec.blocksSchema
  if (blocksSchema === undefined) return tableSpec.valueSchema.parse(raw)
  if (typeof raw !== "object" || raw === null) {
    throw new DomainError("invalid-record", "block record must be an object with props and blocks")
  }
  const record = raw as { props?: unknown; blocks?: unknown }
  return {
    props: tableSpec.valueSchema.parse(record.props),
    blocks: blocksSchema.parse(record.blocks),
  }
}

/**
 * Mount the domain data form on the storage hub.
 *
 * 激活排序靠 `ctx.inject([...])`，**不靠 yml 行序**：本函数先算出配置里出现的
 * 全部后端服务键（`storage.backend.<name>`），由 Cordis 等它们出现后才跑回调。
 * 因此「domain 插件配在前面而 Provider 在后面」也能正常工作，不会建成空 registry
 * 再去 `get` 一个还不存在的名字。
 * @param ctx - Plugin context.
 * @param rawConfig - Raw plugin config, validated by {@link normalizeConfig}.
 * @returns resolution after an already-available backend set activates the form.
 */
export function apply(ctx: Context, rawConfig: Config): Promise<void> {
  const config = normalizeConfig(rawConfig)
  const backendServices = [...new Set([
    config.backend,
    // normalizeConfig 恒返回 routes 对象（默认 {}）⇒ 右侧回退是死代码。
    ...Object.values(config.routes!),
  ])].map(storageBackendServiceKey)

  const fiber = ctx.inject(backendServices, (domainCtx) => {
    const facility = new DomainFacility(domainCtx, config)
    domainCtx.effect(() => {
      const unmount = domainCtx.storage.mount("domain", facility)
      return async () => {
        // Close leftovers before unmounting: draining writes still emit
        // domain/changed.
        await facility.closeAll()
        unmount()
      }
    })
    domainCtx.provide("storageDomain", facility)
  })
  return Promise.resolve(fiber).then(() => {})
}
