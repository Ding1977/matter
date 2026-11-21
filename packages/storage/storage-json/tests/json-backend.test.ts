/**
 * `@matter/storage-json` 的共享一致性套件执行点。
 *
 * ⚠️ 本文件的**存在理由**是把共享套件真的跑起来：断言一条都不许在这里另写，
 * 全部由 `runKvBackendContract` 提供。若哪天有人觉得「套件某个用例不合适」
 * 而在这里补一套自己的断言，Provider 的正确性就从「合契约」退化成「合作者想法」。
 *
 * 【布局口径：本文件只跑「两种布局共同」的子句】（ISS-512 修好了 ISS-510 报的冲突）
 * 共享套件**故意不声明 `layout`**，只断言跨布局都成立的子句 —— 两类布局差异子句已从
 * 套件里移除，归属见 `contract.ts` 文件头表格。本包（`per-record`）特有的语义留在
 * `per-record.test.ts`：不安全 key 写前拒绝、版本不符的文档读作不存在。
 *
 * ⇒ 这里**如实跑整套件**，不 `skip`、不 `todo`、不挑跑：套件绿就是真绿。
 * （不再需要「已知红标 todo」那种形态 —— 冲突解掉了，声明与事实一致。）
 *
 * @module @matter/storage-json/tests/json-backend
 */

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runKvBackendContract } from "../../storage/tests/contract.ts"
import { JsonStorageBackend } from "../src/index.ts"

runKvBackendContract("json", async () => {
  const root = await mkdtemp(join(tmpdir(), "matter-storage-json-"))
  return {
    backend: new JsonStorageBackend(root),
    reopen: async () => new JsonStorageBackend(root),
  }
})
