/**
 * dev:preview 的 TypeScript 加载器（ISS-905）。
 *
 * 为什么不用 `node --strip-types`：host 真装配从
 * `@deepseek-ai/dsh-client-connection/src/http-bridge.ts` 取 bridge，
 * 而 Node 24 明确拒绝对 node_modules 下的 .ts 做类型剥离
 * （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。vitest/vite 能转是因为它们自带 transform。
 * 这里用仓库已有的 typescript（零新依赖）做同样的无类型检查转译，只作用于 .ts/.tsx。
 *
 * @module scripts/dev-ts-loader
 */

import { readFile } from "node:fs/promises"
import ts from "typescript"

/** 把 .ts/.tsx 原样转译成 ESM；其余交回 Node 默认加载。 */
export async function load(url, context, nextLoad) {
  if (!/\.tsx?$/.test(url)) return nextLoad(url, context)
  const source = await readFile(new URL(url), "utf8")
  const output = ts.transpileModule(source, {
    fileName: url,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  }).outputText
  return { format: "module", shortCircuit: true, source: output }
}
