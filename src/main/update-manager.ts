import electron from 'electron'
import electronUpdater from 'electron-updater'
import type { AppUpdateState } from '@shared/contracts'
import {
  createInitialAppUpdateState,
  reduceAppUpdateState,
  type AppUpdateEvent
} from './update-state'

const { app } = electron
const { autoUpdater } = electronUpdater

function canUseAutoUpdates(): boolean {
  return app.isPackaged && !process.env['ELECTRON_RENDERER_URL']
}

function createInitialState(): AppUpdateState {
  return createInitialAppUpdateState(app.getVersion(), canUseAutoUpdates())
}

export class AppUpdateManager {
  private state: AppUpdateState = createInitialState()

  private initialized = false

  initialize(): void {
    if (this.initialized) {
      return
    }

    this.initialized = true
    this.state = createInitialState()

    if (!this.state.updatesEnabled) {
      return
    }

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => {
      this.transition({ type: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
      this.transition({ type: 'available', info })
    })

    autoUpdater.on('update-not-available', () => {
      this.transition({ type: 'not-available' })
    })

    autoUpdater.on('download-progress', (progress) => {
      this.transition({ type: 'download-progress', percent: progress.percent })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this.transition({ type: 'downloaded', info })
    })

    autoUpdater.on('error', (error) => {
      this.transition({ type: 'error', error })
    })
  }

  getState(): AppUpdateState {
    return { ...this.state }
  }

  async checkForUpdates(silent = false): Promise<AppUpdateState> {
    this.initialize()

    if (!this.state.updatesEnabled) {
      return this.getState()
    }

    try {
      await autoUpdater.checkForUpdates()
      return this.getState()
    } catch (error) {
      this.transition({ type: 'error', error })

      if (!silent) {
        throw error
      }

      return this.getState()
    }
  }

  scheduleStartupCheck(): void {
    if (!this.state.updatesEnabled) {
      return
    }

    void this.checkForUpdates(true)
  }

  installUpdate(): void {
    if (!this.state.canInstall) {
      throw new Error('No downloaded update is ready to install yet.')
    }

    autoUpdater.quitAndInstall()
  }

  private transition(event: AppUpdateEvent): void {
    this.state = reduceAppUpdateState(this.state, event, {
      checkedAt: new Date().toISOString(),
      currentVersion: app.getVersion(),
      updatesEnabled: canUseAutoUpdates()
    })
  }
}
