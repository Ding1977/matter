/**
 * Journal 的开库序列：文件权限、pragmas、`application_id` 分流、派生层重建。
 *
 * ## 为什么版本轴是 `application_id` 而不是 `user_version`（硬约束 ②）
 *
 * `user_version` 在本仓已被 `@deepseek-ai/dsh-storage-sqlite` 占用为**它的**物理布局版本号，
 * 且它的门禁只认 `0` / `1`（`storage-sqlite/src/schema.ts:112-119` 逐字）：
 *
 * ```ts
 * if (onDisk !== 0 && onDisk !== STORAGE_SQLITE_SCHEMA_VERSION) throw version-mismatch
 * ```
 *
 * ⇒ 同一个 `.db` 文件若先被 journal 写成 `user_version = 1`，再看 storage-sqlite 就**恰好看不出问题**
 * （1 是它的合法值），而反过来 journal 看到的 `user_version` 是别人写的 ⇒ 两套版本轴互相踩。
 * 更坏的是它**不报错**：两个包都以为自己独占那个号。
 *
 * 故 journal 走 DSH `session-query-sqlite` 的正式形态（`schema.ts:8-11,58-67`）：
 * 用 `PRAGMA application_id` 声明「这个文件是谁的」，`user_version` 完全不碰。
 * 打开时按 `application_id` 三态分流：`0` + 空库 = 新库；等于本包 = 认领；
 * 其它值 = **别人的库，拒开**（`foreign-database`）。
 *
 * @module storage-journal/src/schema
 */

import { mkdir, open } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { JournalError } from "./error.ts"

/**
 * 本包的 SQLite `application_id`。
 *
 * 取值没有魔法：`0x4D4A524E` = ASCII `MJRN`（Matter Journal）。**必须避开**
 * `0x44534851`（DSH `session-query-sqlite`，`schema.ts:11`）与 `0x44534853`
 * （DSH `storage-sqlite` 的同类声明）—— 撞号等于把「这是谁的库」这个问题答错，
 * 而它正是本文件存在的理由。
 *
 * ⚠️ 改这个常量 = 让所有既有库变成「别人的库」而拒开。不要改。
 */
export const JOURNAL_APPLICATION_ID = 0x4d4a524e

/**
 * 派生层（`pm_search`）的形状版本，写在 `journal_meta` 表里而**不是** `user_version`。
 *
 * 非当前值 ⇒ `resetDerivedSchema()` 丢掉派生物重建。真相源（`activity_log`）**永不清** ——
 * 这是「search 是派生物」那条硬约束的机器形态：派生层可以随时扔，扔了能重建。
 */
export const JOURNAL_SCHEMA_VERSION = 1

/** 真相源的 DDL。它承载唯一不可重建的数据，**任何 reset 路径都不许碰它**。 */
const DDL_JOURNAL = `
CREATE TABLE IF NOT EXISTS activity_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity       TEXT NOT NULL,
  event        TEXT NOT NULL,
  actor        TEXT,
  at           INTEGER NOT NULL,
  known        INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT,
  md_at        TEXT,
  uid          TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS activity_uid_idx ON activity_log(uid);
CREATE INDEX IF NOT EXISTS activity_entity_idx ON activity_log(entity, seq);
CREATE TABLE IF NOT EXISTS journal_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version   INTEGER NOT NULL
) STRICT;
`

/**
 * 派生层的 DDL（`pm_search` FTS5 + 边视图）。
 *
 * `tokenize = 'trigram'` 不是口味问题：FTS5 默认的 `unicode61` 把一整串 CJK 当一个 token，
 * 中文子串**一个都命不中**（旧树 `search-index.js` 头注实测记录）。trigram 按三字符切，
 * 中文/英文子串都能命中，代价是查询串必须 ≥3 字符 —— 短串走 `LIKE` 兜底。
 *
 * `edges` 表是 `activity_log.payload_json` 的**投影**，不是独立真相源：
 * 它由 `rebuild()` 从真相源重算，随时可 DROP。
 */
const DDL_DERIVED = `
CREATE VIRTUAL TABLE IF NOT EXISTS pm_search USING fts5(
  entity UNINDEXED,
  title,
  body,
  keys,
  tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS edges (
  src  TEXT NOT NULL,
  kind TEXT NOT NULL,
  dst  TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  PRIMARY KEY (src, kind, dst)
) STRICT;
CREATE INDEX IF NOT EXISTS edges_dst_idx ON edges(dst, kind);
`

/** 派生层的全部对象名（reset 与自检共用；`pm_search` 的 shadow 表由 FTS5 自己管）。 */
const DERIVED_OBJECTS = ["pm_search", "edges"] as const

/**
 * 独占创建一个新库文件，权限 `0600`；已存在则原样保留。
 * @param path - 绝对路径。
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, "wx", 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

/** 库里的用户表（不含 `sqlite_*` 与 FTS5 的影子表）。 */
function listUserTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .all() as Array<{ name: string }>
  // FTS5 的 shadow 表（`pm_search_data` 等）不以 sqlite_ 开头，但它们不是「谁的用户表」的证据
  return rows.map((row) => row.name).filter((name) => !/^pm_search_/.test(name))
}

