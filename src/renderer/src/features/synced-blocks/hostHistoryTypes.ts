/** A local history address only. Main's opaque session and original journal
 * still prove every restore; these fields never confer a binding or writer. */
export interface SyncedHostHistoryTransition {
  documentId: string
  operationId: string
  historyToken: string
}
