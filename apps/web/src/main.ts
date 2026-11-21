/**
 * 浏览器入口（ISS-537 / P4-S1；ISS-538 / P4-S2 加 /editor-demo 路由）。
 *
 * 裸 Vite dev / build 都能跑（甲形态无 Host 注入门禁）：dev server 起在 apps/web，
 * build 产出 dist/index.html + 静态 bundle。两形态启动验证属 ISS-538 验收。
 *
 * ## 路由（ISS-538）
 *
 * `/editor-demo`（或 `/editor-demo?...`）挂真编辑器夹具；其余路径挂 kb 三步流壳（ISS-537）。
 * 路由按 `location.pathname` 判，纯前缀——不引入路由库（壳保持最小）。
 *
 * @module apps/web/src/main
 */

import { browserConfigSources, resolveConfig } from "./config.ts"
import { bootWeb } from "./boot.ts"
import { mountEditorDemo } from "./editor-demo.tsx"

const root = document.getElementById("root")
if (root === null) {
  throw new Error("web shell: missing #root")
}

const path = globalThis.location?.pathname ?? "/"
const isDemo = path === "/editor-demo" || path.startsWith("/editor-demo/")
const fail = (error: unknown) => {
  // 启动失败落到 DOM，便于真机/截图看到原因（不静默吞）。
  root.textContent = `web shell boot failed: ${error instanceof Error ? error.message : String(error)}`
  throw error
}

if (isDemo) {
  void mountEditorDemo(root).catch(fail)
} else {
  const config = resolveConfig(browserConfigSources())
  void bootWeb(root, config).catch(fail)
}
