import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const preloadSource = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

function collectChannels(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]).sort()
}

test('every preload invoke channel has exactly one main-process handler', () => {
  const invokedChannels = collectChannels(preloadSource, /ipcRenderer\.invoke\('([^']+)'/g)
  const handledChannels = collectChannels(mainSource, /ipcMain\.handle\('([^']+)'/g)

  assert.equal(new Set(invokedChannels).size, invokedChannels.length, 'preload contains duplicate invoke channels')
  assert.equal(new Set(handledChannels).size, handledChannels.length, 'main process contains duplicate IPC handlers')
  assert.deepEqual(handledChannels, invokedChannels)
})

test('workspace mutation subscription uses the same channel in preload and main', () => {
  const preloadChannel = preloadSource.match(/WORKSPACE_MUTATED_CHANNEL\s*=\s*'([^']+)'/)?.[1]
  const mainChannel = mainSource.match(/WORKSPACE_MUTATED_CHANNEL\s*=\s*'([^']+)'/)?.[1]

  assert.equal(preloadChannel, 'knowbook:workspace-mutated')
  assert.equal(mainChannel, preloadChannel)
})

test('plugin mutation subscription uses the same channel in preload and main', () => {
  const preloadChannel = preloadSource.match(/PLUGINS_MUTATED_CHANNEL\s*=\s*'([^']+)'/)?.[1]
  const mainChannel = mainSource.match(/PLUGINS_MUTATED_CHANNEL\s*=\s*'([^']+)'/)?.[1]

  assert.equal(preloadChannel, 'knowbook:plugins-mutated')
  assert.equal(mainChannel, preloadChannel)
})
