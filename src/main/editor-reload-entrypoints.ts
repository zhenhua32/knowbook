import type { BaseWindow, KeyboardEvent, Menu, MenuItem, MenuItemConstructorOptions } from 'electron'

export interface EditorReloadKey {
  type: string; key: string; control: boolean; meta: boolean; alt: boolean; shift: boolean
}
export function editorReloadKey(input: EditorReloadKey, platform: NodeJS.Platform = process.platform): { ignoreCache: boolean } | null {
  if (input.type !== 'keyDown' || input.alt) return null
  const key = input.key.toLowerCase()
  if (key === 'f5') return { ignoreCache: input.shift || input.control || input.meta }
  if (key === 'r' && (platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta)) return { ignoreCache: input.shift }
  return null
}

const originalClick = (item: MenuItem, window: BaseWindow | undefined, event: KeyboardEvent) => {
  // MenuItem.click is Electron's native wrapper, whose documented arguments
  // differ from MenuItemConstructorOptions.click. Preserve non-editor behavior.
  const contents = window && 'webContents' in window ? window.webContents : undefined
  item.click(event, window, contents)
}
/** Only reload/forceReload roles become guarded clicks. Other leaf instances,
 * labels, accelerators and native roles remain the actual existing menu items.
 * Full Trust code replacing the application menu later is outside this host
 * menu installer; this function does not change plugin menus or their policy. */
export function guardEditorReloadMenu(menu: Menu,
  build: (items: Array<MenuItem | MenuItemConstructorOptions>) => Menu,
  admit: (window: BaseWindow | undefined, ignoreCache: boolean) => boolean): Menu {
  let changed = false
  const items = menu.items.map((item): MenuItem | MenuItemConstructorOptions => {
    const role = item.role?.toLowerCase(), force = role === 'forcereload'
    const reload = role === 'reload' || force
    const submenu = item.submenu ? guardEditorReloadMenu(item.submenu, build, admit) : undefined
    if (!reload && submenu === item.submenu) return item
    changed = true
    const common: MenuItemConstructorOptions = {
      id: reload ? force ? 'knowbook-editor-force-reload' : 'knowbook-editor-reload' : item.id,
      type: item.type, label: item.label, sublabel: item.sublabel, toolTip: item.toolTip,
      icon: item.icon, enabled: item.enabled, visible: item.visible, checked: item.checked,
      accelerator: item.accelerator, registerAccelerator: item.registerAccelerator,
      sharingItem: item.sharingItem,
      ...(submenu ? { submenu } : {})
    }
    if (reload) return { ...common,
      // A role would ignore this click handler, so it is deliberately absent.
      click: (_next, window, event) => { if (!admit(window, force)) originalClick(item, window, event) }
    }
    return { ...common, role: item.role, click: (_next, window, event) => originalClick(item, window, event) }
  })
  return changed ? build(items) : menu
}
