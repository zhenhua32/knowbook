import assert from 'node:assert/strict'
import test from 'node:test'
import type { App } from 'electron'
import {
  FullTrustOsPersistenceConflictError,
  createFullTrustElectronLoginItemAdapter,
  createFullTrustLinuxAutostartAdapter,
  createFullTrustOsPersistenceAdapter,
  resolveFullTrustLinuxAutostartDirectory,
  type FullTrustElectronLoginItemApplication,
  type FullTrustElectronLoginItemQuery,
  type FullTrustElectronLoginItemSettings,
  type FullTrustElectronLoginItemState,
  type FullTrustLinuxPersistenceFileSystem,
  type FullTrustOsPersistenceRegistrationInput
} from '../src/main/system-plugin/os-persistence.ts'

const FIXED_TIME = '2026-09-03T00:00:00.000Z'

// Keep the injectable facade structurally compatible with Electron's real App.
const asInjectedElectronApp = (
  app: Pick<App, 'setLoginItemSettings' | 'getLoginItemSettings'>
): FullTrustElectronLoginItemApplication => app
void asInjectedElectronApp

test('Windows Electron login item records, queries, and removes one exact command', async () => {
  const app = new FakeWindowsLoginItems()
  const adapter = createFullTrustElectronLoginItemAdapter({
    platform: 'win32',
    app,
    now: () => FIXED_TIME
  })
  const input = registrationInput({
    command: {
      executable: 'C:\\Program Files\\KnowBook\\KnowBook.exe',
      args: ['--system-plugin-service', 'plugin.weather', '--value=a b']
    }
  })

  const descriptor = await adapter.register(input)
  assert.deepEqual(app.calls[0], {
    openAtLogin: true,
    enabled: true,
    name: 'knowbook.plugin.weather',
    path: input.command.executable,
    args: [...input.command.args]
  })
  assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), descriptor)
  assert.equal(descriptor.registeredAt, FIXED_TIME)
  assert.deepEqual(descriptor.command, input.command)
  assert.equal(descriptor.serviceId, input.serviceId)
  assert.deepEqual(descriptor.cleanup.settings, {
    openAtLogin: false,
    enabled: false,
    name: input.serviceId,
    path: input.command.executable,
    args: [...input.command.args]
  })

  const restored = JSON.parse(JSON.stringify(descriptor)) as typeof descriptor
  const queried = await adapter.query(restored)
  assert.equal(queried.status, 'registered')
  assert.equal(queried.exact, true)
  assert.equal(queried.active, true)

  const removed = await adapter.remove(restored)
  assert.equal(removed.removed, true)
  assert.equal(removed.before.status, 'registered')
  assert.equal(removed.after.status, 'absent')
  assert.deepEqual(app.calls[1], descriptor.cleanup.settings)
})

test('Windows adapter refuses to overwrite or remove a same-id login item with another command', async () => {
  const app = new FakeWindowsLoginItems()
  app.entries.set('knowbook.plugin.weather', {
    name: 'knowbook.plugin.weather',
    path: 'C:\\Other\\service.exe',
    args: ['--unrelated'],
    scope: 'user',
    enabled: true
  })
  const adapter = createFullTrustElectronLoginItemAdapter({
    platform: 'win32',
    app
  })
  const input = registrationInput()

  await assert.rejects(
    adapter.register(input),
    FullTrustOsPersistenceConflictError
  )
  assert.equal(app.calls.length, 0)

  app.entries.clear()
  const descriptor = await adapter.register(input)
  app.entries.set(input.serviceId, {
    name: input.serviceId,
    path: 'C:\\Other\\replacement.exe',
    args: [],
    scope: 'user',
    enabled: true
  })
  const removed = await adapter.remove(descriptor)
  assert.equal(removed.removed, false)
  assert.equal(removed.before.status, 'mismatch')
  assert.equal(app.calls.length, 1)
})

test('macOS Electron service login item uses the exact type and service id', async () => {
  const app = new FakeMacLoginItems('requires-approval')
  const adapter = createFullTrustElectronLoginItemAdapter({
    platform: 'darwin',
    app,
    now: () => FIXED_TIME
  })
  const input = registrationInput({
    command: {
      executable: '/Applications/KnowBook.app/Contents/MacOS/KnowBook',
      args: []
    },
    macLoginItemType: 'agentService'
  })

  const descriptor = await adapter.register(input)
  assert.deepEqual(app.calls[0], {
    openAtLogin: true,
    type: 'agentService',
    serviceName: input.serviceId
  })
  assert.equal((await adapter.query(descriptor)).status, 'requires-approval')
  const removed = await adapter.remove(descriptor)
  assert.equal(removed.removed, true)
  assert.deepEqual(app.calls[1], {
    openAtLogin: false,
    type: 'agentService',
    serviceName: input.serviceId
  })
})

