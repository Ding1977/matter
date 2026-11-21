/**
 * Generate this workspace's Typert artifacts without bundling (ISS-539 · P4-N1).
 *
 * Source-only pre-generation: writes every explicit contributor's
 * `lib/typert.host.*` and `lib/typert.remote-client.*` with the same generator
 * and writer the workspace-mode bundler plugin uses, reading workspace packages
 * only from source (`rejectBuildOutputs: true`) so generation precedes package
 * compilation. Host face only — this workspace contributes no Client face.
 *
 * The generator is also the publication-contract validator: a contributor that
 * declares `./typert` (and, with @Remote methods, `./remote`) but points it at the
 * wrong file or omits it from `files` fails generation. That is the "teeth" that
 * turns U-3's @Remote declaration into an enforced contract.
 *
 * Usage: `node --strip-types scripts/generate-typert.ts`, from the repo root or
 * any directory below it. Exit 0 = all artifacts written, 1 = generation failed,
 * 2 = invalid command line.
 */

import { performance } from 'node:perf_hooks'
import {
  TypertAnalysisError,
  TypertEmitError,
  WorkspaceTypertGenerator,
  findWorkspaceRoot,
  writeWorkspaceArtifacts,
} from '@deepseek-ai/dsh-typert-generator'
import type { TypertFace, WorkspaceEmitResult } from '@deepseek-ai/dsh-typert-generator'

/**
 * Independent program faces generated for this workspace. Host only: the remote
 * client projection is emitted by the host face when @Remote methods exist.
 */
const WORKSPACE_TYPERT_FACES = ['host'] as const satisfies readonly TypertFace[]

/** Stage at which one pass failed; `locate`/`generate` change no file. */
export type TypertGenerationStage = 'locate' | 'generate' | 'write'

/** A failed bundle-free Typert pass; `cause` carries the generator or file-system failure. */
export class TypertGenerationError extends Error {
  override name = 'TypertGenerationError'
  readonly stage: TypertGenerationStage
  readonly location: string

  constructor(stage: TypertGenerationStage, location: string, cause: unknown) {
    super(`generate-typert: ${STAGE_SUMMARIES[stage]} (${location})`, { cause })
    this.stage = stage
    this.location = location
  }
}

const STAGE_SUMMARIES: Readonly<Record<TypertGenerationStage, string>> = {
  locate: 'no directory at or above the working directory holds tsconfig.host.json and packages/; no artifact file changed',
  generate: 'Typert analysis, emission, or publication-contract validation failed; no artifact file changed',
  write: 'writing Typert artifacts failed; packages written before the failure have new lib/typert.* files',
}

const STAGE_ACTIONS: Readonly<Record<TypertGenerationStage, string>> = {
  locate: 'Run the command from the repository root or a directory below it.',
  generate: 'Fix the source, package.json exports/files, or tsconfig paths named above, then rerun this command or pnpm run build.',
  write: 'Fix the file-system error above, then rerun this command; until a run succeeds, lib/typert.* files may come from two generations.',
}

// Host compilation owns TypeScript diagnostics (tsc runs later in the build chain);
// rejecting build outputs lets this pass run before any package is compiled.
const GENERATION_OPTIONS = { checkDiagnostics: false, rejectBuildOutputs: true } as const

/**
 * Generate and write every explicit contributor's Typert artifacts in the workspace containing `start`.
 * @param start - directory inside the workspace; its nearest ancestor holding `tsconfig.host.json` and `packages/` is the root.
 * @returns the artifacts written, in write order.
 * @throws {TypertGenerationError} naming the failed stage, with the underlying failure as `cause`.
 */
export function generateWorkspaceTypert(start: string): readonly WorkspaceEmitResult[] {
  let root: string
  try {
    root = findWorkspaceRoot(start)
  } catch (error) {
    throw new TypertGenerationError('locate', start, error)
  }
  let artifacts: WorkspaceEmitResult[]
  try {
    artifacts = new WorkspaceTypertGenerator(root, GENERATION_OPTIONS)
      .generateContributors(WORKSPACE_TYPERT_FACES)
  } catch (error) {
    throw new TypertGenerationError('generate', root, error)
  }
  try {
    writeWorkspaceArtifacts(root, artifacts)
  } catch (error) {
    throw new TypertGenerationError('write', root, error)
  }
  return artifacts
}

/** Render a failed pass for a terminal: summary, underlying failure, next action. */
export function formatGenerationFailure(error: TypertGenerationError): string {
  return [error.message, indent(describeCause(error.cause)), STAGE_ACTIONS[error.stage]].join('\n')
}

function describeCause(cause: unknown): string {
  if (cause instanceof TypertAnalysisError || cause instanceof TypertEmitError) {
    return `${cause.name}: ${cause.message}`
  }
  if (cause instanceof Error) return cause.stack ?? `${cause.name}: ${cause.message}`
  return String(cause)
}

function indent(text: string): string {
  return text.split('\n').map(line => `  ${line}`).join('\n')
}

/**
 * Run the command line.
 * @param args - arguments after the script path; the command accepts none.
 * @param cwd - working directory the workspace root is searched from.
 * @returns the process exit status.
 */
export function main(args: readonly string[], cwd: string): number {
  if (args.length > 0) {
    console.error(`generate-typert: expected no arguments, got ${JSON.stringify(args)}; usage: node --strip-types scripts/generate-typert.ts`)
    return 2
  }
  const started = performance.now()
  let artifacts: readonly WorkspaceEmitResult[]
  try {
    artifacts = generateWorkspaceTypert(cwd)
  } catch (error) {
    if (!(error instanceof TypertGenerationError)) throw error
    console.error(formatGenerationFailure(error))
    return 1
  }
  const packages = new Set(artifacts.map(artifact => artifact.package)).size
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  console.log(`generate-typert: wrote ${String(artifacts.length)} Typert artifact(s) for ${String(packages)} package(s) in ${seconds}s`)
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.cwd())
