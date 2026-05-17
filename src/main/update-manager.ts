import electron from 'electron'
import electronUpdater from 'electron-updater'
import type { AppUpdateState } from '@shared/contracts'

const { app } = electron
const { autoUpdater } = electronUpdater

function canUseAutoUpdates(): boolean {
  return app.isPackaged && !process.env['ELECTRON_RENDERER_URL']
}

function normalizeReleaseNotes(releaseNotes: unknown): string | null {
  if (typeof releaseNotes === 'string') {
    const value = releaseNotes.trim()
    return value.length > 0 ? value : null
  }

  if (!Array.isArray(releaseNotes)) {
    return null
  }

  const notes = releaseNotes
    .map((item) => {
      if (typeof item === 'string') {
        return item.trim()
      }

      if (item && typeof item === 'object' && 'note' in item) {
        const note = (item as { note?: unknown }).note
        return typeof note === 'string' ? note.trim() : ''
      }

      return ''
    })
    .filter((item) => item.length > 0)

  return notes.length > 0 ? notes.join('\n\n') : null
}

function createInitialState(): AppUpdateState {
  const updatesEnabled = canUseAutoUpdates()

  return {
    status: updatesEnabled ? 'idle' : 'unsupported',
    currentVersion: app.getVersion(),
    availableVersion: null,
    downloadedVersion: null,
    releaseName: null,
    releaseNotes: null,
    checkedAt: null,
    progressPercent: null,
    message: updatesEnabled
      ? 'Ready to check for updates.'
      : 'Auto updates are only available in packaged builds.',
    error: null,
    updatesEnabled,
    canInstall: false
  }
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
      this.setState({
        status: 'checking',
        checkedAt: new Date().toISOString(),
        progressPercent: null,
        error: null,
        canInstall: false,
        message: 'Checking for updates...'
      })
    })

    autoUpdater.on('update-available', (info) => {
      this.setState({
        status: 'available',
        availableVersion: info.version ?? null,
        downloadedVersion: null,
        releaseName: info.releaseName ?? null,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        checkedAt: new Date().toISOString(),
        progressPercent: 0,
        error: null,
        canInstall: false,
        message: `Update ${info.version ?? 'available'} found. Downloading in background.`
      })
    })

    autoUpdater.on('update-not-available', () => {
      this.setState({
        status: 'not-available',
        availableVersion: null,
        downloadedVersion: null,
        releaseName: null,
        releaseNotes: null,
        checkedAt: new Date().toISOString(),
        progressPercent: null,
        error: null,
        canInstall: false,
        message: 'You already have the latest version.'
      })
    })

    autoUpdater.on('download-progress', (progress) => {
      this.setState({
        status: 'downloading',
        progressPercent: Math.max(0, Math.min(100, Math.round(progress.percent))),
        error: null,
        canInstall: false,
        message: `Downloading update... ${Math.round(progress.percent)}%`
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this.setState({
        status: 'downloaded',
        availableVersion: info.version ?? this.state.availableVersion,
        downloadedVersion: info.version ?? this.state.downloadedVersion,
        releaseName: info.releaseName ?? this.state.releaseName,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes) ?? this.state.releaseNotes,
        checkedAt: new Date().toISOString(),
        progressPercent: 100,
        error: null,
        canInstall: true,
        message: `Update ${info.version ?? 'downloaded'} is ready to install.`
      })
    })

    autoUpdater.on('error', (error) => {
      this.setState({
        status: 'error',
        checkedAt: new Date().toISOString(),
        progressPercent: null,
        canInstall: false,
        message: 'Update check failed.',
        error: error instanceof Error ? error.message : String(error)
      })
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
      const message = error instanceof Error ? error.message : String(error)
      this.setState({
        status: 'error',
        checkedAt: new Date().toISOString(),
        progressPercent: null,
        canInstall: false,
        message: 'Update check failed.',
        error: message
      })

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

  private setState(patch: Partial<AppUpdateState>): void {
    this.state = {
      ...this.state,
      ...patch,
      currentVersion: app.getVersion(),
      updatesEnabled: canUseAutoUpdates()
    }
  }
}