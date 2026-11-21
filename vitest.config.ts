// vitest.config.ts —— ISS-503：并存期 vitest 入口（`bun test` 保留不删，随时可回）
//
// 每一条都对应一个实测到的坑，不是猜的。
//
// ① （已删）曾有一条把 bun 的测试模块名指到 `vitest` 的 alias —— ISS-505 把 553 个测试
//    文件的 import 全部改成 `from "vitest"` 后没有存在必要了。保留它反而有害：新写的测试
//    若误用那个旧模块名会被**静默**接住，等到某天在真 bun 下跑才炸。
//
// ② `include` 必须含 .js **和 .mjs**
//    本仓 .test.js 是既有形态（forge-model 28 个、forge-pm 一大批）；.test.mjs 另有一批
//    （forge-repowiki 17 个 + scripts 11 个）。只写 `{ts,tsx}` 会**静默漏掉**它们 ——
//    症状是「文件数远小于 bun test」，不报错。
//    ⚠️ ISS-505：`.mjs` 与 `scripts/` 是被**单独漏掉**的一批 —— 上一版 include 只有
//    `forge-*/**/*.test.{ts,tsx,js,jsx}`，于是 29 个 .test.mjs 一个都没进过 vitest，
//    而屏幕上没有任何一行说「它们没跑」。现在两处都补上（scripts 走第二个 pattern）。
//
// ③ `exclude` 必须挡 `.wt/`
//    工作树建在仓库内（`.wt/<ISS>`）。不挡会扫进各在途工作树的测试
//    （实测 4162 文件 / 52273 测试，跑 119s 后 Node 堆崩）。
//
// ④ `server.deps.inline` 必须内联 `@deepseek-ai/dsh-client-*`
//    这些包 lib/ 里 `import "./X.module.css"`。外部化走后按原生 ESM 加载 ⇒
//    `TypeError: Unknown file extension ".css"`（实测拖垮 4 个测试文件）。
//    内联后由 Vite 的 CSS 管线接住。（`test.css: true` 单独加**无效**，已实测排除。）
//
// ⑤ `setupFiles`：把 `globalThis.navigator` 还原成可写（Node 24 只给 getter，Bun 给可写数据属性）
//    详见 vitest.setup.ts。
//
// ⑥ `testTimeout` 必须放宽到 30s（默认 5s）
//    实测（ISS-505 迁移基线）：5 个 jsdom 渲染类用例在**全量并发**下超 5s，而单独跑
//    2.5s 就过 —— 即失败与用例本身无关，是并发下 vite 转换/jsdom 装载的资源竞争。
//    bun test 没有这个默认上限，故迁移前它们是绿的。压到默认值等于把「机器忙」判成「断言红」。
//    ⚠️ 不放宽 hookTimeout：beforeAll 里若有死循环，30s 与 5s 都是红，但 5s 报得更快。
import { defineConfig } from "vitest/config"
import ts from "typescript"

