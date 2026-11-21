/**
 * 浏览器壳的裸 Vite 配置（ISS-537 / P4-S1 · 甲形态）。
 *
 * 砍九件后只保留最小构建集：base './'（相对路径，嵌入宿主任意路径可挂）、react 单实例
 * dedupe（防 hooks/element identity 分裂）、client 包 alias（见 aliases.ts）。没有 react()
 * 插件也能跑——client 面组件用 `createElement`（无 JSX），Vite 原生 esbuild 转 .ts/.tsx。
 * 没有 rejectStandaloneServe——甲形态本就是裸 dev + 独立 backend。
 *
 * 导出**纯对象**而非 `defineConfig(...)`：vite 是 vitest 的间接依赖（不在根 package.json
 * 直接声明），Vite 8 把 config bundle 到临时目录后 `import "vite"` 解析不到（实测）。
 * 纯对象零 import，Vite 原生接受，避免新增 npm 依赖（写范围声明不新增 deps）。
 *
 * @module apps/web/vite.config
 */

import path from "node:path"
import { WEB_ALIASES, CLIENT_DEV_ALIASES, PREVIEW_DEV_ALIASES, REPO_ROOT } from "./aliases.ts"

/**
 * 函数式配置（ISS-544 审查必修二）：只在 dev（serve）追加 CLIENT_DEV_ALIASES。
 * 纯对象零 import 的既有形态保留为返回值——仍不 import "vite"，避开 Vite 8 config bundle
 * 解析不到 vite 的坑。`command` 由 Vite 注入，build:shell 时 === "build" ⇒ 不追加，
 * 生产路径完全不变（审查要求「别动 build:shell」）。
 */
/**
 * dev-only 的 /api 代理（ISS-905）：把 RPC 指到 host dev 的固定端口。
 *
 * - 只在 `command === "serve"` 挂载，build:shell 路径零变化。
 * - `changeOrigin` 保持 false：浏览器 Origin = Host = 127.0.0.1:<webPort>，
 *   connection 的 same-origin 栅栏与 cookie（按同一 authority 签署）同时成立。
 * - cookie 由 dev:preview 编排器从 host 的 token 握手结果注入（环境变量）；
 *   单独 `pnpm run dev` 不设 cookie 时退化为无 cookie 代理（登录态由使用者自理）。
 */
const previewApiPort = Number(process.env.MATTER_PREVIEW_API_PORT ?? 3212)
const previewCookie = process.env.MATTER_PREVIEW_COOKIE ?? ""

export default ({ command }: { command: "serve" | "build" }) => ({
  // cwd = 仓库根（build:shell/dev 脚本从根启动）；Vite 8 config bundle 会改写 import.meta.url，
  // 不能用它定位 root。
  root: path.join(REPO_ROOT, "apps", "web"),
  base: "./",
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: command === "serve"
      ? [...WEB_ALIASES, ...CLIENT_DEV_ALIASES, ...PREVIEW_DEV_ALIASES]
      : [...WEB_ALIASES],
  },
  // 审查必修二：这两条 /client 的 browser 入口是 __ModuleLoader__ 闭包包。若让 dep optimizer
  // 预打包，它会先于 alias 命中并把 import 改写成 .vite/deps 里的闭包产物 ⇒ alias 失效。
  // 排除出预打包 ⇒ 交给上面的 CLIENT_DEV_ALIASES 解析到干净的 src/client/index.ts。仅 dev。
  optimizeDeps: command === "serve"
    ? { exclude: ["@deepseek-ai/dsh-api-gateway/client", "@deepseek-ai/dsh-client-connection/client"] }
    : {},
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: Number(process.env.MATTER_PREVIEW_WEB_PORT ?? 5173),
    ...(command === "serve"
      ? {
          proxy: {
            "/api": {
              target: `http://127.0.0.1:${String(previewApiPort)}`,
              changeOrigin: false,
              ...(previewCookie === "" ? {} : { headers: { cookie: previewCookie } }),
            },
          },
        }
      : {}),
  },
})
