// scripts/baseline-read-lib.mjs
// 门禁基线读取 —— 「读一份 JSON 基线，坏文件 fail closed」的唯一实现。
//
// 为什么要有它（ISS-564 修正 K6a 的一处误判）：
//   `读基线` 曾在 data-root-check / runtime-secret-check / test-env-restore-guard 三处
//   **逐字节相同（各 307 B，md5 一致）**，差别只有各脚本自己的 `BASELINE` 常量。
//   它此前被登记成「各脚本独立自洽、抽不出公共」—— 那是错的：把差异参数化后就是一份。
//   K6a 的原话：逐字节相同的多份没有任何理由存在，它不解决语义问题，只制造钉一致性的负担。
//
// 为什么放在 `-lib.mjs` 而不是 `scripts/lib/`：本仓既有约定就是 `scripts/<域>-lib.mjs`
//   （git-lib.mjs / wt-scan-lib.mjs / dead-exports-lib.mjs 等），脚本按需 import 该文件。
//   这与「各脚本自带 --selftest 自证」不冲突：被 import 的是纯函数，自检仍留在各自脚本里。
//
// 口径（三处调用方共用，改动只改这里）：
//   · 文件不存在 ⇒ 返回 null（"还没记基线"不是"零欠账"，由调用方自己喊）
//   · 解析失败   ⇒ 退出码 2 并出声（坏基线不许当成"没有欠账"，fail closed）
import fs from "node:fs"

/**
 * 读并解析一份 JSON 基线。
 * @param {string} file 基线文件绝对路径
 * @returns {any|null} 解析结果；文件不存在时 null
 */
export function 读基线(file) {
  if (!fs.existsSync(file)) return null
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch (e) {
    console.error("✗ 基线解析失败（" + file + "）：" + e.message + " —— fail closed，不许当成\"没有欠账\"")
    process.exit(2)
  }
}
