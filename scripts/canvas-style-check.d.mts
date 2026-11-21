// canvas-style-check.mjs 的类型声明（forge-canvas 的 src 测试要 import 它做「出码即自检」闭环）
export interface GateHit { kind: string; at: string; detail: string; ref?: boolean }
export declare function checkArtifactText(text: string, file: string): GateHit[]
export declare function findDanglingVars(hits: GateHit[], declared: Set<string>): GateHit[]
export declare function checkCanvasDoc(docPath: string): Promise<unknown>
