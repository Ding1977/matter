/**
 * `verify-shell-boot` 的 spec（ISS-537 / W12 雏形判据）。
 *
 * 判据全部价值在「能判红」：正向（接线齐 ⇒ 绿）跑一次就过，必须证明
 * 「删 import / 装两次 / 塞注入层 token / 写死地址 / 缺载体」每条必红。
 *
 * 六类用例：
 *   ① 正向：真仓 apps/web 接线齐 ⇒ passed；
 *   ② 必然失败·import：删 installDswBridgeStyles 静态 import ⇒ 红；
 *   ③ 必然失败·各恰一次：把某 install 调用复制成两次 ⇒ 红且报调用点数 2；
 *   ④ 必然失败·甲形态：boot 里塞 __DSH_BOOT__ ⇒ 红；
 *   ⑤ 必然失败·配置：config 去掉 URL 注入通道 ⇒ 红；
 *   ⑥ 缺输入 + 真仓：0 文件 unjudged（不冒绿）+ 真仓 collectWebSources 绿。
 *
 * @module gates/verify-shell-boot.spec
 */
import { collectWebSources, INJECTION_TOKENS, judgeShellBoot, stripComments } from "./verify-shell-boot.ts"

const REPO = process.cwd()

let fails = 0
let total = 0
const ok = (name: string, cond: boolean): void => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

/** 一份「全绿」的最小构造语料（不依赖真仓，供变异对照）。 */
function goodCorpus(): Map<string, string> {
  return new Map([
    [
      "apps/web/index.html",
      '<!doctype html><div id="root"></div><script type="module" src="/src/main.ts"></script>',
    ],
    [
      "apps/web/src/boot.ts",
      [
        'import { installThemeStyles, installDswBridgeStyles } from "@matter/client-ui-theme/client"',
        'import { DocList } from "@matter/client-ui-kb/client"',
        "const ctx = new Context()",
        "installThemeStyles(ctx)",
        "installDswBridgeStyles(ctx)",
        "const app = config.embed ? surface : chrome",
        "createRoot(root).render(DocList({ rows }))",
      ].join("\n"),
    ],
    [
      "apps/web/src/config.ts",
      [
        "const query = new URLSearchParams(sources.search)",
        "const fromEnv = sources.env.VITE_SHELL_API_BASE",
        "const embed = query.get('embed') === '1'",
      ].join("\n"),
    ],
  ])
}

export function run(): boolean {
  // ① 正向
  ok("正向：接线齐 ⇒ passed", judgeShellBoot({ files: goodCorpus() }).status === "passed")

  // ② 必然失败：删静态 import
  {
    const files = goodCorpus()
    files.set("apps/web/src/boot.ts", (files.get("apps/web/src/boot.ts") ?? "").replace(/import \{ installThemeStyles, installDswBridgeStyles \}[^\n]*\n/, ""))
    const r = judgeShellBoot({ files })
    ok("删 installThemeStyles/installDswBridgeStyles 静态 import ⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail?.includes("未静态 import")))
  }

  // ③ 必然失败：某 install 装两次（review-2305 观察项的机器形态）
  {
    const files = goodCorpus()
    const boot = files.get("apps/web/src/boot.ts") ?? ""
    files.set("apps/web/src/boot.ts", boot.replace("installDswBridgeStyles(ctx)", "installDswBridgeStyles(ctx)\ninstallDswBridgeStyles(ctx)"))
    const r = judgeShellBoot({ files })
    ok("installDswBridgeStyles 调用点数 2 ⇒ failed 且报点数", r.status === "failed" && (r.findings ?? []).some((f) => f.detail?.includes("调用点数 = 2")))
  }

  // ④ 必然失败：甲形态注入层 token
  {
    const files = goodCorpus()
    files.set("apps/web/src/boot.ts", `${files.get("apps/web/src/boot.ts")}\nconst b = window.${INJECTION_TOKENS[0]}`)
    const r = judgeShellBoot({ files })
    ok("boot 塞 __DSH_BOOT__ ⇒ failed 且点名 token", r.status === "failed" && (r.findings ?? []).some((f) => f.detail?.includes("__DSH_BOOT__")))
  }

  // ⑤ 必然失败：config 无 URL 注入通道
  {
    const files = goodCorpus()
    files.set("apps/web/src/config.ts", "const apiBase = 'http://prod.internal'")
    const r = judgeShellBoot({ files })
    ok("config 写死地址 / 无 URL 注入 ⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail?.includes("URL query")))
  }

  // ⑥ 缺输入 + 真仓
  ok("0 源文件 ⇒ unjudged(no-corpus)（不冒绿）", judgeShellBoot({ files: new Map() }).status === "unjudged")
  const real = collectWebSources(REPO)
  ok(`真仓 apps/web 采集到源文件（${real.size} 个）`, real.size > 0)
  ok("真仓实扫 ⇒ passed（接线与判据一致）", judgeShellBoot({ files: real }).status === "passed")

  // 纯函数：stripComments 去注释但保留 token 之外的真实接线
  ok("stripComments：块注释里的 token 被摘除", stripComments("/* __DSH_BOOT__ */\nconst a=1").includes("__DSH_BOOT__") === false)
  ok("stripComments：行注释里的调用被摘除", stripComments("// installThemeStyles(ctx)\ninstallDswBridgeStyles(ctx)").includes("installThemeStyles(") === false)

  console.log(fails ? `✗ ${fails} 条不成立` : `✓ spec 全过（${total} 条断言：正向 / import / 各恰一次 / 甲形态 / 配置 / 缺输入 / 真仓）`)
  return fails === 0
}
