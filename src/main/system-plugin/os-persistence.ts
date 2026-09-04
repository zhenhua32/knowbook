import { createHash } from 'node:crypto'
import {
  mkdir as makeDirectory,
  readFile as readTextFile,
  unlink as unlinkFile,
  writeFile as writeTextFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export const FULL_TRUST_OS_PERSISTENCE_DESCRIPTOR_VERSION = 1 as const

export type FullTrustOsPersistencePlatform = 'win32' | 'darwin' | 'linux'
export type FullTrustOsPersistenceMethod =
  | 'electron-login-item'
  | 'linux-autostart-desktop'

export type FullTrustOsPersistenceStatus =
  | 'registered'
  | 'requires-approval'
  | 'disabled'
  | 'absent'
  | 'mismatch'
  | 'unknown'

export interface FullTrustOsPersistenceCommand {
  executable: string
  args: readonly string[]
}

export type FullTrustMacLoginItemType =
  | 'mainAppService'
  | 'agentService'
  | 'daemonService'
  | 'loginItemService'

export interface FullTrustOsPersistenceRegistrationInput {
  /**
   * An explicit reminder for callers and persisted audit data. This is not a
   * permission check: Full Trust plugins can bypass this helper entirely.
   */
  trust: 'full'
  pluginId: string
  revisionHash: string
  serviceId: string
  command: FullTrustOsPersistenceCommand
  displayName?: string
  /** macOS only. Non-main services use serviceId as Electron's serviceName. */
  macLoginItemType?: FullTrustMacLoginItemType
}

interface FullTrustOsPersistenceDescriptorBase {
  schemaVersion: typeof FULL_TRUST_OS_PERSISTENCE_DESCRIPTOR_VERSION
  trust: 'full'
  pluginId: string
  revisionHash: string
  serviceId: string
  displayName: string
  command: FullTrustOsPersistenceCommand
  registeredAt: string
}

export interface FullTrustElectronLoginItemSettings {
  openAtLogin: boolean
  type?: FullTrustMacLoginItemType
  serviceName?: string
  path?: string
  args?: string[]
  enabled?: boolean
  name?: string
}

export interface FullTrustElectronLoginItemQuery {
  type?: FullTrustMacLoginItemType
  serviceName?: string
  path?: string
  args?: string[]
}

export interface FullTrustElectronLoginItemDescriptor
  extends FullTrustOsPersistenceDescriptorBase {
  platform: 'win32' | 'darwin'
  method: 'electron-login-item'
  registration: {
    settings: FullTrustElectronLoginItemSettings
    query: FullTrustElectronLoginItemQuery
  }
  cleanup: {
    strategy: 'electron-set-login-item'
    settings: FullTrustElectronLoginItemSettings
  }
}

export interface FullTrustLinuxAutostartDescriptor
  extends FullTrustOsPersistenceDescriptorBase {
  platform: 'linux'
  method: 'linux-autostart-desktop'
  registration: {
    desktopFilePath: string
    desktopEntrySha256: string
  }
  cleanup: {
    strategy: 'delete-file-if-content-matches'
    filePath: string
    expectedContent: string
    expectedContentSha256: string
  }
}

export type FullTrustOsPersistenceDescriptor =
  | FullTrustElectronLoginItemDescriptor
  | FullTrustLinuxAutostartDescriptor

export interface FullTrustElectronLoginItemLaunchItem {
  name: string
  path: string
  args: string[]
  scope: string | null
  enabled: boolean | null
}

export interface FullTrustElectronLoginItemObservation {
  kind: 'electron-login-item'
  openAtLogin: boolean
  status: string | null
  executableWillLaunchAtLogin: boolean | null
  launchItems: FullTrustElectronLoginItemLaunchItem[]
}

export interface FullTrustLinuxAutostartObservation {
  kind: 'linux-autostart-desktop'
  filePath: string
  contentSha256: string | null
}

export type FullTrustOsPersistenceObservation =
  | FullTrustElectronLoginItemObservation
  | FullTrustLinuxAutostartObservation

export interface FullTrustOsPersistenceQueryResult {
  descriptor: FullTrustOsPersistenceDescriptor
  status: FullTrustOsPersistenceStatus
  /** True only for the exact native identity: command, service id, or file. */
  exact: boolean
  active: boolean
  observed: FullTrustOsPersistenceObservation
}

export interface FullTrustOsPersistenceRemovalResult {
  descriptor: FullTrustOsPersistenceDescriptor
  removed: boolean
  before: FullTrustOsPersistenceQueryResult
  after: FullTrustOsPersistenceQueryResult
}

/**
 * Cross-platform host abstraction for managing reviewed Full Trust persistence.
 * It improves auditability and cleanup; it is deliberately not a sandbox or a
 * security boundary against the plugin's unrestricted Node/OS access.
 */
export interface FullTrustOsPersistenceAdapter {
  readonly platform: FullTrustOsPersistencePlatform
  readonly method: FullTrustOsPersistenceMethod
  describe(
    input: FullTrustOsPersistenceRegistrationInput
  ): FullTrustOsPersistenceDescriptor
  register(
    input: FullTrustOsPersistenceRegistrationInput
  ): Promise<FullTrustOsPersistenceDescriptor>
  query(
    descriptor: FullTrustOsPersistenceDescriptor
  ): Promise<FullTrustOsPersistenceQueryResult>
  remove(
    descriptor: FullTrustOsPersistenceDescriptor
  ): Promise<FullTrustOsPersistenceRemovalResult>
}

export interface FullTrustElectronLoginItemState {
  openAtLogin: boolean
  status?: string
  executableWillLaunchAtLogin?: boolean
  launchItems?: readonly {
    name: string
    path: string
    args: readonly string[]
    scope?: string
    enabled?: boolean
  }[]
}

/** Injectable subset of Electron's App API; importing Electron is unnecessary. */
export interface FullTrustElectronLoginItemApplication {
  setLoginItemSettings(settings: FullTrustElectronLoginItemSettings): void
  getLoginItemSettings(
    options?: FullTrustElectronLoginItemQuery
  ): FullTrustElectronLoginItemState
}

export interface FullTrustElectronLoginItemAdapterOptions {
  platform: 'win32' | 'darwin'
  app: FullTrustElectronLoginItemApplication
  now?: () => string
}

export interface FullTrustLinuxPersistenceFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(
    path: string,
    content: string,
    options: { encoding: 'utf8'; flag: 'wx'; mode: number }
  ): Promise<unknown>
  unlink(path: string): Promise<unknown>
}

