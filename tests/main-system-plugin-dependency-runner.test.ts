import assert from 'node:assert/strict'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import type { SystemPluginDependencyPlan } from '../src/shared/system-plugin.ts'
import {
  createSystemPluginDependencyTasks,
  executeSystemPluginDependencyTasks,
  probeSystemPluginNativeModules,
  SystemPluginDependencyCancelledError,
  SystemPluginDependencyExecutionError,
  SystemPluginDependencyTimeoutError,
  SystemPluginNativeModuleProbeError,
  type SystemPluginDependencyLogEvent,
  type SystemPluginDependencyProcessEvent,
  type SystemPluginDependencySpawn,
  type SystemPluginDependencyStatusEvent
} from '../src/main/system-plugin/dependency-runner.ts'

const NATIVE_PROBE_SUCCESS_PREFIX = 'KNOWBOOK_NATIVE_MODULE_PROBE_OK:'

test('dependency planning creates reviewable npm, pnpm, and yarn commands without executing them', () => {
  assert.deepEqual(commandsFor({
    packageManager: 'npm',
    install: 'ci',
    allowScripts: false,
    rebuildNativeModules: false
  }), [['npm', 'ci', '--ignore-scripts']])

  assert.deepEqual(commandsFor({
    packageManager: 'pnpm',
    install: 'ci',
    allowScripts: false,
    rebuildNativeModules: false
  }), [['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']])

  assert.deepEqual(commandsFor({
    packageManager: 'yarn',
    install: 'ci',
    allowScripts: true,
    rebuildNativeModules: false
  }), [['yarn', 'install', '--frozen-lockfile']])

  assert.deepEqual(commandsFor({
    packageManager: 'pnpm',
    install: 'install',
    allowScripts: true,
    rebuildNativeModules: false
  }), [['pnpm', 'install']])
})

test('dependency planning includes explicit build and native rebuild commands in order', () => {
  const tasks = createSystemPluginDependencyTasks({
    packageManager: 'npm',
    install: 'install',
    allowScripts: true,
    buildCommand: ['npm', 'run', 'build'],
    rebuildNativeModules: true
  }, {
    nativeRebuild: {
      type: 'command',
      command: ['node', 'tools/rebuild-electron.cjs', '--abi', '135']
    }
  })

  assert.deepEqual(tasks.map((task) => task.kind), ['install', 'build', 'native-rebuild'])
  assert.deepEqual(tasks.map((task) => [...task.command]), [
    ['npm', 'install'],
    ['npm', 'run', 'build'],
    ['node', 'tools/rebuild-electron.cjs', '--abi', '135']
  ])
  assert.deepEqual(tasks.map((task) => task.execution), ['process', 'process', 'process'])

  assert.throws(() => createSystemPluginDependencyTasks({
    packageManager: 'npm',
    install: 'ci',
    allowScripts: true,
    rebuildNativeModules: true
  }), /explicit host-provided command or runner/)
  assert.throws(() => createSystemPluginDependencyTasks({
    packageManager: 'npm',
    install: 'ci',
    allowScripts: true,
    rebuildNativeModules: false
  }, {
    nativeRebuild: { type: 'command', command: ['unexpected-rebuild'] }
  }), /rebuildNativeModules is false/)
})

