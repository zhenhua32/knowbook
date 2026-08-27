import type { PluginRevisionPackageInput } from '@shared/plugin-platform'

export const ACTIVITY_PULSE_V2_ID = 'activity-pulse-v2'

export const ACTIVITY_PULSE_V2_PACKAGE: PluginRevisionPackageInput = {
  manifest: {
    schemaVersion: 2,
    id: ACTIVITY_PULSE_V2_ID,
    name: 'Activity Pulse v2',
    version: '1.0.0',
    apiVersion: '2',
    worker: 'worker.js',
    description: 'QuickJS/WASM reference plugin with a dashboard card, event listener, and document action.',
    author: 'KnowBook',
    stateSchemaVersion: 1,
    permissions: [
      { capability: 'documents.read', version: 1, reason: 'Read the selected document for its summary action.' },
      { capability: 'documents.update', version: 1, reason: 'Update the selected document summary.' },
      { capability: 'plugin.storage.write', version: 1, reason: 'Remember the latest observed workspace activity.' },
      { capability: 'ui.notify', version: 1, reason: 'Confirm that the document action completed.' }
    ],
    standardModules: [{ id: '@knowbook/std/plugin', version: '1.0.0' }]
  },
  workerSource: `import { callCapability, definePlugin } from '@knowbook/std/plugin';

export default definePlugin({
  activate() {
    return {
      contributions: [
        {
          descriptor: { slot: 'dashboard.card', id: 'activity-pulse-card', order: 20 },
          value: {
            title: 'Plugin Platform v2 online',
            body: 'Activity Pulse runs inside an isolated QuickJS/WASM utility process.'
          }
        },
        {
          descriptor: { slot: 'workspace.dashboard', id: 'activity-pulse-view', order: 20 },
          value: {
            kind: 'view',
            view: {
              version: 1,
              root: {
                type: 'stack',
                gap: 6,
                children: [
                  { type: 'badge', label: 'Plugin Platform v2', tone: 'success' },
                  { type: 'text', text: 'Activity Pulse runs inside an isolated QuickJS/WASM utility process.', tone: 'muted' }
                ]
              }
            }
          }
        },
        {
          descriptor: { slot: 'document.action', id: 'summary-from-first-block', order: 20 },
          value: {
            label: 'Summary from first block (v2)',
            description: 'Use the first non-empty block to refresh the saved summary.',
            handlerId: 'document.summary-from-first-block'
          }
        },
        {
          descriptor: { slot: 'workspace.event', id: 'remember-document-activity' },
          value: {
            types: ['document.created', 'document.updated'],
            handlerId: 'workspace.remember-activity',
            includeSelf: false
          }
        }
      ]
    };
  },
  handlers: {
    async 'workspace.remember-activity'(input) {
      const event = input && input.event ? input.event : {};
      await callCapability({
        capability: 'plugin.storage.write',
        version: 1,
        input: {
          key: 'latest-document-activity',
          schemaVersion: 1,
          value: {
            type: typeof event.type === 'string' ? event.type : 'unknown',
            documentId: typeof event.documentId === 'string' ? event.documentId : null,
            documentTitle: typeof event.documentTitle === 'string' ? event.documentTitle : null,
            createdAt: typeof event.createdAt === 'string' ? event.createdAt : null
          }
        }
      });
      return null;
    },
    async 'document.summary-from-first-block'(input) {
      const detail = await callCapability({
        capability: 'documents.read',
        version: 1,
        input: { documentId: input.documentId }
      });
      const first = Array.isArray(detail.blocks)
        ? detail.blocks.find((block) => block && typeof block.content === 'string' && block.content.trim())
        : null;
      if (!first) {
        return { message: 'No non-empty block was found.', refreshDocument: false };
      }
      const summary = first.content.trim().replace(/\\s+/g, ' ').slice(0, 80);
      await callCapability({
        capability: 'documents.update',
        version: 1,
        input: { documentId: input.documentId, summary }
      });
      await callCapability({
        capability: 'ui.notify',
        version: 1,
        input: { level: 'success', title: 'Activity Pulse v2', message: 'Summary refreshed.' }
      });
      return { message: 'Summary refreshed from the first non-empty block.', refreshDocument: true };
    }
  }
});
`
}