export interface FullTrustLinuxAutostartAdapterOptions {
  autostartDirectory: string
  fileSystem?: FullTrustLinuxPersistenceFileSystem
  now?: () => string
}

export interface ResolveFullTrustLinuxAutostartDirectoryOptions {
  autostartDirectory?: string
  environment?: NodeJS.ProcessEnv
  homeDirectory?: () => string
}

export interface CreateFullTrustOsPersistenceAdapterOptions
  extends ResolveFullTrustLinuxAutostartDirectoryOptions {
  platform?: NodeJS.Platform
  electronApp?: FullTrustElectronLoginItemApplication
  linuxFileSystem?: FullTrustLinuxPersistenceFileSystem
  now?: () => string
}

export class FullTrustOsPersistenceConflictError extends Error {
  constructor(
    readonly serviceId: string,
    readonly target: string,
    message = `OS persistence target for Full Trust service "${serviceId}" is already owned by different content.`
  ) {
    super(message)
    this.name = 'FullTrustOsPersistenceConflictError'
  }
}

export class FullTrustOsPersistenceVerificationError extends Error {
  constructor(
    readonly serviceId: string,
    readonly operation: 'register' | 'remove',
    readonly status: FullTrustOsPersistenceStatus
  ) {
    super(
      `Could not verify Full Trust OS persistence ${operation} for service "${serviceId}" (status: ${status}).`
    )
    this.name = 'FullTrustOsPersistenceVerificationError'
  }
}

/**
 * Electron login-item adapter for Windows and macOS. The Electron App instance
 * is injected so unit tests and non-Electron tooling never touch the real OS.
 */
