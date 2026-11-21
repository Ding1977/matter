// 判据的**输入集合**：只量已入库的文件（ISS-742）
//
// 为什么要这一层：盘点器原先直接按文件系统走，于是同一份提交在两棵树上量出不同的数 ——
//   ⑴ 被 .gitignore 排除的构建产物只有主树有（`forge-*/src/styles/tailwind.generated.ts`），
//      别人的临时脚本也只在那棵树上飘着（09-22 实测：两个 `diag-*.mjs` 恰好把 D3 的一个簇从 2 份凑成
//      3 份，把 K6b 上限顶高一格；另一次是 `.workbuddy/tmp-blank-*.mjs`）。
//   ⑵ 未入库的在途文件会被一起量 ⇒ 门禁对「没进版本的东西」报红，而裁判造假红的代价比没裁判更大。
// 两类都不是仓库**声明**的内容。纪律与 lint-* 系列一致：只判已入库文件，并且把跳过了哪些**打印出来**
//   （静默排除 = 门禁看不见东西，与「判不了就当 0」是同一种错）。
//
// 降级口径：拿不到 git（`git archive` 出来的临时取证树、无 .git 的镜像）⇒ 返回「全部接受」并置
//   `all = true`，调用方必须在报告里写明这次没做入库过滤 —— 不许静默按另一种口径出数。
//
// ⚠️ 只导出 `trackedSet`：本文件唯一的消费者是 code-inventory.mjs（它贴着 K2a 的 1000 行红线，
//    能力一律外置到这里）。自检留在模块内、由自己的 CLI 入口跑，多导一个符号就是给度量 Z2
//    添一条「零引用导出」（这条纪律来自 route-ledger-lib 的两次教训）。

import { execFileSync } from 'node:child_process'

/**
 * 读 git 的已入库清单。返回一个 Set，另挂两个字段：
 *   · `.missing` —— 本次被剔掉的文件（调用方负责打印，别静默）
 *   · `.all`     —— 拿不到 git 时为 true ⇒ 一个都不剔
 */
export function trackedSet(root) {
  let list
  try {
    // stdio 收声：无 git 时 git 自己的 fatal 不该污染测量输出（降级由 .all 显式表达）
    list = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)
  } catch {
    const s = new Set()
    s.all = true
    s.missing = []
    return s
  }
  const s = new Set(list)
  s.all = false
  s.missing = []
  return s
}

/** 纯函数那半：给定扫描清单与已入库集合，返回该剔掉谁。tracked=null 表示降级 ⇒ 一个都不剔。 */
function pickUntracked(files, tracked) {
  if (!tracked) return []
  return files.filter((f) => !tracked.has(f))
}

/** `node scripts/scan-input.mjs --selftest`：证明这把尺子既能剔、也不误伤，且降级不静默。 */
function selftestScanInput() {
  const cases = []
  const t = (name, pass) => cases.push({ name, pass })
  const set = new Set(['a/x.ts', 'a/y.ts'])
  t('未入库的文件被剔', pickUntracked(['a/x.ts', 'a/b-scratch.ts'], set).join() === 'a/b-scratch.ts')
  t('全部已入库 ⇒ 一个都不剔（反向不误伤）', pickUntracked(['a/x.ts', 'a/y.ts'], set).length === 0)
  t('降级（tracked 为 null）⇒ 不剔，而不是把全部剔光', pickUntracked(['a/x.ts', 'a/b.ts'], null).length === 0)
  const real = trackedSet(process.cwd())
  t('真仓库里拿得到清单（或明确标为降级）', real.all === true || (real.size > 100 && real.all === false))
  t('missing 数组始终存在（缺了就是静默排除）', Array.isArray(real.missing))
  const bad = cases.filter((c) => !c.pass)
  console.log(cases.map((c) => `${c.pass ? '✓' : '✗'} ${c.name}`).join('\n'))
  console.log(`扫描输入集合自检 ${cases.length - bad.length}/${cases.length}`)
  return bad.length ? 1 : 0
}

if (process.argv.slice(2).includes('--selftest')) process.exitCode = selftestScanInput()