// ISS-533 / P3-U3（Lead 裁定「甲」，单内 note）：document-controller 的 @Remote 是标准
// TypeScript 装饰器，vitest 4 的 rolldown/oxc 解析器不支持 ⇒ 源码装载即 SyntaxError。
// 逐行照抄 DSH `vitest.shared.ts` 的 standardDecoratorPlugin（ts.transpileModule 预转换 +
// v8 ignore 编译器合成访问器），只注册 pre 插件、只命中有 @ 装饰器的 ts/tsx，零扩散。
const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m
function standardDecoratorPlugin() {
  return {
    name: "dsh-standard-decorators",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      const file = id.split("?", 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith("x") ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText
          .replace(
            /^(\s*)(__esDecorate\()/gmu,
            "$1/* v8 ignore next -- compiler-synthetic decorator accessors have no source behavior */ $2",
          )
          .replace(/\n?\/\/# sourceMappingURL=.*$/u, "\n"),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    include: [
      "forge-*/**/*.test.{ts,tsx,js,jsx,mjs}",
      "scripts/**/*.test.mjs",
      // 新树（packages/<group>/<pkg>/）。不加这条 ⇒ 新树测试永不跑，且屏幕上没有任何一行
      // 说它们没跑 —— 与 ISS-505 漏掉 .mjs / scripts/ 是同一形态（症状只有「文件数远小于预期」）。
      "packages/*/*/tests/**/*.test.{ts,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.wt/**",
      "**/wt/**",
      "**/dist/**",
      // node:test 形态的两个文件（lint-code / build-index-credential）：用 `node --test` 跑，
      // 不是 vitest 的 describe/test 形态 ⇒ 收进来只会报「No test suite found」。
      // ⚠️ 它们**当前没有任何执行路径在跑**（inline-gates 只跑 scripts/*.test.mjs 的 vitest 那批）
      // —— 已另行报缺陷，不在本单扩范围修。见 ISS-505 note。
      "scripts/lint-code.test.mjs",
      "scripts/tests/build-index-credential.test.mjs",
    ],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30_000,
    // ⑦ coverage（ISS-505）：provider 用 v8，与 vitest 主版本严格同号（4.1.8）。
    //    ⚠️ 只在带 --coverage 时生效；默认跑测试**不**收集覆盖率（那会让每次测试慢一截）。
    //
    //    ⓘ **采集状态只看一格，不看这段注释**（ISS-513）：`verify-coverage-collect`。
    //       `node scripts/run-gates.mjs --only verify-coverage-collect` ⇒ 绿=采得到 / 红=采集断了。
    //       旧版这里写的是「配置就位但采不到数据（0 个文件）」—— 那句在 ISS-513 之后**不再成立**
    //       （真因是下面 `exclude` 的 `**/wt/**`，见 ⑧），留着它就会与事实相反地劝人「别用覆盖率」。
    //
    //    ⑧ `coverage.exclude` 的匹配基准是**绝对路径**，`test.exclude` 的相对路径（ISS-513）
    //       原两条 exclude 各含一份 `**/wt/**`。`test.exclude` 那份只挡「工作树建在仓内 `.wt/`」，
    //       因为测试发现走仓库相对路径；而覆盖率过滤走绝对路径 ⇒ 默认落点 `~/wt/dsh-forge/<ISS>`
    //       （`scripts/ws.sh:53`）里每个文件都含 `/wt/` 段 ⇒ **整棵树被排除，采到 0 文件**，
    //       且屏幕上没有一行说「被排除了」。实测（2026-11-16，本仓 ISS-513 工作树）：
    //         · 原样跑 `vitest run packages/storage --coverage` ⇒ `Statements: Unknown% ( 0/0 )`
    //         · 仅删掉 `coverage.exclude` 的 `**/wt/**` ⇒ 831 条目 / 新树 10 条
    //       故第四项收窄为 `**/.tmp/wt/**`（`ws.sh` 的第三种落点，`:965`），只挡仓内。
    //       ⚠️ 同一条 glob 在两处含义不同，是本次实测出来的非对称性 —— 别「顺手统一」。
    coverage: {
      provider: "v8",
      // ISS-522（C-0a）：加 "json" 产出 coverage-final.json，给 verify-coverage-threshold 的判词提供
      // `文件:行:列` 行号 —— perFile 100 的原生 ERROR 没有行号（实测），人拿到不知道删代码还是补测试。
      // DSH 的 reporter 搬不动（istanbul-lib-report 从 scripts/ 解析不到，MODULE_NOT_FOUND），
      // 判据自己读 json 产物生成判词，零新依赖。三个 reporter 并存，各管一样。
      reporter: ["text-summary", "json-summary", "json"],
      // `packages/*/*/src/**` = 新树。缺它则新树 0 文件在射程（ISS-513 修前就是这条）。
      // ⚠️ ISS-516：旧树两条（`forge-*/src/**`、`forge-*/lib/**`）已删。它们是 ISS-513
      //    「加新树」时没删的遗留，`coverage.include` 里**零消费者**：唯一的读取方
      //    `verify-coverage-collect` 只数含 `/packages/` 的条目（`verify-coverage-collect.ts:119`）。
      //    留着它们的代价是**把旧树 821 个文件塞进分母**：实测 Statements 恒为 1.02%
      //    （685/66915），看不出新树真实覆盖；采集耗时也多 5.4s。
      //    ⚠️ 本项**只管统计面，不影响跑什么测试** —— 跑哪些测试看上面的 `test.include`。
      include: ["packages/*/*/src/**"],
      exclude: ["**/*.test.*", "**/node_modules/**", "**/dist/**", "**/.wt/**", "**/.tmp/wt/**"],
    },
    server: { deps: { inline: [/@deepseek-ai\/dsh-client/] } },
  },
})
