/**
 * 浏览器壳 boot 链（ISS-537 / P4-S1 · 甲形态 Vite 直连；ISS-538 / P4-S2 kb 三步流）。
 *
 * ## 甲形态（照 P4-0 问1 §1.7 裁决，待老板拍板已拍）
 *
 * Matter 是「单产品固定 UI 包集」，没有 DSH「多会话宿主按需装载插件」的消费者 ⇒
 * 不抄 `window.__DSH_BOOT__` / `__ModuleLoader__` 注入层。client 包当**静态 import 的 lib**
 * 直接由 Vite 打进 bundle；boot 只做三件必需事：建 cordis client context、装样式（各恰一次）、
 * 渲染根组件。将来 DSH 回挂走「补 closure-factory 产物面」远景（DOC-523 S 轨补充 2），不改 boot。
 *
 * ## 样式各恰一次（review-2305 观察项）
 *
 * `installThemeStyles` / `installDswBridgeStyles` 各自往 head 追加一个 `<style>`（client 半
 * 故意不去重，去重是装配责任）。本模块是那唯一的装配点：两个 install 各只调一次。
 * smoke 断言 head 里 `data-plugin="client-ui-theme"` 的 style 恰 2 条（theme + dsw-bridge）。
 * BlockNote 的 CSS 由 kb-shell / editor-demo 的 `installEditorStyles` 各自装配，data-plugin 不同，
 * 不与本契约冲突。
 *
 * ## kb 三步流（ISS-538）
 *
 * 根组件从 ISS-537 的「只渲染 DocList + data 属性」升级为 {@link KbShell}：列表 → 打开 →
 * 正文（真 BlockNote headless view）三步走全。数据在进程内（stub），N 轨 remote-gateway-wire
 * 后把 `stubLoadDoc` 换成真 `ctx.documents` 投影，renderSurface 不动。
 *
 * @module apps/web/src/boot
 */

import { Context } from "@deepseek-ai/cordis"
import { installDswBridgeStyles, installThemeStyles } from "@matter/client-ui-theme/client"
import { DocList, createRemoteDocumentsPort, type DocumentsPort } from "@matter/client-ui-kb/client"
import { createRoot, type Root } from "react-dom/client"
import { createElement } from "react"
import type { ShellConfig } from "./config.ts"
import { browserFetch, installRemoteClient } from "./remote-client.ts"
import type { RpcFetch } from "@deepseek-ai/dsh-client-connection/client"
import { KbShell, STUB_DOCS } from "./kb-shell.tsx"

/** boot 成功后交出的句柄：ctx 供后续轨挂服务，dispose 供 smoke/热替换清理。 */
export interface BootHandle {
  /** 自举的 cordis client context。 */
  readonly ctx: Context
  /** 已装好的取数端口（真机 = ctx.remote.document.* 投影；测试注入时 = 注入的 port）。 */
  readonly port: DocumentsPort
  /** 卸载：先 unmount React 根，再调样式/remote 的 disposer 摘除现场。 */
  dispose(): Promise<void>
}

/** boot 可注入项：真机走默认（browserFetch + ctx.remote）；测试可注入 port/fetch 避免起后端。 */
export interface BootOptions {
  /** 直接指定取数端口（跳过 remote 装配）；不传则装配 ctx.remote 真链。 */
  readonly port?: DocumentsPort
  /** 替换 RPC fetch 传输（Q5 测试把 host 共享 handler 接进来，非 mock）。 */
  readonly remoteFetch?: RpcFetch
}

/** in-process stub 文档行（N 轨换真 Remote 的唯一替换点；保留导出供 smoke 兼容）。 */
export function stubRows(): ReadonlyArray<{ id: string; title: string }> {
  return STUB_DOCS.map((d) => d.row)
}

/**
 * 自举浏览器壳：建 context → 装样式各一次 → 渲染根组件（kb 三步流）。
 *
 * @param root - React 挂载容器（index.html 的 `#root`）。
 * @param config - 已解析的壳配置（apiBase / embed）。
 * @returns BootHandle；调用 dispose 清理现场。
 */
export async function bootWeb(root: HTMLElement, config: ShellConfig, options: BootOptions = {}): Promise<BootHandle> {
  const ctx = new Context()

  // 两个 install 各恰一次——装配幂等责任在本调用点（client 半故意不去重）。
  const disposeTheme = installThemeStyles(ctx)
  const disposeBridge = installDswBridgeStyles(ctx)

  // N 轨真链：默认装配 ctx.remote（connection client + gateway client + $mount 投影）。
  // 测试可注入 port（跳过 remote）或 remoteFetch（host 共享 handler，真 fetch 非 mock）。
  let port: DocumentsPort | undefined = options.port
  let disposeRemote: (() => Promise<void>) | undefined
  if (port === undefined) {
    const remote = await installRemoteClient({
      fetch: options.remoteFetch ?? browserFetch(config.apiBase),
      apiBase: config.apiBase,
    })
    port = createRemoteDocumentsPort(remote.ctx)
    disposeRemote = remote.dispose
  }

  /** 自带 chrome（嵌入模式下不渲染，单页聚焦只留 ui-kb 表面）。 */
  const chrome = config.embed
    ? null
    : createElement("header", { "data-shell": "chrome" }, createElement("h1", null, "Matter"))

  // boot 是装配点：静态 import DocList 并注入 KbShell（verify-shell-boot 判据要求 boot 静态接线 DocList）。
  const app = createElement("div", { "data-shell": "app", "data-embed": String(config.embed) }, chrome, createElement(KbShell, { ListComponent: DocList, port }))
  const reactRoot: Root = createRoot(root)
  reactRoot.render(app)

  return {
    ctx,
    port,
    async dispose(): Promise<void> {
      reactRoot.unmount()
      await disposeRemote?.()
      // 两个 install 的 disposer 各自摘除自己的 <style>；root Context 无 dispose()
      //（dispose 是 fiber 的能力），故这里不调 ctx.dispose()。
      await disposeTheme()
      await disposeBridge()
    },
  }
}
