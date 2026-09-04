/**
 * Public contract for fully trusted System Plugin v3 packages.
 *
 * Risk declarations are disclosure and audit metadata. They are deliberately
 * not described as enforceable permissions: a confirmed Full Trust plugin can
 * use any API available to its Node/Electron process.
 */

export const SYSTEM_PLUGIN_V3_SCHEMA_VERSION = 3 as const

export const SYSTEM_PLUGIN_RISK_DECLARATIONS = [
  'filesystem',
  'user-data',
  'environment',
  'secrets',
  'node',
  'electron',
  'shell',
  'subprocess',
  'network',
  'npm',
  'ai',
  'documents',
  'database',
  'raw-sqlite',
  'settings',
  'renderer',
  'unsandboxed-frame',
  'background-service',
  'os-persistence'
] as const

export type SystemPluginRiskDeclaration = typeof SYSTEM_PLUGIN_RISK_DECLARATIONS[number]

export interface SystemPluginV3Entries {
  main?: string
  renderer?: string
  service?: string
}

export type SystemPluginPackageManager = 'npm' | 'pnpm' | 'yarn'

export type SystemPluginDependencyInstallMode = 'ci' | 'install'

export interface SystemPluginDependencyPlan {
  packageManager: SystemPluginPackageManager
  install: SystemPluginDependencyInstallMode
  allowScripts: boolean
  buildCommand?: string[]
  rebuildNativeModules: boolean
}

export interface SystemPluginBackgroundConfig {
  mode: 'app-lifetime' | 'detached'
  autoStart: boolean
}

export interface SystemPluginV3Manifest {
  schemaVersion: typeof SYSTEM_PLUGIN_V3_SCHEMA_VERSION
  trust: 'full'
  id: string
  name: string
  version: string
  description?: string
  publisher: string
  engines?: {
    knowbook: string
  }
  entries: SystemPluginV3Entries
  fullAccess: true
  riskDeclarations: SystemPluginRiskDeclaration[]
  dependencies?: SystemPluginDependencyPlan
  background?: SystemPluginBackgroundConfig
}

export interface SystemPluginArtifactFileDigest {
  /** POSIX-style path relative to the immutable artifact root. */
  path: string
  size: number
  sha256: string
}

export interface SystemPluginArtifactDescriptor {
  artifactId: `sha256:${string}`
  artifactSha256: string
  manifest: SystemPluginV3Manifest
  files: SystemPluginArtifactFileDigest[]
  fileCount: number
  sizeBytes: number
  /** Matching lock file selected from the dependency plan, when present. */
  dependencyLockPath: string | null
}

export interface SystemPluginFramePolicyInput {
  pluginId: string
  revisionHash: string
  frameName: string
  popupName: string
  allowedOrigins: string[]
  allowPopups: boolean
  allowNavigation: boolean
  allowDownloads: boolean
  allowPermissions: boolean
}

export interface RemoveSystemPluginFramePolicyInput {
  pluginId: string
  revisionHash: string
  frameName: string
}
