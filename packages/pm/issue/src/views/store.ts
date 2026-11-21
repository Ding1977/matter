/**
 * views.json 的持久化 Store —— single layout + 防抖整组写 + 三态语义。
 *
 * ## 落盘形态
 *
 * 一个 unit 一份文档 `<root>/views.json`（storage-json 的 `single` layout，ISS-535 补回）。
 * 整份 `ViewConfig[]` 存 global 槽：一次 `setGlobal` = 整份原子发布，这也是「整组写」的落点。
 * 不改 storage-domain：本 Store 直接用 `KvFacet.open()` 开一个 raw unit（`layout: "single"`）。
 *
 * ## 三态（老板验收口径）
 *
 * | 盘上状态 | 行为 |
 * |---|---|
 * | 文件缺失 | 初始空态 `[]`，**不建文件、不冒绿**，物化推迟到首次写 |
 * | 文件损坏（JSON 坏 / 头不符 / 版本不符 / 值不合 schema） | **报错不吞**（StorageError 或 ZodError 原样抛） |
 * | 文件完好 | 读出整份 ViewConfig[]，按 schema 校验后交给调用方 |
 *
 * ## 防抖整组写
 *
 * 每次变更只改内存并（重新）起一个定时器；窗口内多次变更合并成**一次** `setGlobal(整组)`。
 * 默认 800ms（旧树 `pm-list-page-architecture.md:62` 先例，仅参考数值，本单定为 800）。
 * `flush()` 立即落盘；`close()` 先 flush 再关 unit，防丢在途变更。
 *
 * @module @matter/issue/src/views/store
 */

import type { KvFacet, KvUnit, KvUnitDescriptor } from "@matter/storage"
import { ViewConfig, ViewConfigList, type ViewConfig as ViewConfigT } from "./spec.ts"

/** views unit 的静态描述符：`views.json` 一份文档，整组放 global 槽。 */
export const VIEWS_DESCRIPTOR: KvUnitDescriptor = {
  name: "views",
  version: 1,
  tables: [],
  hasGlobal: true,
  layout: "single",
}

/** 防抖默认窗口（毫秒）。 */
export const DEFAULT_DEBOUNCE_MS = 800

/** Store 的可选参数。 */
export interface ViewsStoreOptions {
  /** 防抖窗口毫秒；测试可传小值或 0（0 = 不延迟，随后台微任务仍合并同一次同步变更）。 */
  debounceMs?: number
  /** 在途写在后台失败时的出声道；不传则只在内存记一笔（见 {@link ViewConfigStore.lastWriteError}）。 */
  onWriteError?: (error: unknown) => void
}

/**
 * views.json 的门面。持有内存权威状态与一个防抖定时器；所有 durable 写走 unit.setGlobal。
 * 生命周期由调用方拥有（`close()` 收尾）。
 */
export class ViewConfigStore {
  /** 最近一次后台写失败；成功写后清空。只读诊断用。 */
  lastWriteError: unknown

  private current: ReturnType<typeof ViewConfigList.parse> = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  /**
   * @param unit - 已打开的 single-layout KV unit。
   * @param debounceMs - 防抖窗口毫秒。
   * @param onWriteError - 后台写出声道。
   */
  constructor(
    private readonly unit: KvUnit,
    private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS,
    private readonly onWriteError?: (error: unknown) => void,
  ) {}

  /**
   * 打开 unit 并读出当前整组（三态在这里落地：缺失 → []，损坏 → 抛，完好 → 校验后返回）。
   * @param kv - 已挂载的存储后端 kv facet。
   * @param options - 可选参数。
   * @returns 已加载的 Store。
   */
  static async open(kv: KvFacet, options: ViewsStoreOptions = {}): Promise<ViewConfigStore> {
    const unit = await kv.open(VIEWS_DESCRIPTOR)
    const store = new ViewConfigStore(unit, options.debounceMs ?? DEFAULT_DEBOUNCE_MS, options.onWriteError)
    await store.reload()
    return store
  }

  /**
   * 重读整份视图配置。缺失 = 空态不冒绿；损坏 = 原样抛（StorageError / ZodError）。
   * @returns 当前整组（深拷贝，调用方改动不影响内存权威态）。
   */
  async reload(): Promise<ViewConfigT[]> {
    this.assertOpen()
    const snapshot = await this.unit.loadAll()
    const raw = snapshot.global
    // 文件缺失时 single-unit 交出 global=null；这里映射为空态，不写盘（不冒绿）。
    this.current = raw === null ? [] : ViewConfigList.parse(raw)
    return this.list()
  }

  /**
   * 取当前整组的浅拷贝快照。
   * @returns 视图配置数组（元素对象不共享引用由调用方自行保证）。
   */
  list(): ViewConfigT[] {
    this.assertOpen()
    return [...this.current]
  }

  /**
   * 按 id 取一份视图配置。
   * @param id - 视图 id。
   * @returns 命中项，未命中返回 `undefined`。
   */
  get(id: string): ViewConfigT | undefined {
    this.assertOpen()
    return this.current.find((view) => view.id === id)
  }

  /**
   * 新增或替换一份视图配置（按 id），随后安排防抖整组写。
   * @param view - 已校验（或待校验）的视图配置。
   */
  upsert(view: ViewConfigT): void {
    this.assertOpen()
    const parsed = ViewConfig.parse(view)
    const index = this.current.findIndex((item) => item.id === parsed.id)
    if (index < 0) this.current.push(parsed)
    else this.current[index] = parsed
    this.schedule()
  }

  /**
   * 按 id 删除一份视图配置（不存在是 no-op，不触发写），随后安排防抖整组写。
   * @param id - 视图 id。
   */
  remove(id: string): void {
    this.assertOpen()
    const next = this.current.filter((view) => view.id !== id)
    if (next.length === this.current.length) return
    this.current = next
    this.schedule()
  }

  /**
   * 整组替换（由调用方给全量），随后安排防抖整组写。
   * @param views - 待替换的整组视图配置。
   */
  replaceAll(views: ViewConfigT[]): void {
    this.assertOpen()
    this.current = ViewConfigList.parse(views)
    this.schedule()
  }

  /** 取消防抖定时器，立即把当前整组整份落盘。 */
  async flush(): Promise<void> {
    this.assertOpen()
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.unit.setGlobal(this.list())
    this.lastWriteError = undefined
  }

  /** 是否有在途的防抖写（测试与诊断用）。 */
  get hasPending(): boolean {
    return this.timer !== undefined
  }

  /**
   * 先 flush 在途写再关 unit。幂等。
   */
  async close(): Promise<void> {
    if (this.closed) return
    if (this.timer !== undefined) await this.flush()
    this.closed = true
    await this.unit.close()
  }

  /** 安排一次防抖写；窗口内重复调用只保留最后一次定时器。 */
  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch((error: unknown) => {
        this.lastWriteError = error
        this.onWriteError?.(error)
      })
    }, this.debounceMs)
  }

  private assertOpen(): void {
    if (this.closed) throw new ViewStoreClosedError()
  }
}

/** 对一个已关闭的 views Store 发起操作时抛出（类型化错误，非裸 throw）。 */
export class ViewStoreClosedError extends Error {
  constructor() {
    super("views store is closed")
    this.name = "ViewStoreClosedError"
  }
}