export class FullTrustElectronLoginItemAdapter
implements FullTrustOsPersistenceAdapter {
  readonly method = 'electron-login-item' as const
  readonly platform: 'win32' | 'darwin'

  private readonly app: FullTrustElectronLoginItemApplication
  private readonly now: () => string

  constructor(options: FullTrustElectronLoginItemAdapterOptions) {
    this.platform = options.platform
    this.app = options.app
    this.now = options.now ?? defaultNow
  }

  describe(
    input: FullTrustOsPersistenceRegistrationInput
  ): FullTrustElectronLoginItemDescriptor {
    return createElectronDescriptor(this.platform, input, this.now())
  }

  async register(
    input: FullTrustOsPersistenceRegistrationInput
  ): Promise<FullTrustElectronLoginItemDescriptor> {
    const descriptor = this.describe(input)
    const before = await this.query(descriptor)
    if (before.status === 'mismatch') {
      throw new FullTrustOsPersistenceConflictError(
        descriptor.serviceId,
        descriptor.platform === 'win32'
          ? descriptor.command.executable
          : descriptor.registration.query.serviceName ?? 'mainAppService'
      )
    }
    if (before.status === 'unknown') {
      throw new FullTrustOsPersistenceVerificationError(
        descriptor.serviceId,
        'register',
        before.status
      )
    }
    if (
      before.status === 'registered'
      || before.status === 'requires-approval'
    ) {
      return descriptor
    }

    this.app.setLoginItemSettings(cloneLoginItemSettings(
      descriptor.registration.settings
    ))
    const after = await this.query(descriptor)
    if (
      after.status !== 'registered'
      && after.status !== 'requires-approval'
      && after.status !== 'disabled'
    ) {
      throw new FullTrustOsPersistenceVerificationError(
        descriptor.serviceId,
        'register',
        after.status
      )
    }
    return descriptor
  }

  async query(
    descriptor: FullTrustOsPersistenceDescriptor
  ): Promise<FullTrustOsPersistenceQueryResult> {
    assertElectronDescriptor(descriptor, this.platform)
    const raw = this.app.getLoginItemSettings(cloneLoginItemQuery(
      descriptor.registration.query
    ))
    const observed = normalizeElectronObservation(raw)
    const status = this.platform === 'win32'
      ? queryWindowsLoginItemStatus(descriptor, raw)
      : queryMacLoginItemStatus(raw)
    const exact = status === 'registered'
      || status === 'requires-approval'
      || status === 'disabled'
    return {
      descriptor,
      status,
      exact,
      active: status === 'registered',
      observed
    }
  }

  async remove(
    descriptor: FullTrustOsPersistenceDescriptor
  ): Promise<FullTrustOsPersistenceRemovalResult> {
    assertElectronDescriptor(descriptor, this.platform)
    const before = await this.query(descriptor)
    if (!before.exact) {
      return { descriptor, removed: false, before, after: before }
    }

    this.app.setLoginItemSettings(cloneLoginItemSettings(
      descriptor.cleanup.settings
    ))
    const after = await this.query(descriptor)
    if (after.status !== 'absent') {
      throw new FullTrustOsPersistenceVerificationError(
        descriptor.serviceId,
        'remove',
        after.status
      )
    }
    return { descriptor, removed: true, before, after }
  }
}

/**
 * XDG autostart adapter for Linux. Removal is conditional on byte-for-byte
 * content equality with the persisted descriptor. This is a cleanup safeguard,
 * not protection against a concurrently running Full Trust process.
 */
