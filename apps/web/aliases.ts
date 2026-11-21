/**
 * apps/web 裸 Vite 直连的模块解析别名（ISS-537 / P4-S1 · 甲形态）。
 *
 * DSH 靠 pnpm 把 workspace 包链到 apps/web/node_modules；本仓 pnpm-workspace 只含
 * `<group>/<pkg>` 双段包（apps/ 不在射程），裸 specifier 从 apps/web/src 向上找不到 @matter
 * 系包与 cordis 的链接。甲形态不引入运行时注入层，改用**构建期 alias** 把 client 包指向其
 * client 源文件（Vite/vitest 共用同一份），这正是「静态 import client 包」的落地方式。
 *
 * 源 `.ts` 而非 lib：shell 与 client 包同仓，Vite 直接吃 source；`?inline` CSS 走 Vite
 * 管线（build 时内联进 bundle，vitest css:false 时 stub 成空串），与包自身测试一致。
 *
 * @module apps/web/aliases
 */

import { createRequire } from "node:module"
import path from "node:path"

// 用 cwd 而非 import.meta.url：Vite 8 把 config 打进主检出的临时目录再执行，
// 那里 import.meta.url 指向临时文件；而 build:shell / vitest 都从仓库根启动 ⇒ cwd 稳定。
/** 仓库根（脚本从仓库根启动）。 */
export const REPO_ROOT = process.cwd()

/** 从 ui-theme 包自身解析 cordis（它的 devDep 有 pnpm 链接），拿到单一实例绝对路径。 */
const requireFromUiTheme = createRequire(path.join(REPO_ROOT, "packages/client/ui-theme/package.json"))
const CORDIS_ENTRY = requireFromUiTheme.resolve("@deepseek-ai/cordis")

/** client 包的 client 面源文件。 */
const THEME_CLIENT = path.join(REPO_ROOT, "packages/client/ui-theme/src/client/index.ts")
const KB_CLIENT = path.join(REPO_ROOT, "packages/client/ui-kb/src/client/index.ts")
// ISS-538 / P4-S2：/editor-demo 夹具页消费 ui-blocks 的真编辑器（headless view + full schema）。
// apps/web 不在 pnpm-workspace，@matter/* 无链接，同 ui-kb/ui-theme 口径指向源。
const BLOCKS_CLIENT = path.join(REPO_ROOT, "packages/client/ui-blocks/src/client/index.ts")

// ISS-538 / P4-S2（Q3）：BlockNote 的 style.css 必须从它自己的 node_modules 解析出来
// （apps/web 无 @blocknote 链接）。从 ui-blocks 的 package.json 建 require 锚点，它声明了
// @blocknote/core + @blocknote/react 依赖、pnpm 链接齐全，resolve 得到真 CSS 绝对路径。
const requireFromUiBlocks = createRequire(path.join(REPO_ROOT, "packages/client/ui-blocks/package.json"))
const BN_CORE_CSS = requireFromUiBlocks.resolve("@blocknote/core/style.css")
const BN_REACT_CSS = requireFromUiBlocks.resolve("@blocknote/react/style.css")

/**
 * Vite / Vitest 共用的 alias 数组。
 *
 * cordis 用锚定正则（避免前缀误伤 `@deepseek-ai/cordis/*`）；三个 @matter 用精确字符串。
 * BlockNote 两条 CSS 用**前缀正则**（不收尾 `$`）：`import "@blocknote/core/style.css"` 与
 * `import css from "@blocknote/core/style.css?inline"` 都要命中——正则只替换前缀，`?inline`
 * 查询串原样留在结果 id 末尾（`.../dist/style.css?inline`），Vite/vitest 据此走内联 CSS 管线。
 */
export const WEB_ALIASES = [
  { find: /^@deepseek-ai\/cordis$/, replacement: CORDIS_ENTRY },
  { find: "@matter/client-ui-theme/client", replacement: THEME_CLIENT },
  { find: "@matter/client-ui-kb/client", replacement: KB_CLIENT },
  { find: "@matter/client-ui-blocks/client", replacement: BLOCKS_CLIENT },
  { find: /^@blocknote\/core\/style\.css/, replacement: BN_CORE_CSS },
  { find: /^@blocknote\/react\/style\.css/, replacement: BN_REACT_CSS },
] as const

/**
 * 仅 dev 用的别名（ISS-544 审查必修二：裸 vite 真渲染）。
 *
 * 根因：`@deepseek-ai/dsh-api-gateway/client` 与 `dsh-client-connection/client` 的
 * browser 入口 `lib/client.browser.js` 是 `window.__ModuleLoader__.load({id,factory})` 闭包包，
 * 无 Vite interop 要的 ESM export，且依赖宿主注入 `__ModuleLoader__` ⇒ 裸 vite 起 5173、
 * 浏览器无注入直接打开 = 白屏（vitest 走 node 条件变体，故模块测试全绿掩盖了它）。
 *
 * 修法甲（实测定夺）：dev 时把两条 `/client` 精确别名到各自包的 `lib/client.node.js`
 * ——这是**同一份源码的干净 ESM 产物**（原生 named export、零 `__ModuleLoader__`、零
 * `node:` 专有 import、全部依赖在包上下文可解析），vitest 一直走它所以模块测试全绿。
 * 浏览器可直接消费。`src/client/index.ts` 变体因源码引用了未随包发布的 `dsh-util-crypto`
 * （Vite 解析不到、加依赖=越界）故不采用；`build:shell` 路径不动——它走 browser 入口，
 * 由真实宿主在运行时提供 loader（与裸 dev 场景不同）。
 *
 * 从根 package.json 建 require 锚点（两包都是根 devDeps），解析出包目录后拼 node 产物入口。
 */
const requireFromRoot = createRequire(path.join(REPO_ROOT, "package.json"))
function clientCleanEntry(pkg: string): string {
  const pkgJson = requireFromRoot.resolve(`${pkg}/package.json`)
  return path.join(path.dirname(pkgJson), "lib", "client.node.js")
}
const GATEWAY_CLIENT_CLEAN = clientCleanEntry("@deepseek-ai/dsh-api-gateway")
const CONNECTION_CLIENT_CLEAN = clientCleanEntry("@deepseek-ai/dsh-client-connection")

export const CLIENT_DEV_ALIASES = [
  { find: "@deepseek-ai/dsh-api-gateway/client", replacement: GATEWAY_CLIENT_CLEAN },
  { find: "@deepseek-ai/dsh-client-connection/client", replacement: CONNECTION_CLIENT_CLEAN },
] as const

/**
 * 成品预览补的两条 dev-only alias（ISS-905 / designer D1 视觉审查交叉情报）。
 *
 * apps/* 不在 pnpm-workspace 射程，裸 vite 从 apps/web 向上找不到这两条 @matter 包：
 * - `@matter/blocks` 指向纯源（无构建产物依赖）；
 * - `@matter/document-controller/remote` 只有 generate-typert 产出的 lib 文件，
 *   指向它的 lib 入口（与包 exports 的 `./remote` 同文件，不是新契约）。
 * 只追加在 serve 分支，build:shell 路径完全不动。
 */
export const PREVIEW_DEV_ALIASES = [
  { find: "@matter/blocks", replacement: path.join(REPO_ROOT, "packages", "kb", "blocks", "src", "index.ts") },
  { find: "@matter/document-controller/remote", replacement: path.join(REPO_ROOT, "packages", "api", "document-controller", "lib", "typert.remote-client.js") },
] as const
