/**
 * Storage hub (`ctx.storage`): a named backend registry plus mounted
 * data-form facilities. The hub itself performs no IO — backends own media,
 * data forms (the domain layer first) own semantics.
 * @module @matter/storage
 */

import { Context, Service } from "@deepseek-ai/cordis"
import { StorageError } from "./error.ts"
import { BackendRegistry } from "./registry.ts"

export { BackendRegistry } from "./registry.ts"
export { StorageError } from "./error.ts"
export type { StorageErrorCode } from "./error.ts"
export { UNIT_NAME_RE } from "./backend.ts"
export type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from "./backend.ts"
export * from "./brand.ts"
export type * from "./types.ts"

/**
 * Derive the Cordis lifecycle service that one named backend plugin provides.
 * Domain-form providers inject these keys so activation cannot race backend
 * registration even though callers continue resolving backends through the
 * storage registry.
 * @param name - Backend registry name.
 * @returns the corresponding lifecycle-only service key.
 */
export function storageBackendServiceKey(name: string): string {
  return `storage.backend.${name}`
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    storage: Storage
  }
}

/**
 * Data forms mountable on the hub, keyed by form name. Form owners extend
 * this map via declaration merging (the domain layer merges
 * `domain: DomainFacility`) and mount the facility in their `apply`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StorageForms {}

/**
 * The storage hub service. Backends register under `backend`; data forms
 * mount under their `StorageForms` key and are reached as `ctx.storage.<form>`.
 *
 * ⛔ **没有 `Config`**：hub 零 IO ⇒ 无介质参数 ⇒ 无可配项。介质参数在 Provider
 * （`@matter/storage-json` 的 `Config.root`）。出处：DSH `storage/src/index.ts`
 * 里 `grep -c "export const Config"` ⇒ 0。
 */
export class Storage extends Service {
  /** Named backend table; multiple backends stay mounted side by side. */
  readonly backend: BackendRegistry = new BackendRegistry()

  private readonly forms = new Map<keyof StorageForms, unknown>()

  constructor(ctx: Context) {
    // `super(ctx, "storage")` 内部走 `ctx.reflect.provide()` —— 这一行就是挂载，
    // 服务随 owning fiber 自动卸载。⛔ 不要再手写 `ctx.provide("storage", this)`。
    super(ctx, "storage")
  }

  /**
   * Mount a data-form facility on the hub. Mounting is an effect: the
   * returned disposer unmounts the form.
   * @param form - Form key declared in {@link StorageForms}.
   * @param facility - The facility instance to expose.
   * @returns the disposer that unmounts the form.
   */
  mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void {
    if (this.forms.has(form)) {
      throw new StorageError("duplicate-mount", `storage form '${String(form)}' is already mounted`)
    }
    this.forms.set(form, facility)
    return () => {
      // 与 BackendRegistry.register 同一条 stale-disposer 守卫：只卸自己挂的那个。
      if (this.forms.get(form) === facility) this.forms.delete(form)
    }
  }

  /**
   * Resolve a mounted data form.
   * @param form - Form key declared in {@link StorageForms}.
   * @returns the mounted facility.
   */
  form<K extends keyof StorageForms>(form: K): StorageForms[K] {
    if (!this.forms.has(form)) {
      throw new StorageError("form-not-mounted", `storage form '${String(form)}' is not mounted`)
    }
    return this.forms.get(form) as StorageForms[K]
  }

  /** Domain data form; present once the domain layer plugin is loaded. */
  get domain(): StorageForms extends { domain: infer D } ? D : never {
    return this.form("domain" as keyof StorageForms) as StorageForms extends { domain: infer D } ? D : never
  }
}

// 服务包默认导出服务类，**不混 `export function apply`**：混用会让 Loader 的
// `unwrapExports`（`exports.default ?? exports`）拿到裸 apply 而丢掉整个命名空间。
// 判据：scripts/gates/verify-plugin-entry-exports.ts。
export default Storage
