/**
 * client 半的资产模块声明（ISS-530 / P3-U1）。
 *
 * tsc 不认识 `?inline` 后缀的 CSS import；没有这份声明，client 面编译在
 * `styles.ts` 的 import 行报 TS2307。Vite / vitest 侧原生支持该后缀
 * （返回 CSS 全文字符串），运行面不需要任何配置 —— 本文件只服务类型面。
 *
 * 只放在 client 半（host 面不 import CSS，也不该看得见这条声明）。
 * 后续 client 包（ui-blocks / ui-kb）需要同一声明时再讨论上提到根
 * `scripts/types/`（须另开写范围），当前一个消费者不预建共享位。
 */
declare module "*.css?inline" {
  const css: string
  export default css
}