test('execution uses the exact artifact root, no shell, streams logs, and reports status and process lifecycle', async () => {
  const spawnCalls: SpawnCall[] = []
  const logs: SystemPluginDependencyLogEvent[] = []
  const statuses: SystemPluginDependencyStatusEvent[] = []
  const processes: SystemPluginDependencyProcessEvent[] = []
  let pid = 800
  const spawn = createFakeSpawn(spawnCalls, () => {
    const child = new FakeChildProcess(++pid)
    queueMicrotask(() => {
      child.stdout.write(`stdout:${child.pid}\n`)
      child.stderr.write(`stderr:${child.pid}\n`)
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 0, null)
    })
    return child
  })
  const tasks = createSystemPluginDependencyTasks({
    packageManager: 'npm',
    install: 'ci',
    allowScripts: false,
    buildCommand: ['npm', 'run', 'build'],
    rebuildNativeModules: true
  }, {
    nativeRebuild: { type: 'command', command: ['node', 'rebuild.cjs'] }
  })

  const result = await executeSystemPluginDependencyTasks({
    rootDirectory: './staging/artifact',
    tasks,
    spawn,
    onLog: (event) => logs.push(event),
    onStatus: (event) => statuses.push(event),
    onProcess: (event) => processes.push(event)
  })

  assert.equal(result.cwd, resolve('./staging/artifact'))
  assert.deepEqual(spawnCalls.map((call) => [call.executable, ...call.args]), tasks.map((task) => task.command))
  for (const call of spawnCalls) {
    assert.equal(call.options.cwd, resolve('./staging/artifact'))
    assert.equal(call.options.shell, false)
    assert.equal(call.options.windowsHide, true)
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'])
  }
  assert.deepEqual(statuses.map((event) => event.status), [
    'running', 'succeeded',
    'running', 'succeeded',
    'running', 'succeeded'
  ])
  assert.deepEqual(processes.map((event) => event.phase), [
    'started', 'exited',
    'started', 'exited',
    'started', 'exited'
  ])
  assert.equal(logs.filter((event) => event.stream === 'stdout').length, 3)
  assert.equal(logs.filter((event) => event.stream === 'stderr').length, 3)
  assert.deepEqual(result.tasks.map((task) => task.exitCode), [0, 0, 0])
})

test('an injected native rebuild runner receives cancellation context and can stream logs without spawning', async () => {
  const spawnCalls: SpawnCall[] = []
  const logs: SystemPluginDependencyLogEvent[] = []
  const observed: Array<{ cwd: string; signal: AbortSignal }> = []
  const spawn = createFakeSpawn(spawnCalls, () => succeedingChild(900))
  const tasks = createSystemPluginDependencyTasks({
    packageManager: 'yarn',
    install: 'install',
    allowScripts: true,
    rebuildNativeModules: true
  }, {
    nativeRebuild: {
      type: 'runner',
      command: ['host:electron-native-rebuild', '--explicit'],
      run(context) {
        observed.push({ cwd: context.cwd, signal: context.signal })
        context.writeLog('stdout', 'native rebuild complete\n')
      }
    }
  })

  const result = await executeSystemPluginDependencyTasks({
    rootDirectory: './artifact',
    tasks,
    spawn,
    onLog: (event) => logs.push(event)
  })

  assert.equal(spawnCalls.length, 1)
  assert.equal(observed.length, 1)
  assert.equal(observed[0]?.cwd, resolve('./artifact'))
  assert.equal(observed[0]?.signal.aborted, false)
  assert.equal(logs.at(-1)?.text, 'native rebuild complete\n')
  assert.deepEqual(result.tasks.map((task) => task.exitCode), [0, null])
})

test('a non-zero process failure exposes its exit code and prevents subsequent tasks', async () => {
  const spawnCalls: SpawnCall[] = []
  const spawn = createFakeSpawn(spawnCalls, () => {
    const child = new FakeChildProcess(901)
    queueMicrotask(() => child.emit('close', 7, null))
    return child
  })
  const tasks = createSystemPluginDependencyTasks({
    packageManager: 'npm',
    install: 'ci',
    allowScripts: true,
    buildCommand: ['npm', 'run', 'build'],
    rebuildNativeModules: false
  })

  await assert.rejects(executeSystemPluginDependencyTasks({
    rootDirectory: './artifact',
    tasks,
    spawn
  }), (error: unknown) => {
    assert.ok(error instanceof SystemPluginDependencyExecutionError)
    assert.equal(error.exitCode, 7)
    assert.match(error.message, /exited with code 7/)
    return true
  })
  assert.equal(spawnCalls.length, 1)
})

