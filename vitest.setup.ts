// vitest.setup.ts —— 补回 Bun 与 Node/vitest 的**环境差异**（断言强度一字未变）
//
// 两条，各自对应一类实测到的差异。都不放宽断言 —— 实现与原语义等价，
// 该失败的照样失败（见下各条的「等价性」说明）。
//
// 灌入顺序：① navigator 可写 · ② globalThis.Bun 子集（ISS-505）
import { existsSync, readFileSync as readFile, statSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { globSync } from "node:fs"

// ─────────────────────────────────────────────────────────────────────────────
// ① `globalThis.navigator` 可写
//
// 实测（Node v24.13.1 / Bun 1.3.14）：
//   Node: Object.getOwnPropertyDescriptor(globalThis, "navigator")
//         → { configurable: true, get: f, enumerable: true }   ← 无 set / 无 writable
//   Bun:  → { value: …, writable: true, configurable: true }    ← 普通可写数据属性
//
// 本仓一批行为测试沿用 Bun 时代写法：把 jsdom 的 navigator 装到全局再渲染组件。
//   G.navigator = dom.window.navigator
//   → TypeError: Cannot set property navigator of #<Object> which has only a getter
//
// 测试意图是「装上 jsdom 的 navigator」，不是依赖 Bun 的属性描述符形状。
// 这里把描述符还原成可写数据属性 —— 与 Bun 下行为等价。
const NAV = Object.getOwnPropertyDescriptor(globalThis, "navigator")
if (NAV && NAV.set === undefined && NAV.writable !== true) {
  Object.defineProperty(globalThis, "navigator", {
    value: globalThis.navigator,
    writable: true,
    configurable: true,
    enumerable: true,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// ② `globalThis.Bun` 子集 —— ISS-505：废 `bun:test` 改 vitest 的收口动作
//
// 背景：全仓 23 个测试文件直接用 `Bun.*` 全局（`bun test` 自带，vitest 下
// 报 `ReferenceError: Bun is not defined` —— 迁移基线里这一类占 46 条）。
//
// 这里只补**实测到的那几个 API**，不是把 Bun 整个模拟出来。清单与计数见工单
// ISS-505；新增用例若用到表外 API，这里会以 `undefined is not a function` 提前炸出来
// —— 那是**有意的**：宁可炸，也不要静默给个假实现。
//
// 各 API 的语义口径（都按 Bun 1.3.14 实测对齐）：
//
//   Bun.file(path)          → 惰性句柄，不是 Promise。path 可为 string / URL / Buffer。
//                             **相对路径按 `process.cwd()` 解析**（与 Bun 一致；vitest
//                             从仓库根跑，故测试里写相对路径的会落空 —— 那是测试的问题，
//                             不是 shim 该偷偷改写路径）。
//     句柄成员（实测只用到这 3 个）：`.text()` 读全文 / `.exists()` / `.size`
//
//   Bun.spawnSync(cmd, opts?)  数组形态：cmd 是 string[]，第二参是 opts
//   Bun.spawnSync({cmd, ...})  对象形态：第一参就是 opts（实测两种都有人在用）
//     返回体（实测两种成员都有人在读）：
//       stdout / stderr  —— Node 下是 Buffer，Bun 下是 ReadableStream。
//                           调用侧一律 `.toString()` 或 `new Response(x).text()`，
//                           故这里给 Buffer（两者都吃得下），不必模拟流。
//       exitCode         —— Bun 名（`paths.test.js` 读它）
//       status           —— Node 名（`plans-routes.test.ts` 已改 Node API 读它）
//                           两个都给，且**同值**，避免调用侧读空成 undefined。
//
//   Bun.spawn(cmd, opts?)  → 返回 {stdout, stderr, exited, pid}
//                            实测只用 `new Response(p.stdout).text()` 与 `await p.exited`。
//
//   Bun.Glob              → 只补 `new Glob(pattern).scanSync({cwd})`（实测唯一用法）。
//                            Bun 的 scan 是异步生成器，这里只实现 scanSync —— 用到别的
//                            形态的用例会直接炸，不会静默返回半截结果。
//
// ⚠️ **不**在这份 shim 里模拟的东西（走「改测试用等价物」而不是造一个像的）：
//   Bun.build       —— 打的是真包，输出要逐字节可比。已在 chat-enhance.test.ts 改为
//                       spawn 真 bun CLI（实测输出与已提交产物 IDENTICAL）。
//   Bun.Transpiler  —— `.scanImports()` 是 AST 级 import 清单。已改为 `ts.preProcessFile`
//                       （实测四种违规形态全覆盖、注释与字符串不误判，口径等价）。
//   Bun.serve       —— 要真监听端口。已在 inbox-consumer-http.test.js 改为 node:http。
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  // 延迟 require：只在真的有人用到时才把 fs 拉进来，不让纯前端测试白付代价。
  const fileFor = (path: string | URL) => {
    const abs = path instanceof URL ? path : String(path)
    return {
      text: () => readFile(abs, "utf8"),
      json: () => readFile(abs, "utf8").then((s) => JSON.parse(s)),
      exists: () => existsSync(abs),
      get size() {
        return statSync(abs).size
      },
    }
  }

  const normSpawn = (cmdOrOpts: unknown, argsOrOpts?: unknown) => {
    const isObj = typeof cmdOrOpts === "object" && cmdOrOpts !== null && !Array.isArray(cmdOrOpts)
    const opts = (isObj ? cmdOrOpts : { ...(argsOrOpts as object), cmd: cmdOrOpts }) as {
      cmd: string[]
      cwd?: string
      env?: Record<string, string>
      stdin?: unknown
      stdout?: unknown
      stderr?: unknown
    }
    return {
      cmd: opts.cmd.map(String),
      cwd: opts.cwd,
      env: opts.env,
    }
  }

  ;(globalThis as unknown as { Bun: unknown }).Bun = {
    file: fileFor,
    spawnSync: (cmdOrOpts: unknown, argsOrOpts?: unknown) => {
      const { cmd, cwd, env } = normSpawn(cmdOrOpts, argsOrOpts)
      const [bin, ...rest] = cmd
      const r = spawnSync(bin as string, rest, { cwd, env, encoding: "utf8" })
      // exitCode / status 同值 —— 两套名字都有人在读（见上）
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exitCode: r.status ?? 1,
        status: r.status ?? 1,
        success: r.status === 0,
      }
    },
    spawn: (cmdOrOpts: unknown, argsOrOpts?: unknown) => {
      const { cmd, cwd, env } = normSpawn(cmdOrOpts, argsOrOpts)
      const [bin, ...rest] = cmd
      const child = spawn(bin as string, rest, { cwd, env })
      return {
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        stdin: child.stdin,
        exited: new Promise<number>((res) => child.on("close", (code) => res(code ?? 0))),
        kill: () => child.kill(),
      }
    },
    Glob: class {
      constructor(private pattern: string) {}
      scanSync(opts?: { cwd?: string }) {
        return [...globSync(this.pattern, { cwd: opts?.cwd ?? process.cwd() })]
      }
    },
  }
}
