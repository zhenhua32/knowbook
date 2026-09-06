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