test('Linux autostart writes deterministic content and only removes the exact file', async () => {
  const fileSystem = new MemoryLinuxFileSystem()
  const adapter = createFullTrustLinuxAutostartAdapter({
    autostartDirectory: '/home/test/.config/autostart',
    fileSystem,
    now: () => FIXED_TIME
  })
  const input = registrationInput({
    command: {
      executable: '/opt/Know Book/runner',
      args: ['$HOME', '100%', 'a\\b', 'say"hi', '']
    },
    displayName: 'Weather startup'
  })

  const descriptor = await adapter.register(input)
  const expectedPath = '/home/test/.config/autostart/knowbook.plugin.weather.desktop'
  assert.equal(descriptor.cleanup.filePath, expectedPath)
  assert.equal(fileSystem.mkdirCalls[0], '/home/test/.config/autostart')
  assert.deepEqual(fileSystem.writeOptions[0], {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  })
  assert.equal(
    descriptor.cleanup.expectedContent.split('\n').find((line) => line.startsWith('Exec=')),
    'Exec="/opt/Know Book/runner" "\\\\$HOME" "100%%" "a\\\\\\\\b" "say\\"hi" ""'
  )
  assert.equal(fileSystem.files.get(expectedPath), descriptor.cleanup.expectedContent)
  assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), descriptor)
  assert.equal((await adapter.query(descriptor)).status, 'registered')

  const idempotent = await adapter.register(input)
  assert.equal(idempotent.cleanup.expectedContent, descriptor.cleanup.expectedContent)
  assert.equal(fileSystem.writeOptions.length, 1)

  fileSystem.files.set(expectedPath, `${descriptor.cleanup.expectedContent}# user edit\n`)
  const mismatch = await adapter.query(descriptor)
  assert.equal(mismatch.status, 'mismatch')
  assert.equal(mismatch.exact, false)
  const refused = await adapter.remove(descriptor)
  assert.equal(refused.removed, false)
  assert.equal(fileSystem.files.has(expectedPath), true)

  fileSystem.files.set(expectedPath, descriptor.cleanup.expectedContent)
  const removed = await adapter.remove(descriptor)
  assert.equal(removed.removed, true)
  assert.equal(removed.after.status, 'absent')
  assert.equal(fileSystem.files.has(expectedPath), false)
})

test('Linux autostart refuses an existing different desktop file and confines service ids', async () => {
  const fileSystem = new MemoryLinuxFileSystem()
  const adapter = createFullTrustLinuxAutostartAdapter({
    autostartDirectory: '/xdg/autostart',
    fileSystem
  })
  fileSystem.files.set(
    '/xdg/autostart/knowbook.plugin.weather.desktop',
    '[Desktop Entry]\nExec=/usr/bin/unrelated\n'
  )

  await assert.rejects(
    adapter.register(registrationInput({
      command: { executable: '/usr/bin/knowbook', args: [] }
    })),
    FullTrustOsPersistenceConflictError
  )
  assert.equal(fileSystem.writeOptions.length, 0)
  await assert.rejects(
    adapter.register(registrationInput({ serviceId: '../foreign' })),
    /service id/
  )
})

test('platform factory and Linux XDG resolution remain fully injectable', () => {
  assert.equal(
    resolveFullTrustLinuxAutostartDirectory({
      environment: { XDG_CONFIG_HOME: '/custom/config' },
      homeDirectory: () => {
        throw new Error('home fallback must not be read')
      }
    }),
    '/custom/config/autostart'
  )
  assert.equal(
    resolveFullTrustLinuxAutostartDirectory({
      environment: { XDG_CONFIG_HOME: 'relative-is-ignored' },
      homeDirectory: () => '/home/fallback'
    }),
    '/home/fallback/.config/autostart'
  )

  const fileSystem = new MemoryLinuxFileSystem()
  const linux = createFullTrustOsPersistenceAdapter({
    platform: 'linux',
    autostartDirectory: '/injected/autostart',
    linuxFileSystem: fileSystem
  })
  assert.equal(linux.platform, 'linux')
  assert.equal(linux.method, 'linux-autostart-desktop')
  assert.throws(
    () => createFullTrustOsPersistenceAdapter({ platform: 'win32' }),
    /Electron App is required/
  )
  assert.throws(
    () => createFullTrustOsPersistenceAdapter({ platform: 'freebsd' }),
    /not supported/
  )
})