export class FullTrustLinuxAutostartAdapter
implements FullTrustOsPersistenceAdapter {
  readonly platform = 'linux' as const
  readonly method = 'linux-autostart-desktop' as const

  private readonly autostartDirectory: string
  private readonly fileSystem: FullTrustLinuxPersistenceFileSystem
  private readonly now: () => string

  constructor(options: FullTrustLinuxAutostartAdapterOptions) {
    this.autostartDirectory = normalizeLinuxDirectory(
      options.autostartDirectory,
      'Linux autostart directory'
    )
    this.fileSystem = options.fileSystem ?? defaultLinuxFileSystem
    this.now = options.now ?? defaultNow
  }

  describe(
    input: FullTrustOsPersistenceRegistrationInput
  ): FullTrustLinuxAutostartDescriptor {
    return createLinuxDescriptor(
      this.autostartDirectory,
      input,
      this.now()
    )
  }

  async register(
    input: FullTrustOsPersistenceRegistrationInput
  ): Promise<FullTrustLinuxAutostartDescriptor> {
    const descriptor = this.describe(input)
    const before = await this.query(descriptor)
    if (before.status === 'registered') return descriptor
    if (before.status === 'mismatch') {
      throw new FullTrustOsPersistenceConflictError(
        descriptor.serviceId,
        descriptor.cleanup.filePath
      )
    }

    await this.fileSystem.mkdir(this.autostartDirectory, { recursive: true })
    try {
      await this.fileSystem.writeFile(
        descriptor.cleanup.filePath,
        descriptor.cleanup.expectedContent,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
      )
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'EEXIST')) throw error
      const raced = await this.query(descriptor)
      if (raced.status === 'registered') return descriptor
      throw new FullTrustOsPersistenceConflictError(
        descriptor.serviceId,
        descriptor.cleanup.filePath
      )
    }

    const after = await this.query(descriptor)
    if (after.status !== 'registered') {
      throw new FullTrustOsPersistenceVerificationError(
        descriptor.serviceId,
        'register',
        after.status
      )
    }
    return descriptor
  }

  async query(
    descriptor: FullTrustOsPersistenceDescriptor
  ): Promise<FullTrustOsPersistenceQueryResult> {
    assertLinuxDescriptor(descriptor, this.autostartDirectory)
    let content: string
    try {
      content = await this.fileSystem.readFile(
        descriptor.cleanup.filePath,
        'utf8'
      )
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'ENOENT')) throw error
      return {
        descriptor,
        status: 'absent',
        exact: false,
        active: false,
        observed: {
          kind: 'linux-autostart-desktop',
          filePath: descriptor.cleanup.filePath,
          contentSha256: null
        }
      }
    }

    const contentSha256 = sha256(content)
    const exact = content === descriptor.cleanup.expectedContent
      && contentSha256 === descriptor.cleanup.expectedContentSha256
    return {
      descriptor,
      status: exact ? 'registered' : 'mismatch',
      exact,
      active: exact,
      observed: {
        kind: 'linux-autostart-desktop',
        filePath: descriptor.cleanup.filePath,
        contentSha256
      }
    }
  }

  async remove(
    descriptor: FullTrustOsPersistenceDescriptor
  ): Promise<FullTrustOsPersistenceRemovalResult> {
    assertLinuxDescriptor(descriptor, this.autostartDirectory)
    const before = await this.query(descriptor)
    if (!before.exact) {
      return { descriptor, removed: false, before, after: before }
    }

    try {
      await this.fileSystem.unlink(descriptor.cleanup.filePath)
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'ENOENT')) throw error
    }
    const after = await this.query(descriptor)
    if (after.status !== 'absent') {
      throw new FullTrustOsPersistenceVerificationError(
        descriptor.serviceId,
        'remove',
        after.status
      )
    }
    return { descriptor, removed: true, before, after }
  }
}

export function createFullTrustElectronLoginItemAdapter(
  options: FullTrustElectronLoginItemAdapterOptions
): FullTrustElectronLoginItemAdapter {
  return new FullTrustElectronLoginItemAdapter(options)
}

export function createFullTrustLinuxAutostartAdapter(
  options: FullTrustLinuxAutostartAdapterOptions
): FullTrustLinuxAutostartAdapter {
  return new FullTrustLinuxAutostartAdapter(options)
}

export function createFullTrustOsPersistenceAdapter(
  options: CreateFullTrustOsPersistenceAdapterOptions = {}
): FullTrustOsPersistenceAdapter {
  const platform = options.platform ?? process.platform
  if (platform === 'win32' || platform === 'darwin') {
    if (!options.electronApp) {
      throw new Error(`Electron App is required for Full Trust OS persistence on ${platform}.`)
    }
    return createFullTrustElectronLoginItemAdapter({
      platform,
      app: options.electronApp,
      ...(options.now ? { now: options.now } : {})
    })
  }
  if (platform === 'linux') {
    return createFullTrustLinuxAutostartAdapter({
      autostartDirectory: resolveFullTrustLinuxAutostartDirectory(options),
      ...(options.linuxFileSystem
        ? { fileSystem: options.linuxFileSystem }
        : {}),
      ...(options.now ? { now: options.now } : {})
    })
  }
  throw new Error(`Full Trust OS persistence is not supported on platform "${platform}".`)
}

