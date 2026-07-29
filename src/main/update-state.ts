import type { AppUpdateState } from '@shared/contracts'

type UpdateInfo = {
  version?: string | null
  releaseName?: string | null
  releaseNotes?: unknown
}

export type AppUpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; info: UpdateInfo }
  | { type: 'not-available' }
  | { type: 'download-progress'; percent: number }
  | { type: 'downloaded'; info: UpdateInfo }
  | { type: 'error'; error: unknown }

type AppUpdateStateContext = {
  checkedAt: string
  currentVersion: string
  updatesEnabled: boolean
}

export function normalizeReleaseNotes(releaseNotes: unknown): string | null {
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

export function createInitialAppUpdateState(
  currentVersion: string,
  updatesEnabled: boolean
): AppUpdateState {
  return {
    status: updatesEnabled ? 'idle' : 'unsupported',
    currentVersion,
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

export function reduceAppUpdateState(
  state: AppUpdateState,
  event: AppUpdateEvent,
  context: AppUpdateStateContext
): AppUpdateState {
  const sharedState = {
    currentVersion: context.currentVersion,
    updatesEnabled: context.updatesEnabled
  }

  switch (event.type) {
    case 'checking':
      return {
        ...state,
        ...sharedState,
        status: 'checking',
        checkedAt: context.checkedAt,
        progressPercent: null,
        error: null,
        canInstall: false,
        message: 'Checking for updates...'
      }
    case 'available': {
      const version = event.info.version ?? null
      return {
        ...state,
        ...sharedState,
        status: 'available',
        availableVersion: version,
        downloadedVersion: null,
        releaseName: event.info.releaseName ?? null,
        releaseNotes: normalizeReleaseNotes(event.info.releaseNotes),
        checkedAt: context.checkedAt,
        progressPercent: 0,
        error: null,
        canInstall: false,
        message: `Update ${version ?? 'available'} found. Downloading in background.`
      }
    }
    case 'not-available':
      return {
        ...state,
        ...sharedState,
        status: 'not-available',
        availableVersion: null,
        downloadedVersion: null,
        releaseName: null,
        releaseNotes: null,
        checkedAt: context.checkedAt,
        progressPercent: null,
        error: null,
        canInstall: false,
        message: 'You already have the latest version.'
      }
    case 'download-progress': {
      const progressPercent = Number.isFinite(event.percent)
        ? Math.max(0, Math.min(100, Math.round(event.percent)))
        : 0
      return {
        ...state,
        ...sharedState,
        status: 'downloading',
        progressPercent,
        error: null,
        canInstall: false,
        message: `Downloading update... ${progressPercent}%`
      }
    }
    case 'downloaded': {
      const availableVersion = event.info.version ?? state.availableVersion
      const downloadedVersion = event.info.version ?? state.downloadedVersion
      return {
        ...state,
        ...sharedState,
        status: 'downloaded',
        availableVersion,
        downloadedVersion,
        releaseName: event.info.releaseName ?? state.releaseName,
        releaseNotes: normalizeReleaseNotes(event.info.releaseNotes) ?? state.releaseNotes,
        checkedAt: context.checkedAt,
        progressPercent: 100,
        error: null,
        canInstall: true,
        message: `Update ${event.info.version ?? 'downloaded'} is ready to install.`
      }
    }
    case 'error':
      return {
        ...state,
        ...sharedState,
        status: 'error',
        checkedAt: context.checkedAt,
        progressPercent: null,
        canInstall: false,
        message: 'Update check failed.',
        error: event.error instanceof Error ? event.error.message : String(event.error)
      }
  }
}