test('external cancellation terminates the active process and reports cancelled state', async () => {
  const controller = new AbortController()
  const statuses: SystemPluginDependencyStatusEvent[] = []
  const processes: SystemPluginDependencyProcessEvent[] = []
  const child = new FakeChildProcess(902, (signal, activeChild) => {
    queueMicrotask(() => activeChild.emit('close', null, signal))
  })
  const spawn = createFakeSpawn([], () => child)
  const tasks = createSystemPluginDependencyTasks(basePlan())

  const execution = executeSystemPluginDependencyTasks({
    rootDirectory: './artifact',
    tasks,
    spawn,
    signal: controller.signal,
    onStatus: (event) => statuses.push(event),
    onProcess: (event) => processes.push(event)
  })
  controller.abort(new Error('user cancelled'))

  await assert.rejects(execution, SystemPluginDependencyCancelledError)
  assert.deepEqual(child.killSignals, ['SIGTERM'])
  assert.deepEqual(statuses.map((event) => event.status), ['running', 'cancelled'])
  assert.deepEqual(processes.map((event) => event.phase), [
    'started',
    'termination-requested',
    'exited'
  ])
})

test('task timeout escalates from ignored TERM to forced termination and waits for close', async () => {
  const statuses: SystemPluginDependencyStatusEvent[] = []
  const processes: SystemPluginDependencyProcessEvent[] = []
  let closeConfirmed = false
  const child = new FakeChildProcess(903, (signal, activeChild) => {
    if (signal !== 'SIGKILL') return
    queueMicrotask(() => {
      closeConfirmed = true
      activeChild.emit('close', null, signal)
    })
  })
  const spawn = createFakeSpawn([], () => child)

  await assert.rejects(executeSystemPluginDependencyTasks({
    rootDirectory: './artifact',
    tasks: createSystemPluginDependencyTasks(basePlan()),
    spawn,
    timeoutMs: 10,
    terminationGraceMs: 10,
    onProcess: (event) => processes.push(event),
    onStatus: (event) => statuses.push(event)
  }), (error: unknown) => {
    assert.ok(error instanceof SystemPluginDependencyTimeoutError)
    assert.equal(error.timeoutMs, 10)
    assert.equal(error.exitCode, null)
    assert.equal(closeConfirmed, true)
    return true
  })
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL'])
  assert.deepEqual(statuses.map((event) => event.status), ['running', 'failed'])
  assert.deepEqual(processes.map((event) => event.phase), [
    'started',
    'termination-requested',
    'force-termination-requested',
    'exited'
  ])
})

test('a pre-cancelled dependency execution never spawns a process', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled before execution'))
  const calls: SpawnCall[] = []

  await assert.rejects(executeSystemPluginDependencyTasks({
    rootDirectory: './artifact',
    tasks: createSystemPluginDependencyTasks(basePlan()),
    spawn: createFakeSpawn(calls, () => succeedingChild(904)),
    signal: controller.signal
  }), SystemPluginDependencyCancelledError)

  assert.equal(calls.length, 0)
})

test('native runner cancellation waits for abort cleanup before returning', async () => {
  const controller = new AbortController()
  let cleanupComplete = false
  const tasks = createSystemPluginDependencyTasks({
    packageManager: 'npm',
    install: 'install',
    allowScripts: true,
    rebuildNativeModules: true
  }, {
    nativeRebuild: {
      type: 'runner',
      command: ['host:native-rebuild'],
      async run(context) {
        await new Promise<void>((resolvePromise) => {
          context.signal.addEventListener('abort', () => {
            setTimeout(() => {
              cleanupComplete = true
              resolvePromise()
            }, 10)
          }, { once: true })
        })
      }
    }
  })
  let spawnCount = 0
  const execution = executeSystemPluginDependencyTasks({
    rootDirectory: './artifact',
    tasks,
    spawn: createFakeSpawn([], () => {
      spawnCount += 1
      return succeedingChild(905)
    }),
    signal: controller.signal
  })

  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
  controller.abort(new Error('cancel native runner'))
  await assert.rejects(execution, SystemPluginDependencyCancelledError)
  assert.equal(spawnCount, 1)
  assert.equal(cleanupComplete, true)
})

