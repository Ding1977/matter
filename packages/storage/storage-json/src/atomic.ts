/**
 * Atomic whole-file replacement for the JSON backend.
 *
 * 发布协议：同目录临时文件 → `sync()` → `rename()` 覆盖目标 → fsync 父目录。
 * rename 在 POSIX 与 Windows（libuv 映射为 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`）
 * 都是原子替换，而**替换**正是本后端的语义 —— 与 session-log 后端的 `link()+unlink()`
 * 不覆盖协议不同：一个 unit 文档只有一个写者，last-write-wins 是对的。
 * rename 之后 fsync 父目录（POSIX），新目录项才在崩溃后仍然存在。
 *
 * 抄自 DSH `@deepseek-ai/dsh-storage-json/src/atomic.ts`（只改模块标识与注释语言，逻辑逐行一致）。
 * @module @matter/storage-json/src/atomic
 */

import { open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

/**
 * 用 `data` 原子且持久地替换 `path`。
 *
 * 失败路径一律 `rm(tmp, { force: true })` 清理临时文件：断电/崩溃/写盘报错时
 * **不能留下半成品**，也不能留下 `.tmp` 残渣（残渣不参与读取，但会累积）。
 * @param path - 目标文件的绝对路径。
 * @param data - 完整的新文件内容。
 * @returns 替换在崩溃后仍持久时 resolve。
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(tmp, "wx", 0o600)
    try {
      await handle.writeFile(data, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    await fsyncDirectory(dirname(path))
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * 在 POSIX 上持久化目录项变化；Windows 不支持该操作，跳过。
 * @param path - 目录的绝对路径。
 * @returns 目录已 sync（Windows 上立即 resolve）时 resolve。
 */
/* v8 ignore start -- Windows 拒绝以 O_RDONLY 打开目录；POSIX 覆盖本分支。 */
export async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */
