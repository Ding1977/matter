/**
 * JSON 存储后端：每条记录一个人类可读的文档，放在配置的 `root` 下 ——
 * 布局是 `per-record`（`<root>/<unit>/<table>/<key>.json`，全局槽是 `global.json`），
 * 由原子重写发布。作为后端 `json` 注册到 storage hub。
 *
 * 【两种布局】ISS-535 起本仓同时支持 `per-record` 与 `single`（views.json 是 single 的
 * 第一个消费者）。`descriptor.layout === "single"` 走整单元单文档（single-unit.ts），
 * 其余（含 `undefined`，保持历史默认）走 per-record —— 既有消费者全部不受影响。
 * ISS-510「Matter 只做 per-record」的决策在此由 views.json 的新需求取代。
 *
 * 【为什么不用 `@deepseek-ai/schemastery` 写 `Config`】DSH 原实现用
 * `z.object({ root: z.string().required() })`，但该包在本仓**不可得**
 * （工作树 `node_modules/@deepseek-ai/` 下无此包）。引入一个装不上的依赖换一行校验不值当，
 * 故 `Config` 用纯 TS `interface` + `normalizeConfig()` 做运行时校验 ——
 * 校验强度等价（必填、必须是字符串），且零新依赖。见交付说明的冲突 ②。
 *
 * ⛔ 本文件**不许** `export default`：函数插件入口带 default 会被 Loader 的
 * `unwrapExports`（`exports.default ?? exports`）解包成裸 `apply`，
 * 丢掉 `name`/`inject`/`Config` ⇒ fiber 用空 inject 建起来。判据：
 * `scripts/gates/verify-plugin-entry-exports.ts`（事故 postmortem 0001）。
 * @module @matter/storage-json
 */

import { mkdir } from "node:fs/promises"
import type { Context } from "@deepseek-ai/cordis"
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from "@matter/storage"
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from "@matter/storage"
import { openPerRecordUnit } from "./per-record-unit.ts"
import { openSingleUnit } from "./single-unit.ts"

/** Cordis 插件名。 */
export const name = "storage-json"

/** hub 必须先于本后端存在，否则注册无处可落。 */
export const inject = ["storage"]

/**
 * 插件配置。
 *
 * `root` **故意没有默认值**：退回 `process.cwd()` 会把 unit 文件散落到进程碰巧启动的
 * 任何目录；装配点必须显式声明位置。
 */
export interface Config {
  /** 存放每个 unit 一棵 `<unit>/` 目录树的根目录。 */
  root: string
}

/**
 * 校验并归一化配置。
 *
 * 在**加载时报错**（`AGENTS.md` 的约定：配置错误在加载时失败，不静默跳过）。
 * @param raw - 装配点传入的原始配置。
 * @returns 已校验的配置。
 */
export function normalizeConfig(raw: Config): Config {
  const root = (raw as { root?: unknown } | undefined)?.root
  if (typeof root !== "string" || root.length === 0) {
    throw new StorageError("malformed-medium", "storage-json: config.root must be a non-empty string")
  }
  return { root }
}

/** JSON 后端：拥有文件树根，提供 `kv` facet。 */
export class JsonStorageBackend implements StorageBackend {
  private readonly open = new Map<string, KvUnit>()
  // 在 open() 入口**同步**占位，使同一 unit 的并发 open 失败，
  // 并让 close() 能等待仍在飞的 open。
  private readonly opening = new Map<string, Promise<KvUnit>>()
  private closed = false

  /** @param root - 后端根目录绝对路径。 */
  constructor(private readonly root: string) {}

  /** `kv` facet：按记录粒度的读写。 */
  readonly kv: KvFacet = {
    // 函数体到第一个 await 之前同步执行，故下面的 opening 占位仍能排除同一 unit 的并发 open。
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.closed) throw new StorageError("closed", "json backend is closed")
      validateDescriptor(descriptor)
      if (this.open.has(descriptor.name) || this.opening.has(descriptor.name)) {
        // 重复打开是调用方 bug，不是介质状况。
        throw new StorageError("duplicate-mount", `unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
      }
      const opening = this.openUnit(descriptor)
      this.opening.set(descriptor.name, opening)
      return opening.finally(() => this.opening.delete(descriptor.name))
    },
  }

  /**
   * 打开一个 unit 并登记到「已打开」表。
   * @param descriptor - 已校验的 unit 描述符。
   * @returns 已打开的 unit。
   */
  private async openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const onClose = () => this.open.delete(descriptor.name)
    // `single` 只由显式声明触发；缺省与 per-record 都走逐记录布局（ISS-510 历史默认不变）。
    const unit = descriptor.layout === "single"
      ? await openSingleUnit(descriptor, this.root, onClose)
      : await openPerRecordUnit(descriptor, this.root, onClose)
    if (this.closed) {
      // 本 open 在飞时后端被关：不许在 close() 之后还交出可用的 unit。
      await unit.close()
      throw new StorageError("closed", "json backend is closed")
    }
    this.open.set(descriptor.name, unit)
    return unit
  }

  /** 排干所有在飞的 open 与已打开的 unit，释放介质。幂等。 */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.opening.values()])
    for (const unit of [...this.open.values()]) {
      await unit.close()
    }
  }
}

/**
 * 校验 unit 描述符：名字与表名都必须是路径/标识符安全的名字。
 * @param descriptor - 待校验的 unit 描述符。
 */
function validateDescriptor(descriptor: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError("malformed-medium", `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new StorageError("malformed-medium", `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}

/**
 * 在 storage hub 上注册 `json` 后端。
 *
 * ⚠️ 注销顺序**不可颠倒**：先 `unregister()` 摘掉名字，再 `await backend.close()` 关介质。
 * 反过来的瞬间里，并发写仍能通过注册表拿到**已关闭**的后端，现场表现是
 * 「偶发 closed 报错」而不是崩溃 —— 属于最难查的一类。
 * @param ctx - 插件上下文。
 * @param raw - 装配点配置，经 {@link normalizeConfig} 校验。
 */
export function apply(ctx: Context, raw: Config): void {
  const config = normalizeConfig(raw)
  const backend = new JsonStorageBackend(config.root)
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register("json", backend)
    ctx.provide(storageBackendServiceKey("json"), backend)
    return async () => {
      unregister() // ① 先注销名字
      await backend.close() // ② 再关介质
    }
  })
}
