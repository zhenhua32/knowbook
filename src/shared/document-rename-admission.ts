/** Display/routing information only. It is not a session, source or write permit. */
export interface DocumentRenameAdmissionInput { documentId: string; expectedUpdatedAt: string }
export type DocumentRenameAdmissionResult =
  | { status: 'ready'; documentId: string; documentCreatedAt: string; updatedAt: string; requiresFencedTitle2: boolean; writePermit: false }
  | { status: 'missing' | 'stale' }