export function resolveFullTrustLinuxAutostartDirectory(
  options: ResolveFullTrustLinuxAutostartDirectoryOptions = {}
): string {
  if (options.autostartDirectory !== undefined) {
    return normalizeLinuxDirectory(
      options.autostartDirectory,
      'Linux autostart directory'
    )
  }

  const environment = options.environment ?? process.env
  const xdgConfigHome = environment.XDG_CONFIG_HOME
  if (xdgConfigHome && posix.isAbsolute(xdgConfigHome)) {
    return posix.join(posix.normalize(xdgConfigHome), 'autostart')
  }
  const homeDirectory = (options.homeDirectory ?? homedir)()
  return posix.join(
    normalizeLinuxDirectory(homeDirectory, 'Linux home directory'),
    '.config',
    'autostart'
  )
}

/** Build deterministic XDG desktop-file content for an exact command vector. */
export function createFullTrustLinuxDesktopEntry(
  input: Pick<
    FullTrustOsPersistenceRegistrationInput,
    'pluginId' | 'revisionHash' | 'serviceId' | 'command'
  > & { displayName: string }
): string {
  const pluginId = normalizeText(input.pluginId, 'Full Trust plugin id')
  const revisionHash = normalizeText(
    input.revisionHash,
    'Full Trust plugin revision hash'
  )
  const serviceId = normalizeServiceId(input.serviceId)
  const displayName = normalizeText(input.displayName, 'Full Trust service display name')
  const command = normalizeCommand(input.command, 'linux')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${escapeDesktopEntryString(displayName)}`,
    `Comment=${escapeDesktopEntryString(`KnowBook Full Trust system plugin ${pluginId}`)}`,
    `Exec=${formatFullTrustLinuxDesktopExec(command)}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'X-KnowBook-FullTrust=true',
    `X-KnowBook-PluginId=${escapeDesktopEntryString(pluginId)}`,
    `X-KnowBook-RevisionHash=${escapeDesktopEntryString(revisionHash)}`,
    `X-KnowBook-ServiceId=${escapeDesktopEntryString(serviceId)}`,
    ''
  ].join('\n')
}

/**
 * Quote one executable plus its argv according to the Desktop Entry Exec rules.
 * This is argv encoding, not shell escaping; no shell is involved at startup.
 */
export function formatFullTrustLinuxDesktopExec(
  command: FullTrustOsPersistenceCommand
): string {
  const normalized = normalizeCommand(command, 'linux')
  return [normalized.executable, ...normalized.args]
    .map(quoteDesktopExecToken)
    .join(' ')
}

function createElectronDescriptor(
  platform: 'win32' | 'darwin',
  input: FullTrustOsPersistenceRegistrationInput,
  registeredAt: string
): FullTrustElectronLoginItemDescriptor {
  const base = normalizeDescriptorBase(input, platform, registeredAt)
  if (platform === 'win32') {
    const args = [...base.command.args]
    return {
      ...base,
      platform,
      method: 'electron-login-item',
      registration: {
        settings: {
          openAtLogin: true,
          enabled: true,
          name: base.serviceId,
          path: base.command.executable,
          args: [...args]
        },
        query: {
          path: base.command.executable,
          args: [...args]
        }
      },
      cleanup: {
        strategy: 'electron-set-login-item',
        settings: {
          openAtLogin: false,
          enabled: false,
          name: base.serviceId,
          path: base.command.executable,
          args: [...args]
        }
      }
    }
  }

  const type = input.macLoginItemType ?? 'mainAppService'
  assertMacLoginItemType(type)
  const service = type === 'mainAppService'
    ? { type }
    : { type, serviceName: base.serviceId }
  return {
    ...base,
    platform,
    method: 'electron-login-item',
    registration: {
      settings: { openAtLogin: true, ...service },
      query: { ...service }
    },
    cleanup: {
      strategy: 'electron-set-login-item',
      settings: { openAtLogin: false, ...service }
    }
  }
}

