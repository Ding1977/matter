/**
 * client 半的资产模块声明（照 ui-pm assets.d.ts，ISS-543）。
 *
 * 原件 Button 的 ./src/Button.tsx 通过包 `./src/*` 导出被引入，其源码 import 了
 * `Button.module.css`；tsc 不认识 CSS Module 后缀，没有这份声明会在原件源码上报
 * TS2307。Vite / vitest 侧原生接 CSS Module（vitest.config.ts 的 deps.inline 已内联
 * @deepseek-ai/dsh-client-*），运行面不需要配置 —— 本文件只服务类型面。
 */
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>
  export default classes
}
