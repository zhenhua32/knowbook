import type { WorkspaceEventRecord, WorkspaceEventType } from '@shared/contracts'

export interface WorkspaceEventMetadata {
  originPluginId?: string
  correlationId?: string
  causationId?: string
}

export type WorkspaceEvent = (
  | {
      type: 'document.created'
      createdAt: string
      documentId: string
      documentTitle: string
      path: string
      parentId: string | null
    }
  | {
      type: 'document.updated'
      createdAt: string
      documentId: string
      documentTitle: string
      path: string
      affectedDocumentIds: string[]
      pathChanged: boolean
    }
  | {
      type: 'document.summary.generated'
      createdAt: string
      documentId: string
      documentTitle: string
      path: string
      summary: string
    }
  | {
      type: 'document.moved'
      createdAt: string
      documentId: string
      documentTitle: string
      oldPath: string
      newPath: string
      affectedDocumentIds: string[]
    }
  | {
      type: 'document.deleted'
      createdAt: string
      documentId: string
      documentTitle: string
      oldPath: string
      affectedDocumentIds: string[]
    }
  | {
      type: 'ai.config.updated'
      createdAt: string
      model: string
      aiEnabled: boolean
    }
) & WorkspaceEventMetadata

type WorkspaceEventHandler = (event: WorkspaceEvent) => void | Promise<void>

export class WorkspaceEventBus {
  private readonly handlers = new Set<WorkspaceEventHandler>()

  subscribe(handler: WorkspaceEventHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  async emit(event: WorkspaceEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(event)
      } catch (error) {
        console.error(`Workspace event handler failed for ${event.type}.`, error)
      }
    }
  }
}

export function createWorkspaceEventRecord(event: WorkspaceEvent): Omit<WorkspaceEventRecord, 'id'> {
  switch (event.type) {
    case 'document.created':
      return buildRecord(event.type, 'Document created', `Created "${event.documentTitle}" at ${event.path}.`, event.documentId, event.createdAt)
    case 'document.updated': {
      const descendantCount = Math.max(event.affectedDocumentIds.length - 1, 0)
      const description = event.pathChanged
        ? `Saved "${event.documentTitle}" and refreshed ${descendantCount} descendant path${descendantCount === 1 ? '' : 's'}.`
        : `Saved changes to "${event.documentTitle}".`
      return buildRecord(event.type, 'Document saved', description, event.documentId, event.createdAt)
    }
    case 'document.summary.generated':
      return buildRecord(event.type, 'Summary generated', `Generated an AI summary for "${event.documentTitle}".`, event.documentId, event.createdAt)
    case 'document.moved':
      return buildRecord(event.type, 'Document moved', `Moved "${event.documentTitle}" to ${event.newPath}.`, event.documentId, event.createdAt)
    case 'document.deleted': {
      const descendantCount = event.affectedDocumentIds.length
      const description = descendantCount > 0
        ? `Deleted "${event.documentTitle}" and reparented ${descendantCount} descendant document${descendantCount === 1 ? '' : 's'}.`
        : `Deleted "${event.documentTitle}" from ${event.oldPath}.`
      return buildRecord(event.type, 'Document deleted', description, null, event.createdAt)
    }
    case 'ai.config.updated': {
      const description = `Saved AI settings for chat model ${event.model}.`
      return buildRecord(event.type, 'AI settings updated', description, null, event.createdAt)
    }
  }
}

function buildRecord(
  type: WorkspaceEventType,
  title: string,
  description: string,
  documentId: string | null,
  createdAt: string
): Omit<WorkspaceEventRecord, 'id'> {
  return {
    type,
    title,
    description,
    documentId,
    createdAt
  }
}
