/**
 * `@matter/client-ui-blocks` —— Matter 前端的 BlockNote 块编辑器映射底座（ISS-531 / P3-U2a）。
 *
 * 三件东西：
 *
 * | 件 | 在哪 | 谁消费 |
 * |---|---|---|
 * | A 档 9 名/粒度映射 + Marks 8 映射契约 | `src/client/contract/` | 映射层、U-2b 扩展 |
 * | our ⇄ BN 映射层（props/marks/blocks/validation） | `src/client/mapping/` | headless boot、测试、U-3 |
 * | headless 编辑器 boot（core）+ React 展示面（BlockNoteViewRaw） | `src/client/mapping/editor.ts` · `src/client/mapping/view.tsx` | jsdom 集成测试；P4 挂载方 |
 *
 * ## 双面结构与 ui-theme 同构
 *
 * 包根 `tsconfig.json` 是 solution 文件（files 空 + 两个 references）：
 * `tsconfig.host.json`（node 环境，编本入口 `src/index.ts`）与 `tsconfig.client.json`
 *（DOM lib + jsx，编 `src/client/**`）。host 半只放插件形态（空注册），所有映射与编辑器代码
 * 都在 client 半——它们依赖 @blocknote/core 的 DOM 类型与 @matter/blocks 的运行时 zod schema。
 *
 * ## host 半的 apply 是空注册
 *
 * P3 无 shell：加载本包不产生副作用、不建编辑器。真正的 boot 由调用方显式调
 * `bootHeadlessEditor`（`@matter/client-ui-blocks/client`）。映射层是纯数据函数，随 client 半导出。
 *
 * @module @matter/client-ui-blocks
 */

import type { Context } from "@deepseek-ai/cordis"

/**
 * 插件入口（P3 最小形态，ISS-532 保持不变）：宿主侧空注册。
 *
 * slot 接入（ISS-532）全部在 client 半（`src/client/slots.ts`）：声明合并 SlotMap + 注册 helper；
 * 运行时注册由真消费者页面（U-3）或 jsdom 测试调 `registerEditorSurface(ctx.slots, Component)` 完成。
 * host 半不 import client 文件（双面纪律 + host tsconfig 文件表约束），也不 import DSH 的
 * `@deepseek-ai/dsh-client-*` 类型面（其 d.ts 引用未钉的 dsh-client-store，client 半靠 skipLibCheck
 * 吸收，host 半没有该豁免）。
 *
 * @param _ctx - 插件上下文（当前未使用）。
 * @returns 无。
 */
export function apply(_ctx: Context): void {
  // 有意留空：见模块注释。
}
