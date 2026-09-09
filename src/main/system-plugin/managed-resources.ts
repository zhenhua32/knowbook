import { randomUUID } from 'node:crypto'
import type { SystemPluginFramePolicyInput } from '@shared/system-plugin'
import type { SystemPluginManagedResourceSummary } from '@shared/system-plugin-state'

export interface SystemPluginResourceOwner {
  id: string
  revisionHash: string
}

export interface SystemPluginDesktopResourceRegistration {
  window(window: Electron.BrowserWindow): () => void
  menu(menu: Electron.Menu): () => void
  tray(tray: Electron.Tray): () => void
}

interface ResourceEntry {
  owner: SystemPluginResourceOwner
  snapshot(): SystemPluginManagedResourceSummary | null
  unregister(): void
}

/** Lifecycle disposal must also close windows whose page cancels beforeunload. */
export function disposeSystemPluginWindow(
  window: Pick<Electron.BrowserWindow, 'isDestroyed' | 'close' | 'destroy'>
): void {
  if (window.isDestroyed()) return
  try {
    window.close()
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
  if (!window.isDestroyed()) throw new Error('The managed plugin window could not be destroyed.')
}

/** Tracks only objects explicitly created by the host desktop SDK. */
export class SystemPluginManagedResources {
  private readonly resources = new Map<string, ResourceEntry>()

  constructor(private readonly onChange: () => void = () => undefined) {}

  forPlugin(owner: SystemPluginResourceOwner): SystemPluginDesktopResourceRegistration {
    const identity = { id: owner.id, revisionHash: owner.revisionHash }
    return {
      window: (window) => {
        const changed = (): void => this.onChange()
        const unregister = this.register(identity, () => window.isDestroyed() ? null : {
          kind: 'window',
          label: window.getTitle() || 'BrowserWindow',
          windowId: window.id,
          webContentsId: window.webContents.id
        }, () => {
          window.removeListener('closed', unregister)
          window.removeListener('page-title-updated', changed)
        })
        window.once('closed', unregister)
        window.on('page-title-updated', changed)
        return unregister
      },
      menu: (menu) => this.register(identity, () => ({
        kind: 'menu',
        // A Menu has no destroyed state. Its host registration lasts until disposal,
        // whether it is currently displayed as a popup or application menu or not.
        label: menu.items.map((item) => item.label).filter(Boolean).slice(0, 3).join(' · ') || 'Menu'
      })),
      tray: (tray) => {
        const originalDestroy = tray.destroy
        const destroy = function(this: Electron.Tray): void {
          originalDestroy.call(this)
          if (this === tray && tray.isDestroyed()) unregister()
        }
        const unregister = this.register(identity, () => tray.isDestroyed() ? null : {
          kind: 'tray',
          label: 'Tray'
        }, () => {
          if (tray.destroy === destroy) tray.destroy = originalDestroy
        })
        // Electron Tray emits no destruction event. Observe only this SDK-created
        // instance, retaining its native identity and original method receiver.
        tray.destroy = destroy
        return unregister
      }
    }
  }

  snapshot(pluginId: string): SystemPluginManagedResourceSummary[] {
    const result: SystemPluginManagedResourceSummary[] = []
    for (const entry of this.resources.values()) {
      if (entry.owner.id !== pluginId) continue
      const summary = entry.snapshot()
      if (summary) result.push(summary)
      else entry.unregister()
    }
    return result
  }

  private register(
    owner: SystemPluginResourceOwner,
    snapshot: () => Pick<SystemPluginManagedResourceSummary, 'kind' | 'label' | 'windowId' | 'webContentsId'> | null,
    onRemove: () => void = () => undefined
  ): () => void {
    const id = `desktop:${randomUUID()}`
    const unregister = (): void => {
      if (!this.resources.delete(id)) return
      onRemove()
      this.onChange()
    }
    this.resources.set(id, {
      owner,
      unregister,
      snapshot: () => {
        try {
          const value = snapshot()
          return value ? { ...value, id, source: 'desktop-sdk', revisionHash: owner.revisionHash } : null
        } catch {
          // Native objects can be destroyed between the liveness check and reads.
          return null
        }
      }
    })
    this.onChange()
    return unregister
  }
}

export function snapshotSystemPluginFrameResources(
  pluginId: string,
  policies: ReadonlyMap<string, SystemPluginFramePolicyInput>,
  popups: ReadonlyMap<number, { frameName: string; window: Electron.BrowserWindow }>
): SystemPluginManagedResourceSummary[] {
  const result: SystemPluginManagedResourceSummary[] = []
  for (const policy of policies.values()) {
    if (policy.pluginId !== pluginId) continue
    result.push({
      id: `frame:${policy.frameName}`,
      kind: 'frame',
      source: 'renderer-frame',
      label: policy.frameName,
      revisionHash: policy.revisionHash,
      frameName: policy.frameName,
      allowedOrigins: [...policy.allowedOrigins],
      framePolicy: {
        allowPopups: policy.allowPopups,
        allowNavigation: policy.allowNavigation,
        allowDownloads: policy.allowDownloads,
        allowPermissions: policy.allowPermissions
      }
    })
  }
  for (const [webContentsId, popup] of popups) {
    const policy = policies.get(popup.frameName)
    if (!policy || policy.pluginId !== pluginId || popup.window.isDestroyed()) continue
    result.push({
      id: `popup:${webContentsId}`,
      kind: 'window',
      source: 'renderer-frame',
      label: popup.window.getTitle() || policy.popupName,
      revisionHash: policy.revisionHash,
      frameName: popup.frameName,
      windowId: popup.window.id,
      webContentsId
    })
  }
  return result
}

export function removeSystemPluginFrameResources(
  frameName: string,
  policies: Map<string, SystemPluginFramePolicyInput>,
  popups: Map<number, { frameName: string; window: Electron.BrowserWindow }>
): void {
  for (const [webContentsId, popup] of popups) {
    if (popup.frameName !== frameName) continue
    // Retain ownership if destruction fails; never hide a surviving privileged
    // window by dropping its frame policy first.
    disposeSystemPluginWindow(popup.window)
    popups.delete(webContentsId)
  }
  policies.delete(frameName)
}
