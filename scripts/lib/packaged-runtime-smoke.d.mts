import type { ChildProcess } from 'node:child_process'

export function collectPackagedRuntimeSmoke(child: ChildProcess, options: {
  profile: string
  resultPath: string
  timeoutMs?: number
  killWaitMs?: number
  isProcessRunning?: (pid: number) => boolean | null
  forceStop?: (child: ChildProcess, killWaitMs: number) => Promise<void>
}): Promise<{ output: string; result: { status: 'passed'; [key: string]: unknown } }>

export function resolvePackagedExecutable(options?: {
  executable?: string
  cwd?: string
  platform?: NodeJS.Platform
  arch?: string
}): string

export function runPackagedRuntimeSmoke(options?: {
  executable?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  killWaitMs?: number
  profileParent?: string
}): Promise<{ output: string; result: { status: 'passed'; [key: string]: unknown } }>