function createLinuxDescriptor(
  autostartDirectory: string,
  input: FullTrustOsPersistenceRegistrationInput,
  registeredAt: string
): FullTrustLinuxAutostartDescriptor {
  const base = normalizeDescriptorBase(input, 'linux', registeredAt)
  const desktopFilePath = posix.join(
    autostartDirectory,
    `${base.serviceId}.desktop`
  )
  const expectedContent = createFullTrustLinuxDesktopEntry({
    pluginId: base.pluginId,
    revisionHash: base.revisionHash,
    serviceId: base.serviceId,
    displayName: base.displayName,
    command: base.command
  })
  const expectedContentSha256 = sha256(expectedContent)
  return {
    ...base,
    platform: 'linux',
    method: 'linux-autostart-desktop',
    registration: {
      desktopFilePath,
      desktopEntrySha256: expectedContentSha256
    },
    cleanup: {
      strategy: 'delete-file-if-content-matches',
      filePath: desktopFilePath,
      expectedContent,
      expectedContentSha256
    }
  }
}

function normalizeDescriptorBase(
  input: FullTrustOsPersistenceRegistrationInput,
  platform: FullTrustOsPersistencePlatform,
  registeredAt: string
): FullTrustOsPersistenceDescriptorBase {
  if (input.trust !== 'full') {
    throw new Error('OS persistence management is available only to explicitly confirmed Full Trust plugins.')
  }
  const pluginId = normalizeText(input.pluginId, 'Full Trust plugin id')
  const revisionHash = normalizeText(
    input.revisionHash,
    'Full Trust plugin revision hash'
  )
  const serviceId = normalizeServiceId(input.serviceId)
  const displayName = input.displayName === undefined
    ? `KnowBook: ${pluginId}`
    : normalizeText(input.displayName, 'Full Trust service display name')
  const timestamp = normalizeText(registeredAt, 'OS persistence registration timestamp')
  return {
    schemaVersion: FULL_TRUST_OS_PERSISTENCE_DESCRIPTOR_VERSION,
    trust: 'full',
    pluginId,
    revisionHash,
    serviceId,
    displayName,
    command: normalizeCommand(input.command, platform),
    registeredAt: timestamp
  }
}

function assertElectronDescriptor(
  descriptor: FullTrustOsPersistenceDescriptor,
  platform: 'win32' | 'darwin'
): asserts descriptor is FullTrustElectronLoginItemDescriptor {
  assertDescriptorBase(descriptor, platform)
  if (descriptor.method !== 'electron-login-item') {
    throw new Error(`OS persistence descriptor method does not match ${platform}.`)
  }
  if (
    descriptor.cleanup.strategy !== 'electron-set-login-item'
    || descriptor.registration.settings.openAtLogin !== true
    || descriptor.cleanup.settings.openAtLogin !== false
  ) {
    throw new Error('Electron login-item descriptor cleanup metadata is invalid.')
  }

  if (platform === 'win32') {
    const expectedPath = descriptor.command.executable
    const expectedArgs = descriptor.command.args
    if (
      descriptor.registration.settings.name !== descriptor.serviceId
      || descriptor.cleanup.settings.name !== descriptor.serviceId
      || descriptor.registration.settings.path !== expectedPath
      || descriptor.cleanup.settings.path !== expectedPath
      || descriptor.registration.query.path !== expectedPath
      || !arraysEqual(descriptor.registration.settings.args, expectedArgs)
      || !arraysEqual(descriptor.cleanup.settings.args, expectedArgs)
      || !arraysEqual(descriptor.registration.query.args, expectedArgs)
    ) {
      throw new Error('Windows login-item descriptor does not match its exact command and service id.')
    }
    return
  }

  const type = descriptor.registration.query.type
  assertMacLoginItemType(type)
  const expectedServiceName = type === 'mainAppService'
    ? undefined
    : descriptor.serviceId
  if (
    descriptor.registration.settings.type !== type
    || descriptor.cleanup.settings.type !== type
    || descriptor.registration.query.serviceName !== expectedServiceName
    || descriptor.registration.settings.serviceName !== expectedServiceName
    || descriptor.cleanup.settings.serviceName !== expectedServiceName
  ) {
    throw new Error('macOS login-item descriptor does not match its exact service id and type.')
  }
}