function registrationInput(
  overrides: Partial<FullTrustOsPersistenceRegistrationInput> = {}
): FullTrustOsPersistenceRegistrationInput {
  return {
    trust: 'full',
    pluginId: 'plugin.weather',
    revisionHash: 'sha256:weather-v1',
    serviceId: 'knowbook.plugin.weather',
    command: {
      executable: 'C:\\Program Files\\KnowBook\\KnowBook.exe',
      args: ['--system-plugin-service', 'plugin.weather']
    },
    displayName: 'Weather service',
    ...overrides
  }
}

class FakeWindowsLoginItems implements FullTrustElectronLoginItemApplication {
  readonly entries = new Map<string, {
    name: string
    path: string
    args: string[]
    scope: string
    enabled: boolean
  }>()

  readonly calls: FullTrustElectronLoginItemSettings[] = []

  setLoginItemSettings(settings: FullTrustElectronLoginItemSettings): void {
    this.calls.push(cloneSettings(settings))
    const name = settings.name ?? 'default'
    if (!settings.openAtLogin) {
      this.entries.delete(name)
      return
    }
    this.entries.set(name, {
      name,
      path: settings.path ?? '',
      args: [...(settings.args ?? [])],
      scope: 'user',
      enabled: settings.enabled !== false
    })
  }

  getLoginItemSettings(
    options: FullTrustElectronLoginItemQuery = {}
  ): FullTrustElectronLoginItemState {
    const items = [...this.entries.values()].map((item) => ({
      ...item,
      args: [...item.args]
    }))
    const exact = items.find((item) => (
      item.path.toLocaleLowerCase('en-US')
        === (options.path ?? '').toLocaleLowerCase('en-US')
      && arraysEqual(item.args, options.args ?? [])
    ))
    return {
      openAtLogin: Boolean(exact),
      executableWillLaunchAtLogin: items.some((item) => (
        item.path.toLocaleLowerCase('en-US')
          === (options.path ?? '').toLocaleLowerCase('en-US')
      )),
      launchItems: items
    }
  }
}

class FakeMacLoginItems implements FullTrustElectronLoginItemApplication {
  private readonly registrations = new Map<string, string>()
  readonly calls: FullTrustElectronLoginItemSettings[] = []

  constructor(private readonly enabledStatus: string) {}

  setLoginItemSettings(settings: FullTrustElectronLoginItemSettings): void {
    this.calls.push(cloneSettings(settings))
    const key = macLoginItemKey(settings)
    if (settings.openAtLogin) this.registrations.set(key, this.enabledStatus)
    else this.registrations.delete(key)
  }

  getLoginItemSettings(
    options: FullTrustElectronLoginItemQuery = {}
  ): FullTrustElectronLoginItemState {
    const status = this.registrations.get(macLoginItemKey(options))
      ?? 'not-registered'
    return { openAtLogin: status === 'enabled', status }
  }
}

class MemoryLinuxFileSystem implements FullTrustLinuxPersistenceFileSystem {
  readonly files = new Map<string, string>()
  readonly mkdirCalls: string[] = []
  readonly writeOptions: Array<{ encoding: 'utf8'; flag: 'wx'; mode: number }> = []

  async mkdir(path: string): Promise<void> {
    this.mkdirCalls.push(path)
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path)
    if (content === undefined) throw fileSystemError('ENOENT')
    return content
  }

  async writeFile(
    path: string,
    content: string,
    options: { encoding: 'utf8'; flag: 'wx'; mode: number }
  ): Promise<void> {
    this.writeOptions.push({ ...options })
    if (this.files.has(path)) throw fileSystemError('EEXIST')
    this.files.set(path, content)
  }

  async unlink(path: string): Promise<void> {
    if (!this.files.delete(path)) throw fileSystemError('ENOENT')
  }
}

function cloneSettings(
  settings: FullTrustElectronLoginItemSettings
): FullTrustElectronLoginItemSettings {
  return {
    ...settings,
    ...(settings.args ? { args: [...settings.args] } : {})
  }
}

function macLoginItemKey(
  settings: FullTrustElectronLoginItemSettings | FullTrustElectronLoginItemQuery
): string {
  return `${settings.type ?? 'mainAppService'}:${settings.serviceName ?? ''}`
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

function fileSystemError(code: 'ENOENT' | 'EEXIST'): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}
