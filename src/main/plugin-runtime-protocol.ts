import type {
  DocumentDetail,
  PluginDashboardCard,
  PluginDocumentAction,
  PluginSettingDescriptor,
  PluginSettingValue,
  PluginSource,
  PluginStatus,
  RunPluginDocumentActionResult,
  WorkspaceEventType
} from '@shared/contracts'
import type { WorkspaceEvent } from './event-bus'

export type PluginRuntimeState = {
  status: PluginStatus
  error?: string
  dashboardCards: PluginDashboardCard[]
  documentActions: PluginDocumentAction[]
  settings: PluginSettingDescriptor[]
}

export type PluginRuntimeWorkspaceEventRecord = {
  type: WorkspaceEventType
  title: string
  description: string
  documentId?: string | null
  createdAt?: string
}

export type PluginRuntimeEffect =
  | {
      type: 'setting.saved'
      key: string
      value: string
    }
  | {
      type: 'document.summary.updated'
      documentId: string
      summary: string
    }
  | {
      type: 'workspace-event.recorded'
      event: PluginRuntimeWorkspaceEventRecord
    }

export type PluginRuntimeOutput<TResult = unknown> = {
  state: PluginRuntimeState
  effects: PluginRuntimeEffect[]
  result?: TResult
}

export type PluginRuntimeInitializeInput = {
  pluginId: string
  directory: string
  source: PluginSource
  currentVersion: string
  settings: Record<string, string>
  documents: DocumentDetail[]
  recordLoadEvent: boolean
}

export type PluginRuntimeCommand =
  | {
      type: 'initialize'
      input: PluginRuntimeInitializeInput
    }
  | {
      type: 'workspace-event'
      event: WorkspaceEvent
      documents: DocumentDetail[]
      removedDocumentIds: string[]
    }
  | {
      type: 'document-action'
      actionId: string
      document: DocumentDetail
    }
  | {
      type: 'setting-update'
      settingId: string
      value: PluginSettingValue
    }
  | {
      type: 'dispose'
    }

export type PluginRuntimeRequest = {
  kind: 'request'
  requestId: number
  command: PluginRuntimeCommand
}

export type PluginRuntimeResponse = {
  kind: 'response'
  requestId: number
  ok: boolean
  output?: PluginRuntimeOutput
  error?: string
}

export type PluginRuntimeNotification = {
  kind: 'state-changed'
  output: PluginRuntimeOutput
}

export type PluginRuntimeMessage = PluginRuntimeResponse | PluginRuntimeNotification

export interface IsolatedPluginRuntime {
  initialize(input: PluginRuntimeInitializeInput): Promise<PluginRuntimeOutput>
  handleWorkspaceEvent(
    event: WorkspaceEvent,
    documents: DocumentDetail[],
    removedDocumentIds: string[]
  ): Promise<PluginRuntimeOutput>
  runDocumentAction(actionId: string, document: DocumentDetail): Promise<PluginRuntimeOutput<RunPluginDocumentActionResult>>
  updateSetting(settingId: string, value: PluginSettingValue): Promise<PluginRuntimeOutput>
  dispose(): Promise<void>
  onStateChanged(listener: (output: PluginRuntimeOutput) => void): () => void
  onFailure(listener: (error: Error) => void): () => void
}

export type IsolatedPluginRuntimeFactory = (pluginId: string) => IsolatedPluginRuntime
