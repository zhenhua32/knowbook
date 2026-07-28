import type {
  DocumentDetail,
  PluginSettingOption,
  PluginSettingType,
  PluginSettingValue
} from '@shared/contracts'

export type PluginSettingController = {
  id: string
  pluginId: string
  getValue: () => PluginSettingValue
  setValue: (value: PluginSettingValue) => void
}

export type PluginSettingInput = {
  id: string
  label: string
  description?: string
  type: PluginSettingType
  defaultValue: PluginSettingValue
  options?: PluginSettingOption[]
}

/**
 * Plugin API provided to plugins during activation
 */
export type PluginApi = {
  contributeDashboardCard: (card: { id: string; title: string; body: string }) => {
    id: string;
    pluginId: string;
    title: string;
    body: string;
    update: (patch: { title?: string; body?: string }) => void;
  };
  contributeDocumentAction: (
    action: { id: string; label: string; description?: string },
    handler: (context: { document: DocumentDetail }) => void | string | { message?: string; refreshDocument?: boolean }
  ) => void;
  contributeSetting: (setting: PluginSettingInput) => PluginSettingController;
  onWorkspaceEvent: (eventTypes: string | string[], handler: (event: { type: string; title: string; description: string; documentId: string | null }) => void) => void;
  workspace: {
    getDocumentDetail: (documentId: string) => DocumentDetail | null;
  };
  documents: {
    updateSummary: (documentId: string, summary: string) => void;
  };
  log: (title: string, description: string, documentId?: string | null) => void;
}

/**
 * Base class for creating KnowBook plugins with TypeScript
 */
export abstract class KnowBookPlugin {
  protected api!: PluginApi
  protected manifest!: {
    id: string
    name: string
    version: string
    description?: string
    author?: string
  }

  /**
   * Activate the plugin. This is called when the plugin is loaded.
   * Override this method to set up your plugin. Plugin callbacks must complete
   * synchronously; use the sandboxed setTimeout for deferred side effects.
   */
  abstract activate(api: PluginApi): void | (() => void)

  /**
   * Helper to create a dashboard card
   */
  protected createDashboardCard(id: string, title: string, body: string) {
    this.api.contributeDashboardCard({ id, title, body })
  }

  /**
   * Helper to create a document action
   */
  protected createDocumentAction(
    id: string,
    label: string,
    handler: (context: { document: DocumentDetail }) => void | string | { message?: string; refreshDocument?: boolean },
    description?: string
  ) {
    this.api.contributeDocumentAction({ id, label, description }, handler)
  }

  /**
   * Helper to create a persisted plugin setting
   */
  protected createSetting(setting: PluginSettingInput) {
    return this.api.contributeSetting(setting)
  }

  /**
   * Helper to subscribe to workspace events
   */
  protected onWorkspaceEvent(
    eventTypes: string | string[],
    handler: (event: { type: string; title: string; description: string; documentId: string | null }) => void
  ) {
    this.api.onWorkspaceEvent(eventTypes, handler)
  }
}

/**
 * Create a plugin manifest
 */
export function createManifest(options: {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  entry?: string
  engines?: { knowbook?: string }
}): Record<string, unknown> {
  return {
    id: options.id,
    name: options.name,
    version: options.version,
    description: options.description,
    author: options.author,
    entry: options.entry ?? 'index.js',
    engines: options.engines
  }
}
