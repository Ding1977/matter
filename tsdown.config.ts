import { globSync } from 'node:fs'
import { defineConfig } from 'tsdown'

/**
 * 新树两段式构建的第二段（ISS-508 · P0-2 · 补 ISS-511 的缺口）。
 *
 * 两段分工必须钉死：
 *   ① `tsc -b tsconfig.next.json` —— 类型检查 + 出声明（`lib/types/**`）
 *   ② `tsdown`（本文件）        —— 由 `lib/types/*.js` 打成 `lib/index.js`
 * `package.json` 的 build 是 `tsc -b … && tsdown`，`&&` 不是 `;`：
 * tsdown **不检查类型**（陷阱②实测：tsc 红时它照样 `✔ Build complete`）。
 *
 * workspace 模式：把 `packages/<group>/<pkg>` 全部纳入，每包在自己的目录里打自己的产物。
 * ⚠️ 本注释里不能写 glob 通配（星号+斜杠连写会**提前闭合块注释**，
 *    Node 的类型剥离加载器随即报 `Expected ';', '}' or <eof>` —— 实测踩过）。
 * 不这么做的话 tsdown 从仓库根找不到入口（`No input files`）—— build 必红。
 */
export default defineConfig(() => ({
  // 逐包纳入，路径形如 `packages/storage/storage`（glob 结果末尾的 /package.json 要剥掉）
  workspace: globSync('packages/*/*/package.json', { cwd: import.meta.dirname }).map((p) =>
    p.replace(/\/package\.json$/, ''),
  ),
  // 入口取 tsc 的产物，不直接取 src：这样第一段没过，第二段就没有输入（顺序靠产物传递，不只靠 &&）
  entry: ['lib/types/{index,startup}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,

  // ⛔ dts 必须是 false：声明永远归 tsc（`lib/types/*.d.ts`）。
  //   tsdown 再产一份 = 两份声明文件，且它不认 `composite` 的项目引用边界
  //   ⇒ 跨包类型会两套，迟早对不上。这是「一个事实只有一个家」在构建层的落法。
  dts: false,

  // ⛔ clean 必须是 false：`lib/` 同时放 tsc 的 `lib/types/**` 与 tsdown 的 `lib/index.js`。
  //   clean: true 会在 tsdown 启动时先清空 outDir ⇒ 删掉 tsc 刚产的 `lib/types`
  //   ⇒ 构建链自己打自己（第二段吃掉第一段的产物）。
  clean: false,
}))
