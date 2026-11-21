// 门禁登记数据表（ISS-772 / ISS-774 收线 · ISS-820 清空）
//
// ⚠️ **本文件的两张表都已清空**，不是「暂时没填」。
//
// 原先这里有两张硬编码表：
//   · `STANDALONE_GATES` —— 16 个不依赖 registry/guard 的独立脚本格（badge:"standalone"）
//   · `AGGREGATE_GATES`  —— 整条登记、不拆格的聚合闸（ISS-800 后已为空）
//
// 它们与 `scripts/lib/inline-gates.mjs` 的 4 格一起，被 `verify-gate-coverage`（ISS-812）
// 记为「硬编码存量」并逐条登记在 `scripts/baseline/gate-coverage-allowlist.json` 里 ——
// 也就是说：**它们跑得动，但没有名字**。`--list` 的 source 只能打「独立脚本」这种族名，
// 对账判据看不见它指向哪个文件，而这些格本身也没有 `owner` / `since` / `tiers` 的登记位。
//
// ISS-820 把 20 格全部收进 `scripts/gates/registry.json` 的 `kind:"legacy"`，
// 白名单随之从 66 条降到 46 条（清掉的是硬编码那 20 条，留下的是 CI 逐包派生的 46 条 ——
// 那 46 条随包增减自动变化，本来就不是硬编码债）。
//
// ⛔ **别往这里加格**：一张与 registry 并行的硬编码表就是「双写」，而双写的两份数据
//    迟早对不上，且对不上的那天没有任何判据会响。新增判据请落 `scripts/gates/`
//    并登记 registry（丙规则见 `scripts/gates/README.md`）。
//
// 保留两个导出（而不是删掉文件）的理由：`run-gates.mjs` 仍按 `...AGGREGATE_GATES` /
// `...STANDALONE_GATES` 展开，保持这一行的形状可以让「以后真要加聚合闸」有落点，
// 且不必为了删一个空数组去改调度器。清空后它们的长度恒为 0，对 `--list` 零影响。

/** 不依赖 registry/guard 的独立脚本格。**恒为空** —— 见文件头。 */
export const STANDALONE_GATES = []

// §5 整条登记的门禁（不拆格 —— 拆了就改变口径；ISS-774 从 run-gates.mjs 搬出）
// ISS-800（门禁三套合一·阶段一）：本表原先还有两条 `badge:"aggregate"` 的整条聚合闸 ——
// `gate-fast`（node scripts/gate-fast.mjs）与 `guard-baselines`（bash scripts/guard-baselines.sh）。
// 二者都不是判据本体，而是**上一代的聚合壳**：前者的 4 个脚本、后者的 105 格，registry.json 里
// 早已逐条登记（实测 `derivedFromGuardBaselines: 105`）⇒ 同一批判据被执行了两遍。
//   · guard-baselines 单次实测 501.54s（CI 2 核），它包的 105 格在 registry 里重复跑一次；
//   · gate-fast 是「读 gate-debt.json 比红项数」的棘轮，4 个脚本各自的 registry 格仍在。
// 两个文件已删（连同它们唯一的对照物 verify-guard-cell-ids）。留空数组而不是删掉本导出：
// run-gates.mjs 仍按 `...AGGREGATE_GATES` 展开，保持这一行的形状可以让「以后要加聚合闸」有落点。
export const AGGREGATE_GATES = []
