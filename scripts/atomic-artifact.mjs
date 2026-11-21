// 构建产物的**原子替换**写盘（ISS-906）。口径 = `matter/lib/write.js` 红线③「同目录临时文件 + rename」，
// 那份守的是工单数据，这里守的是插件产物 —— 同一个纪律，两处各有调用方，故不互引（产物写盘在
// 构建期、数据写盘在运行期，依赖方向不该相通）。
//
// 为什么必须原子：桌面端引擎在**每次请求**时按文件元数据算版本号并读字节（`artifactRevision`，
// 官方注释原文「without hashing its contents」）。`Bun.write` 是先 truncate 再写 —— 若引擎正好落在
// 这两步之间，读到的是**半截产物**：解析失败 ⇒ 该插件 entry 没有 fiber ⇒ 官方 web boot 把「一条
// entry 未激活」升级成**整页硬失败**（见 ISS-832）。而 `Cache-Control: immutable, max-age=1y` 按
// 版本号缓存，同一会话内刷新还会拿到同一份坏字节 —— 现象就是「只能重启」。
//
// rename 在同目录内是原子操作：调用方要么看到旧产物、要么看到新产物，永远不会看到半个文件。
import { renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/**
 * 原子写产物文件。
 * @param {string} target 目标路径（相对当前工作目录即可）
 * @param {string} text 产物全文
 */
export function writeArtifact(target, text) {
  const tmp = join(dirname(target), `.${basename(target)}.tmp-${String(process.pid)}-${String(Date.now())}`)
  try {
    writeFileSync(tmp, text, "utf8")
    renameSync(tmp, target)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原错（同 matter/lib/write.js 的取舍） */
    }
    throw err
  }
}
