// `bun-bin.mjs` 的类型声明 —— 只为让 tsgolint（typeAware）解析得到函数签名。
//
// 为什么需要：`.mjs` 没有类型，TS 在 `moduleResolution: bundler` 下会把它当 `any`，
// 于是 `bunBin()` 的返回值在调用侧是 error-typed ⇒ 触发 `no-unsafe-call` /
// `no-unsafe-argument`（实测每处引用 +2 条，ISS-505 staged lint 抓出）。
// 加这份声明后签名确定，那两个规则自然不再误报 —— 这是**补类型**，不是关规则。

/** 返回一个**真的能跑**的 bun 绝对路径（带缓存）。找不到就抛「环境缺失」。 */
export declare function bunBin(): string

/** 「只要一个能跑本仓 .mjs/.js 的 JS 运行时」时用它（vitest 下 = node）。 */
export declare function nodeBin(): string
