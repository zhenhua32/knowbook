import assert from 'node:assert/strict'
import test from 'node:test'
import type { BaseWindow, KeyboardEvent, Menu, MenuItem, MenuItemConstructorOptions } from 'electron'
import { editorReloadKey, guardEditorReloadMenu } from '../src/main/editor-reload-entrypoints'

test('only actual reload keydown combinations route to admission, including force reload and an active IME key route', () => {
  const input = { type: 'keyDown', key: 'r', control: true, meta: false, alt: false, shift: false }
  assert.deepEqual(editorReloadKey(input, 'win32'), { ignoreCache: false })
  assert.deepEqual(editorReloadKey({ ...input, shift: true }, 'linux'), { ignoreCache: true })
  assert.equal(editorReloadKey(input, 'darwin'), null)
  assert.deepEqual(editorReloadKey({ ...input, control: false, meta: true }, 'darwin'), { ignoreCache: false })
  assert.deepEqual(editorReloadKey({ ...input, control: false, key: 'F5' }), { ignoreCache: false })
  assert.deepEqual(editorReloadKey({ ...input, key: 'F5' }), { ignoreCache: true })
  assert.equal(editorReloadKey({ ...input, type: 'keyUp' }), null)
  assert.equal(editorReloadKey({ ...input, alt: true }), null)
  assert.equal(editorReloadKey({ ...input, key: 'x' }), null)
  assert.equal(editorReloadKey({ ...input, control: false, meta: false }), null)
  // Main must prevent the key even during composition; only the renderer's
  // real IME/Source/attachment/session drain can decide whether to ACK blocked.
  assert.deepEqual(editorReloadKey({ ...input, key: 'R' }), { ignoreCache: false })
})

test('the actual menu transformation removes only reload roles and preserves native fallback for unrelated windows and original callbacks', () => {
  const calls: unknown[][] = [], admitted: boolean[] = [], window = { webContents: { kind: 'actual focused contents' } } as unknown as BaseWindow
  const event = {} as KeyboardEvent
  const reload = { id: '', type: 'normal', role: 'reload', label: 'Reload', accelerator: 'CmdOrCtrl+R', enabled: true, visible: true,
    click: (...args: unknown[]) => calls.push(args) } as unknown as MenuItem
  const force = { ...reload, role: 'forceReload', accelerator: 'CmdOrCtrl+Shift+R' } as MenuItem
  const unrelated = { id: 'keep-cut', role: 'cut', label: 'Cut', click() {} } as unknown as MenuItem
  const subtree = { items: [reload, force, unrelated] } as Menu
  const branch = { id: 'existing-view', type: 'submenu', label: 'View', role: 'viewMenu', submenu: subtree, enabled: true, visible: true, click() {} } as unknown as MenuItem
  const untouched = { items: [unrelated] } as Menu
  const build = (items: Array<MenuItem | MenuItemConstructorOptions>) => ({ items }) as Menu
  assert.equal(guardEditorReloadMenu(untouched, build, () => true), untouched)
  let ownsEditor = true
  const result = guardEditorReloadMenu({ items: [branch, unrelated] } as Menu, build, (_window, force) => { admitted.push(force); return ownsEditor })
  assert.notEqual(result.items[0], branch); assert.equal(result.items[1], unrelated)
  const items = result.items[0].submenu!.items
  assert.equal(items[2], unrelated); assert.equal(items[0].role, undefined); assert.equal(items[1].role, undefined)
  assert.equal(items[0].label, 'Reload'); assert.equal(items[0].accelerator, 'CmdOrCtrl+R')
  assert.equal(items[0].id, 'knowbook-editor-reload'); assert.equal(items[1].id, 'knowbook-editor-force-reload')
  ;(items[0] as unknown as MenuItemConstructorOptions).click!(items[0], window, event)
  ;(items[1] as unknown as MenuItemConstructorOptions).click!(items[1], window, event)
  assert.deepEqual(admitted, [false, true]); assert.equal(calls.length, 0, 'even a blocked editor consumes the default native reload')
  ownsEditor = false
  ;(items[0] as unknown as MenuItemConstructorOptions).click!(items[0], window, event)
  assert.deepEqual(calls, [[event, window, (window as unknown as { webContents: object }).webContents]])
})

test('native normalized forced reload roles cannot retain an unguarded host menu action', () => {
  const admitted: boolean[] = []
  const original = { id: '', type: 'normal', role: 'forcereload', label: 'Force Reload', enabled: true, visible: true,
    click() { throw Error('The owned editor must never invoke the original native force reload') } } as unknown as MenuItem
  const build = (items: Array<MenuItem | MenuItemConstructorOptions>) => ({ items }) as Menu
  const result = guardEditorReloadMenu({ items: [original] } as Menu, build, (_window, force) => { admitted.push(force); return true })
  const guarded = result.items[0]
  assert.equal(guarded.role, undefined)
  assert.equal(guarded.id, 'knowbook-editor-force-reload')
  ;(guarded as unknown as MenuItemConstructorOptions).click!(guarded, undefined, {} as KeyboardEvent)
  assert.deepEqual(admitted, [true])
})