function assertLinuxDescriptor(
  descriptor: FullTrustOsPersistenceDescriptor,
  autostartDirectory: string
): asserts descriptor is FullTrustLinuxAutostartDescriptor {
  assertDescriptorBase(descriptor, 'linux')
  if (
    descriptor.method !== 'linux-autostart-desktop'
    || descriptor.cleanup.strategy !== 'delete-file-if-content-matches'
  ) {
    throw new Error('OS persistence descriptor method does not match Linux autostart.')
  }
  const expectedPath = posix.join(
    autostartDirectory,
    `${descriptor.serviceId}.desktop`
  )
  const contentHash = sha256(descriptor.cleanup.expectedContent)
  if (
    descriptor.registration.desktopFilePath !== expectedPath
    || descriptor.cleanup.filePath !== expectedPath
    || descriptor.registration.desktopEntrySha256 !== contentHash
    || descriptor.cleanup.expectedContentSha256 !== contentHash
  ) {
    throw new Error('Linux autostart descriptor cleanup metadata is invalid.')
  }
}

function assertDescriptorBase(
  descriptor: FullTrustOsPersistenceDescriptor,
  platform: FullTrustOsPersistencePlatform
): void {
  if (
    descriptor.schemaVersion !== FULL_TRUST_OS_PERSISTENCE_DESCRIPTOR_VERSION
    || descriptor.trust !== 'full'
    || descriptor.platform !== platform
  ) {
    throw new Error(`OS persistence descriptor does not match ${platform}.`)
  }
  normalizeText(descriptor.pluginId, 'Full Trust plugin id')
  normalizeText(descriptor.revisionHash, 'Full Trust plugin revision hash')
  normalizeServiceId(descriptor.serviceId)
  normalizeText(descriptor.displayName, 'Full Trust service display name')
  normalizeText(descriptor.registeredAt, 'OS persistence registration timestamp')
  normalizeCommand(descriptor.command, platform)
}

function queryWindowsLoginItemStatus(
  descriptor: FullTrustElectronLoginItemDescriptor,
  raw: FullTrustElectronLoginItemState
): FullTrustOsPersistenceStatus {
  if (Array.isArray(raw.launchItems)) {
    const matchingName = raw.launchItems.filter(
      (item) => item.name === descriptor.serviceId
    )
    const exact = matchingName.find((item) => (
      windowsPathsEqual(item.path, descriptor.command.executable)
      && arraysEqual(item.args, descriptor.command.args)
    ))
    if (exact) return exact.enabled === false ? 'disabled' : 'registered'
    if (matchingName.length > 0 || raw.openAtLogin) return 'mismatch'
    return 'absent'
  }
  return raw.openAtLogin ? 'registered' : 'absent'
}

function queryMacLoginItemStatus(
  raw: FullTrustElectronLoginItemState
): FullTrustOsPersistenceStatus {
  if (raw.status === 'enabled') return 'registered'
  if (raw.status === 'requires-approval') return 'requires-approval'
  if (raw.status === 'not-registered' || raw.status === 'not-found') {
    return 'absent'
  }
  if (typeof raw.status === 'string') return 'unknown'
  return raw.openAtLogin ? 'registered' : 'absent'
}

function normalizeElectronObservation(
  raw: FullTrustElectronLoginItemState
): FullTrustElectronLoginItemObservation {
  const launchItems = Array.isArray(raw.launchItems)
    ? raw.launchItems.map((item) => ({
        name: typeof item.name === 'string' ? item.name : '',
        path: typeof item.path === 'string' ? item.path : '',
        args: Array.isArray(item.args)
          ? item.args.filter((argument: unknown): argument is string => typeof argument === 'string')
          : [],
        scope: typeof item.scope === 'string' ? item.scope : null,
        enabled: typeof item.enabled === 'boolean' ? item.enabled : null
      }))
    : []
  return {
    kind: 'electron-login-item',
    openAtLogin: raw.openAtLogin === true,
    status: typeof raw.status === 'string' ? raw.status : null,
    executableWillLaunchAtLogin:
      typeof raw.executableWillLaunchAtLogin === 'boolean'
        ? raw.executableWillLaunchAtLogin
        : null,
    launchItems
  }
}

