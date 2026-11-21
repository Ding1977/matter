/**
 * npm-install-path shim for Typert Remote-symbol recognition (ISS-539 · P4-N1).
 *
 * DSH vendors `@deepseek-ai/dsh-typert-protocol` via `workspace:*` and points
 * tsconfig paths at its source, so the generator's `isTypeMetaSymbol` sees the
 * decorator's symbol in a registration named after the protocol. This repo
 * npm-installs the protocol (ISS-534), whose `Remote` resolves to an external
 * `.d.ts` with no registration -> generation saw 0 invocations. This ambient
 * declaration gives the analyzer a same-specifier `declare module` ancestor to
 * recognise, the same purpose DSH's workspace path achieves by other means.
 *
 * tsconfig.host.json `paths` routes the bare specifier here for generation only;
 * the npm protocol stays the compile/runtime source in every other tsconfig.
 * Only the four symbol identities the analyzer keys on are declared here.
 * NOTE: no JSDoc inside the `declare module` block — in-block JSDoc with @tags
 * was observed to hide the exports from the analyzer (invocations dropped to 0).
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  export class RemoteError<Code extends string = string> extends Error {
    constructor(code: Code, message: string, details?: unknown, options?: unknown)
  }
  export abstract class TypertRemoteService<T = never> {
    constructor(ctx: unknown, key: string)
    readonly ctx: unknown
  }
  export function Remote(name: string): MethodDecorator
  export interface RemoteErrorDetailsMap {}
}