test('native module probe discovers deterministically and requires each addon in isolated Electron Node mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-native-probe-空格-'))
  try {
    const first = join(root, 'node_modules', 'alpha', 'build', 'Release', 'alpha.node')
    const second = join(root, 'node_modules', 'zeta', 'prebuilds', 'zeta.node')
    const pluginOwned = join(root, 'build', 'Release', 'plugin.node')
    mkdirSync(join(first, '..'), { recursive: true })
    mkdirSync(join(second, '..'), { recursive: true })
    mkdirSync(join(pluginOwned, '..'), { recursive: true })
    writeFileSync(first, 'not loaded by the fake child')
    writeFileSync(second, 'not loaded by the fake child')
    writeFileSync(pluginOwned, 'bundled outside node_modules')
    writeFileSync(join(root, 'node_modules', 'zeta', 'ignored.NODE'), 'case-sensitive extension')

    const calls: SpawnCall[] = []
    let pid = 1_000
    const spawn: SystemPluginDependencySpawn = (executable, args, options) => {
      calls.push({ executable, args: [...args], options })
      const child = new FakeChildProcess(++pid)
      const nonce = args.at(-1)
      assert.equal(typeof nonce, 'string')
      queueMicrotask(() => {
        child.stderr.write('diagnostic output is allowed\n')
        child.stdout.write(NATIVE_PROBE_SUCCESS_PREFIX.slice(0, 12))
        child.stdout.write(`${NATIVE_PROBE_SUCCESS_PREFIX.slice(12)}${nonce}\n`)
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 0, null)
      })
      return child as unknown as ChildProcess
    }
    const logs: string[] = []
    const executable = resolve(root, 'Electron With Spaces.exe')
    const result = await probeSystemPluginNativeModules({
      rootDirectory: root,
      executable,
      environment: {
        KNOWBOOK_PROBE_FIXTURE: 'preserved',
        NODE_OPTIONS: '--require=malicious-loader',
        NODE_PATH: 'malicious-module-path',
        ELECTRON_RUN_AS_NODE: '0'
      },
      spawn,
      onLog: (event) => logs.push(`${event.modulePath}:${event.stream}:${event.text}`)
    })

    assert.deepEqual(result.nativeModules, [
      'build/Release/plugin.node',
      'node_modules/alpha/build/Release/alpha.node',
      'node_modules/zeta/prebuilds/zeta.node'
    ])
    assert.equal(result.strategy, 'electron-node-require')
    assert.equal(calls.length, 3)
    assert.equal(logs.some((line) => line.includes('diagnostic output is allowed')), true)
    for (const [index, call] of calls.entries()) {
      assert.equal(call.executable, executable)
      assert.equal(call.args[0], '--eval')
      assert.equal(call.args[2], '--')
      assert.equal(call.args[3], resolve(root, result.nativeModules[index]))
      assert.match(call.args[4] ?? '', /^[0-9a-f-]{36}$/)
      assert.equal(call.options.cwd, resolve(root))
      assert.equal(call.options.shell, false)
      assert.equal(call.options.windowsHide, true)
      assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'])
      const environment = call.options.env as NodeJS.ProcessEnv
      assert.equal(environment.ELECTRON_RUN_AS_NODE, '1')
      assert.equal(environment.KNOWBOOK_PROBE_FIXTURE, 'preserved')
      assert.equal(environment.NODE_OPTIONS, undefined)
      assert.equal(environment.NODE_PATH, undefined)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('native module probe accepts a runtime tree without native binaries and does not spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-native-probe-empty-'))
  try {
    const calls: SpawnCall[] = []
    const result = await probeSystemPluginNativeModules({
      rootDirectory: root,
      executable: resolve(root, 'electron'),
      spawn: createFakeSpawn(calls, () => succeedingChild(1_100))
    })
    assert.deepEqual(result.nativeModules, [])
    assert.equal(calls.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a pre-cancelled native module probe stops before scanning or spawning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-native-probe-cancelled-'))
  try {
    const controller = new AbortController()
    controller.abort(new Error('cancel before discovery'))
    const calls: SpawnCall[] = []
    await assert.rejects(probeSystemPluginNativeModules({
      rootDirectory: root,
      executable: resolve(root, 'electron'),
      signal: controller.signal,
      spawn: createFakeSpawn(calls, () => succeedingChild(1_125))
    }), (error: unknown) => {
      assert.ok(error instanceof SystemPluginNativeModuleProbeError)
      assert.equal(error.modulePath, '<scan>')
      assert.match(error.message, /cancelled during runtime discovery/)
      return true
    })
    assert.equal(calls.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('native module probe timeout escalates and waits for the probe process to close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-native-probe-timeout-'))
  try {
    const nativeModule = join(root, 'node_modules', 'fixture', 'binding.node')
    mkdirSync(join(nativeModule, '..'), { recursive: true })
    writeFileSync(nativeModule, 'fake addon')
    let closeConfirmed = false
    const child = new FakeChildProcess(1_150, (signal, activeChild) => {
      if (signal !== 'SIGKILL') return
      queueMicrotask(() => {
        closeConfirmed = true
        activeChild.emit('close', null, signal)
      })
    })

    await assert.rejects(probeSystemPluginNativeModules({
      rootDirectory: root,
      executable: resolve(root, 'electron'),
      spawn: createFakeSpawn([], () => child),
      timeoutMs: 10,
      terminationGraceMs: 10
    }), (error: unknown) => {
      assert.ok(error instanceof SystemPluginNativeModuleProbeError)
      assert.match(error.message, /timed out after 10ms/)
      assert.equal(closeConfirmed, true)
      return true
    })
    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('native module probe rejects non-zero exits and exit zero without its completion nonce', async () => {
  for (const fixture of [
    { exitCode: 9, output: '' },
    { exitCode: 0, output: 'addon exited before the host wrapper completed\n' }
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'knowbook-native-probe-failure-'))
    try {
      const nativeModule = join(root, 'node_modules', 'fixture', 'binding.node')
      mkdirSync(join(nativeModule, '..'), { recursive: true })
      writeFileSync(nativeModule, 'fake addon')
      const calls: SpawnCall[] = []
      const spawn = createFakeSpawn(calls, () => {
        const child = new FakeChildProcess(1_200)
        queueMicrotask(() => {
          if (fixture.output) child.stdout.write(fixture.output)
          child.stdout.end()
          child.stderr.end()
          child.emit('close', fixture.exitCode, null)
        })
        return child
      })

      await assert.rejects(probeSystemPluginNativeModules({
        rootDirectory: root,
        executable: resolve(root, 'electron'),
        spawn
      }), (error: unknown) => {
        assert.ok(error instanceof SystemPluginNativeModuleProbeError)
        assert.equal(error.modulePath, 'node_modules/fixture/binding.node')
        assert.equal(error.exitCode, fixture.exitCode)
        assert.match(error.message, /completion not confirmed|failed/)
        return true
      })
      assert.equal(calls.length, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

type SpawnCall = {
  executable: string
  args: readonly string[]
  options: SpawnOptions
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = []

  constructor(
    readonly pid: number,
    private readonly onKill?: (
      signal: NodeJS.Signals | number | undefined,
      child: FakeChildProcess
    ) => void
  ) {
    super()
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal)
    this.onKill?.(signal, this)
    return true
  }
}

function createFakeSpawn(
  calls: SpawnCall[],
  factory: () => FakeChildProcess
): SystemPluginDependencySpawn {
  return (executable, args, options) => {
    calls.push({ executable, args: [...args], options })
    return factory() as unknown as ChildProcess
  }
}

function succeedingChild(pid: number): FakeChildProcess {
  const child = new FakeChildProcess(pid)
  queueMicrotask(() => {
    child.stdout.end()
    child.stderr.end()
    child.emit('close', 0, null)
  })
  return child
}

function commandsFor(plan: SystemPluginDependencyPlan): string[][] {
  return createSystemPluginDependencyTasks(plan).map((task) => [...task.command])
}

function basePlan(): SystemPluginDependencyPlan {
  return {
    packageManager: 'npm',
    install: 'ci',
    allowScripts: true,
    rebuildNativeModules: false
  }
}
