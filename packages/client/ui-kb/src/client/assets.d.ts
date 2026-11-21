/**
 * client 半资产模块声明（ISS-544 / P5-D1，照 ui-pm/ui-theme assets.d.ts）。
 *
 * list/detail 两个设计态组件 import 自己的 `*.module.css`；tsc 不认识 CSS Module
 * 后缀，没有这份声明会在那些 import 行报 TS2307。Vite / vitest 侧原生接 CSS Module
 * （vitest.config.ts 的 deps.inline + css 处理），运行面不需要配置 —— 本文件只服务类型面。
 */
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>
  export default classes
}
