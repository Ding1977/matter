// 「判不了」的理由码 → 人读文案（从 scripts/run-gates.mjs 抽出，ISS-775 收线）。
//
// 为什么不能一句话兜底：以前所有 unjudgedWhen 命中都写成「本机缺依赖 ⇒ 环境不全」，
// 于是 verify-rule-cards 的 12 条**设计上判不了**（no-rule-table）被报成「环境问题」。
// **环境问题可以重试，设计问题重试一辈子也不会变** —— 两类混在一句里，读的人第一步就会走错。
//
// 文案优先取该格自己输出的 `! <gate>: unjudged（reason）` 行；取不到才用兜底措辞。

/**
 * 「判不了」的理由码 → 人读文案。
 *
 * 为什么不能一句话兜底（ISS-775 实测）：以前所有 `unjudgedWhen` 命中都写成
 * 「本机缺依赖 ⇒ 没跑成（环境不全）」，于是 `verify-rule-cards` 的 12 条
 * **设计上判不了**（承载 gate 没有机读规则表/度量表，理由是 `no-rule-table`）
 * 被报成「环境问题」。**环境问题可以重试，设计问题重试一辈子也不会变** ——
 * 两类混在一句里，读的人第一步就会走错。
 */
export const REASON_NOTE = {
  "no-corpus": "判不了：输入为空（没有可判的语料/登记行）",
  "no-home": "判不了：找不到 home 目录",
  "no-binary": "判不了：缺可执行文件",
  "no-build": "判不了：缺构建产物",
  "no-baseline": "判不了：缺基线文件",
  "no-rule-table": "判不了：该 gate 没有机读规则表/度量表（判据设计上判不了，不是环境问题）",
}

/** 从判据自己的 `! <gate>: unjudged（reason）` 行里取理由码 —— 文案由该格给，不在这里猜。 */
export function unjudgedNote(gate, output) {
  const reason = /unjudged（([a-z-]+)）/.exec(output ?? "")?.[1]
  if (reason && REASON_NOTE[reason]) return REASON_NOTE[reason]
  // 兜底：这一格只说了「判不了」没给码（老判据）。保持旧措辞，但不再声称「设计上判不了」。
  return `本机缺依赖 ⇒ 没跑成（${gate.needsBun ? "没有 bun" : "环境不全"}），不记绿也不记红`
}
