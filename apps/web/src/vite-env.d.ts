/**
 * 壳的 Vite 环境类型（ISS-537）。不引 `/// <reference types="vite/client" />`：
 * apps/ 无 vite 直接链接，TS 的 types 解析不到它；这里只声明本壳实际用到的两个面。
 */

/** Vite 注入的构建期环境变量（config.ts 读 VITE_SHELL_*）。 */
interface ImportMeta {
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Vite `?inline` CSS 导入：编译期内联为字符串（client 半 install 钩子消费）。 */
declare module "*.css?inline" {
  const css: string
  export default css
}

/** CSS Module（ISS-544）：Vite 注入类名映射，仅服务类型面。 */
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>
  export default classes
}