function cloneLoginItemSettings(
  settings: FullTrustElectronLoginItemSettings
): FullTrustElectronLoginItemSettings {
  return {
    ...settings,
    ...(settings.args ? { args: [...settings.args] } : {})
  }
}

function cloneLoginItemQuery(
  query: FullTrustElectronLoginItemQuery
): FullTrustElectronLoginItemQuery {
  return {
    ...query,
    ...(query.args ? { args: [...query.args] } : {})
  }
}

function normalizeCommand(
  command: FullTrustOsPersistenceCommand,
  platform: FullTrustOsPersistencePlatform
): FullTrustOsPersistenceCommand {
  if (!command || typeof command !== 'object') {
    throw new Error('Full Trust OS persistence command is invalid.')
  }
  const executable = normalizeText(
    command.executable,
    'Full Trust OS persistence executable'
  )
  const isAbsolute = platform === 'win32'
    ? win32.isAbsolute(executable)
    : posix.isAbsolute(executable)
  if (!isAbsolute) {
    throw new Error('Full Trust OS persistence executable must be an absolute path.')
  }
  if (platform === 'linux' && executable.includes('=')) {
    throw new Error('Linux desktop-file executable cannot contain an equals sign.')
  }
  if (!Array.isArray(command.args)) {
    throw new Error('Full Trust OS persistence arguments must be an array.')
  }
  const args = command.args.map((argument) => {
    if (typeof argument !== 'string' || argument.includes('\0')) {
      throw new Error('Full Trust OS persistence arguments must be NUL-free strings.')
    }
    if (platform === 'linux' && /[\r\n]/u.test(argument)) {
      throw new Error('Linux desktop-file arguments cannot contain line breaks.')
    }
    return argument
  })
  if (platform === 'linux' && /[\r\n]/u.test(executable)) {
    throw new Error('Linux desktop-file executable cannot contain line breaks.')
  }
  return { executable, args }
}

function normalizeServiceId(value: string): string {
  const serviceId = normalizeText(value, 'Full Trust OS persistence service id')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(serviceId)) {
    throw new Error(
      'Full Trust OS persistence service id must use 1-128 ASCII letters, digits, dots, underscores, or hyphens.'
    )
  }
  return serviceId
}

function normalizeText(value: string, label: string): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.includes('\0')
  ) {
    throw new Error(`${label} must be a non-empty, NUL-free string.`)
  }
  return value
}

function normalizeLinuxDirectory(value: string, label: string): string {
  const directory = normalizeText(value, label)
  if (!posix.isAbsolute(directory)) {
    throw new Error(`${label} must be an absolute path.`)
  }
  return posix.normalize(directory)
}

function assertMacLoginItemType(
  value: unknown
): asserts value is FullTrustMacLoginItemType {
  if (
    value !== 'mainAppService'
    && value !== 'agentService'
    && value !== 'daemonService'
    && value !== 'loginItemService'
  ) {
    throw new Error('macOS login-item type is invalid.')
  }
}

function quoteDesktopExecToken(value: string): string {
  const escaped = [...value].map((character) => {
    if (character === '%') return '%%'
    if (character === '\\') return '\\\\\\\\'
    if (character === '"') return '\\"'
    if (character === '`') return '\\\\`'
    if (character === '$') return '\\\\$'
    return character
  }).join('')
  return `"${escaped}"`
}

function escapeDesktopEntryString(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/\n/gu, '\\n')
    .replace(/\r/gu, '\\r')
    .replace(/\t/gu, '\\t')
}

function windowsPathsEqual(left: string, right: string): boolean {
  return win32.normalize(left).toLocaleLowerCase('en-US')
    === win32.normalize(right).toLocaleLowerCase('en-US')
}

function arraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (!left || !right || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}

function defaultNow(): string {
  return new Date().toISOString()
}

const defaultLinuxFileSystem: FullTrustLinuxPersistenceFileSystem = {
  mkdir: (path, options) => makeDirectory(path, options),
  readFile: (path, encoding) => readTextFile(path, encoding),
  writeFile: (path, content, options) => writeTextFile(path, content, options),
  unlink: (path) => unlinkFile(path)
}
