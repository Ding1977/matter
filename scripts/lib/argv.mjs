// 命令行开关解析（从 scripts/run-gates.mjs 抽出，ISS-817 收线）
//
// 纯函数，只读一个 argv 数组，不碰任何全局 —— 抽出来的理由与 `gate-tables.mjs` 同一类：
// 它们占了 run-gates.mjs 的篇幅，却与调度逻辑零耦合。且 run-gates.mjs 被
// `verify-file-size` 棘轮盯着（`scripts/baseline/file-size.json`，只许降不许升）。

/**
 * 取某开关的**第一个**值。没有则返回默认值。
 *
 * ⚠️ 只看第一次出现 —— 同一个开关写两遍时第二遍**会被静默忽略**。这不是设计，是历史行为；
 * 要「多个都算」用 `optAll()`。ISS-817 实测踩过：`--only a --only b` 只跑了 a，
 * 而屏幕上看不出少跑了 b（点了名却没跑，属于最坏那类静默错）。
 */
export const opt = (argv, name, fallback) => {
  const i = argv.indexOf(name)
  return i < 0 ? fallback : argv[i + 1]
}

/**
 * 取某开关的**全部**出现值（ISS-817）。
 *
 * 为什么需要：场景路由要一次点名多格（`--only ci-typecheck-pm --only ci-test-pm`）。
 * 用 `opt()` 时第二遍被静默忽略 ⇒ 那不是「少跑一格」的轻错，是**点了名却没跑**。
 *
 * ⚠️ 缺值形态（开关在末尾、没有下一个 token）**不算出现**：宁可返回少一个，
 * 也不能把 `undefined` 混进名单 —— 下游会把 undefined 当格名去查，查不到再静默放过。
 */
export const optAll = (argv, name) => argv.flatMap((a, i) => (a === name && i + 1 < argv.length ? [argv[i + 1]] : []))

/** 逗号分隔的开关值摊平成一个名单（去空、去首尾空格）。`--only a,b --only c` ⇒ ["a","b","c"]。 */
export const optList = (argv, name) =>
  optAll(argv, name)
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean)