/**
 * 打开（必要时创建）journal 库并把 schema 收敛到当前版本。
 *
 * 分流的三种情形（每种都有测试钉住）：
 * 1. `application_id = 0` 且无用户表 ⇒ 新库，认领 + 建 schema。
 * 2. `application_id = JOURNAL_APPLICATION_ID` ⇒ 自己的库，按 `journal_meta.version` 决定是否重建派生层。
 * 3. 其它 `application_id`，或 `0` 但**已有用户表** ⇒ `foreign-database` 拒开。
 *    第 3 种的后者最要紧：`0` + 有表说明那个文件是由**不知道 application_id 的**代码写的，
 *    认领它等于把别人的数据当成自己的。
 *
 * @param path - 库文件路径，或 `:memory:`（测试用）。
 * @param journalMode - 已校验的 journal pragma 值（闭联合，不是调用方拼的 SQL）。
 * @returns 打开并初始化完毕的句柄，调用方负责 `close()`。
 * @throws {@link JournalError} `foreign-database`（别人的库）/ `io`（文件系统失败）。
 */
export async function openJournalDatabase(
  path: string,
  journalMode: JournalMode = "wal",
): Promise<DatabaseSync> {
  const actual = path === ":memory:" ? path : resolve(path)
  if (actual !== ":memory:") {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 }).catch((error: unknown) => {
      throw new JournalError("io", `storage-journal: cannot create directory for "${actual}"`, { cause: error })
    })
    await createDatabaseFile(actual)
  }
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(actual)
  try {
    const { application_id: applicationId } = db.prepare("PRAGMA application_id").get() as {
      application_id: number
    }
    const userTables = listUserTables(db)
    assertDatabaseIdentity(actual, applicationId, userTables)
    // 只在自己（或空）库上改 pragma：拒绝别人的库必须发生在任何写之前。
    // journalMode 是闭联合，插值安全（PRAGMA 不支持绑定参数）。
    db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
    db.exec("PRAGMA foreign_keys = ON")
    ensureJournalSchema(db)
    ensureDerivedSchema(db)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

/** `application_id` 三态分流（见 {@link openJournalDatabase} 的 1/2/3）。 */
function assertDatabaseIdentity(actual: string, applicationId: number, userTables: readonly string[]): void {
  if (applicationId === JOURNAL_APPLICATION_ID) return
  if (applicationId !== 0) {
    throw new JournalError(
      "foreign-database",
      `storage-journal: database at "${actual}" belongs to another application (application_id=0x${applicationId.toString(16)})`,
    )
  }
  if (userTables.length > 0) {
    throw new JournalError(
      "foreign-database",
      `storage-journal: database at "${actual}" has user tables but no application_id (${userTables.join(", ")}) — `
        + `refusing to claim a database written by code that does not declare its identity`,
    )
  }
}

/** 建真相源 schema 并盖 `application_id`。真相源永不 reset。 */
function ensureJournalSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA application_id = ${JOURNAL_APPLICATION_ID}`)
  db.exec(DDL_JOURNAL)
}

/**
 * 建派生层；`journal_meta.version` 不是当前值时先清掉派生物再建。
 *
 * ⚠️ `journal_meta` 本身在真相源那一侧（它记的是真相源的版本），所以 reset 只丢
 * `DERIVED_OBJECTS` 里的两个 —— 把 `journal_meta` 也丢掉会让版本无从判断。
 */
function ensureDerivedSchema(db: DatabaseSync): void {
  const stamp = db.prepare("SELECT version FROM journal_meta WHERE singleton = 1").get() as
    | { version: number }
    | undefined
  if (stamp === undefined) {
    db.prepare("INSERT INTO journal_meta (singleton, version) VALUES (1, ?)").run(JOURNAL_SCHEMA_VERSION)
  } else if (stamp.version !== JOURNAL_SCHEMA_VERSION) {
    resetDerivedSchema(db)
    db.prepare("UPDATE journal_meta SET version = ? WHERE singleton = 1").run(JOURNAL_SCHEMA_VERSION)
  }
  ensureDerivedObjects(db)
}

/**
 * 丢掉全部派生物（`pm_search` / `edges`）并重建空表。**不碰 `activity_log`。**
 *
 * 唯一合法用途：派生层被手改坏、或 `SCHEMA_VERSION` 递增。调完之后调 `rebuild()` 回填。
 * @param db - 已打开的 journal 库。
 */
export function resetDerivedSchema(db: DatabaseSync): void {
  for (const name of DERIVED_OBJECTS) {
    db.exec(`DROP TABLE IF EXISTS ${name}`)
  }
  ensureDerivedObjects(db)
}

/**
 * 建派生层的空表（不含版本判断）。
 *
 * 与 {@link resetDerivedSchema} 分开是因为 `resetDerivedSchema` 要「先丢再建」，
 * 而开库路径要「有就复用」。把 DDL 抽成一个函数，两处引用同一份文本 ——
 * 派生层形状只有一个家。
 * @param db - 已打开的 journal 库。
 */
export function ensureDerivedObjects(db: DatabaseSync): void {
  db.exec(DDL_DERIVED)
}

/** journal pragma 允许的取值（与 DSH `storage-sqlite` 同口径）。 */
export type JournalMode = "wal" | "delete" | "truncate" | "persist"

/** 诊断用：库身份三元组（`application_id` / 派生层版本 / 用户表）。 */
export interface JournalIdentity {
  applicationId: number
  schemaVersion: number
  tables: string[]
}

/**
 * 读回库身份。`--check` 类诊断与测试用它，业务路径不用。
 * @param db - 已打开的 journal 库。
 * @returns 身份三元组。
 */
export function readIdentity(db: DatabaseSync): JournalIdentity {
  const { application_id: applicationId } = db.prepare("PRAGMA application_id").get() as {
    application_id: number
  }
  const stamp = db.prepare("SELECT version FROM journal_meta WHERE singleton = 1").get() as
    | { version: number }
    | undefined
  return { applicationId, schemaVersion: stamp?.version ?? 0, tables: listUserTables(db) }
}
