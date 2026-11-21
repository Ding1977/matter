// 离屏截图器（ISS-854 验证用）—— 用**原地** Electron 二进制加载 http://127.0.0.1:3216 并截图。
//
// 用法（Electron 二进制 + 本目录作为 app）：
//   <home>/opencode/OpenForge/packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     --user-data-dir=<workspace 内路径> tools/verify-854/electron \
//     --url "http://127.0.0.1:3216/?token=..." --out out/01.png --width 1440 --height 900 --wait-ms 9000
//
// ⚠️ 本文件后缀必须是 `.cjs`（ISS-847）：仓根 package.json 有 "type": "module"，
//    `.js` 会被按 ESM 解析 ⇒ 下面的 require 直接 `require is not defined in ES module scope`。
//    作为 app 目录用时，目录内 package.json 要写 "main": "electron-offscreen-main.cjs"。
//   [--pre <js 文件>]   截图前在页面里执行（用于点开弹层等）
//   [--post-ms 800]     执行 --pre 后再等多久（等动画/portal 稳定）
//
// ⚠️ 两条踩过的坑（写在这里省得后人重踩）：
//   ① **不要拷贝 Electron.app**：拷贝会破坏代码签名 → `dyld: Library not loaded: @rpath/libffmpeg.dylib`。
//      必须用原地二进制。
//   ② Electron 默认往 `~/Library/Application Support/...` 写用户数据 —— 本仓沙箱会拒 ⇒
//      必须显式 `--user-data-dir=<workspace 内的路径>`。
const { app, BrowserWindow } = require("electron")
const fs = require("node:fs")
const path = require("node:path")

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const URL_ = arg("url")
const OUT = arg("out", "out/shot.png")
const WIDTH = Number(arg("width", "1440"))
const HEIGHT = Number(arg("height", "900"))
const WAIT = Number(arg("wait-ms", "9000"))
const POST = Number(arg("post-ms", "900"))
const PRE = arg("pre", "")

// 离屏窗口不需要 GPU；禁用可避免无显示器/沙箱环境下的取帧失败
app.disableHardwareAcceleration()
app.commandLine.appendSwitch("disable-gpu")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  })
  win.setContentSize(WIDTH, HEIGHT)

  const logs = []
  win.webContents.on("console-message", (_e, level, message) => logs.push(`[console:${level}] ${message}`))
  win.webContents.on("did-fail-load", (_e, code, desc, url) => logs.push(`[did-fail-load] ${code} ${desc} ${url}`))
  win.webContents.on("render-process-gone", (_e, details) => logs.push(`[render-gone] ${JSON.stringify(details)}`))

  try {
    await win.loadURL(URL_)
  } catch (err) {
    console.error("loadURL 失败：", err && err.message)
  }
  await sleep(WAIT)

  const ready = await win.webContents.executeJavaScript("document.readyState").catch((e) => `err:${e.message}`)
  const title = await win.webContents.executeJavaScript("document.title").catch((e) => `err:${e.message}`)
  console.log(`readyState=${ready} title=${JSON.stringify(title)}`)

  if (PRE) {
    const code = fs.readFileSync(PRE, "utf8")
    try {
      const result = await win.webContents.executeJavaScript(code, true)
      console.log("pre 结果：", typeof result === "string" ? result : JSON.stringify(result))
    } catch (err) {
      console.error("pre 执行失败：", err && err.message)
    }
    await sleep(POST)
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  const image = await win.webContents.capturePage()
  fs.writeFileSync(OUT, image.toPNG())
  console.log(`saved ${OUT} (${fs.statSync(OUT).size} bytes)`)
  if (logs.length) console.log("页面日志：\n" + logs.slice(-30).join("\n"))

  app.exit(0)
})
