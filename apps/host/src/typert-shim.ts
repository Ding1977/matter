/**
 * 最小 TypertRegistryContract shim（ISS-542 / P4-N2 · 让链路通电）。
 *
 * Gateway host 读 `ctx.typert.local.get/hasSeen`（严格描述符）与
 * `ctx.typert.lookups/contexts/resources`；gateway client 读
 * `ctx.typert.remotes.register` 与 `ctx.typert.contexts.getClient`（$mount）。
 * P4 最小闭环只需要 owner + unary + 生成 codec，无跨进程 Context/lookup 投影 ⇒
 * 不引 typert-registry / api-remote-access / credentials 全套（spec §3.5 Known
 * Limitations）。这里给三角色的最小实现，所有"未用"分支有文档化的空行为。
 *
 * 事实来源唯一：描述符来自 2314 生成的 `TYPERT`（host）/`TYPERT_REMOTE`（client），
 * 不在本文件重写契约。
 *
 * @module apps/host/src/typert-shim
 */

import type {
  InvocationDescriptor,
  TypertDisposer,
  TypertRegistryContract,
  TypertRemoteContribution,
} from "@deepseek-ai/dsh-typert-protocol"

/** 一条 host 贡献（生成物形状：package / face / invocations / schemas / model）。 */
export interface GeneratedHostContribution {
  readonly package: string
  readonly face: string
  readonly invocations: readonly InvocationDescriptor[]
  readonly schemas?: readonly unknown[]
  readonly model?: unknown
}

/** 由生成 host 描述符构造的 registry shim 输入。 */
export interface TypertShimOptions {
  /** host 面描述符（TYPERT.invocations）；client 侧传空数组。 */
  readonly invocations?: readonly InvocationDescriptor[]
}

/** 一个订阅源：注册即副作用、返回 disposer（照 cordis 口径）。 */
function observers(): { add(listener: () => void): TypertDisposer; emit(): void } {
  const set = new Set<() => void>()
  return {
    add(listener) {
      set.add(listener)
      return () => { set.delete(listener) }
    },
    emit() {
      for (const listener of [...set]) listener()
    },
  }
}

/**
 * 构造最小 `TypertRegistryContract`。
 *
 * - `local`：严格描述符表，`get` / `hasSeen` / `list` / `subscribe`；`register` 写入并把
 *   endpoint `<namespace>/<method>` 作为键，`register` 的 disposer 只标记 hasSeen（不删键，
 *   照协议「撤回后 strict 定义仍算 seen」的语义）。
 * - `remotes`：client `$mount` 写进来的贡献集合，仅用于可观测（list/get）。
 * - `lookups` / `contexts` / `resources`：本闭环无 Context/lookup/resource 投影 → 空实现，
 *   但方法齐全，调用不会 undefined（边界显式优于隐式：空行为有文档，不静默跳过）。
 *
 * @param options - 初始 host 描述符。
 * @returns 可作为 `ctx.provide("typert", shim)` 的值（调用处按 cordis 口径 cast）。
 */
export function createTypertShim(options: TypertShimOptions = {}): TypertRegistryContract {
  const local = new Map<string, InvocationDescriptor>()
  const seen = new Set<string>()
  const remotes = new Map<string, TypertRemoteContribution>()
  const localChanges = observers()
  for (const descriptor of options.invocations ?? []) {
    local.set(`${descriptor.namespace}/${descriptor.method}`, descriptor)
    seen.add(`${descriptor.namespace}/${descriptor.method}`)
  }

  const shim = {
    local: {
      get: (endpoint: string) => local.get(endpoint),
      hasSeen: (endpoint: string) => seen.has(endpoint),
      list: () => [...local.values()],
      subscribe: (listener: () => void) => localChanges.add(listener),
      register: (descriptor: InvocationDescriptor): TypertDisposer => {
        const endpoint = `${descriptor.namespace}/${descriptor.method}`
        local.set(endpoint, descriptor)
        seen.add(endpoint)
        localChanges.emit()
        return () => { seen.add(endpoint) }
      },
    },
    remotes: {
      register: (contribution: TypertRemoteContribution): TypertDisposer => {
        remotes.set(contribution.package, contribution)
        return () => { remotes.delete(contribution.package) }
      },
      get: (packageName: string) => remotes.get(packageName),
      list: () => [...remotes.values()],
    },
    lookups: {
      definitions: () => [],
      get: () => undefined,
      register: () => () => {},
    },
    contexts: {
      getHost: () => undefined,
      getClient: () => undefined,
      registerHost: () => () => {},
      registerClient: () => () => {},
      configureHost: () => () => {},
    },
    resources: {
      get: () => undefined,
      register: () => () => {},
      entries: () => [],
    },
    // host 装配用 `ctx.typert.register(TYPERT)` 一次性注入生成贡献。
    register: (contribution: GeneratedHostContribution): TypertDisposer => {
      let live = true
      const disposers: TypertDisposer[] = []
      for (const descriptor of contribution.invocations) {
        disposers.push(shim.local.register(descriptor))
      }
      return () => {
        if (!live) return
        live = false
        // disposer 只标记 seen，不删 strict 键（协议语义）；这里仅释放订阅。
        for (const dispose of disposers) dispose()
      }
    },
  }

  return shim as unknown as TypertRegistryContract
}

/** 生成 host artifact 的最小投影（只取 gateway 需要的字段）。 */
export function hostContributionFrom(artifact: {
  readonly package: string
  readonly face: string
  readonly invocations: readonly InvocationDescriptor[]
}): GeneratedHostContribution {
  return {
    package: artifact.package,
    face: artifact.face,
    invocations: artifact.invocations,
  }
}
