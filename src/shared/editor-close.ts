export const EDITOR_CLOSE_READY_CHANNEL = 'knowbook:editor-close-listener-ready'
export const EDITOR_CLOSE_REQUEST_CHANNEL = 'knowbook:editor-close-request'
export const EDITOR_CLOSE_CANCELLED_CHANNEL = 'knowbook:editor-close-cancelled'
export const EDITOR_CLOSE_ACKNOWLEDGE_CHANNEL = 'knowbook:acknowledge-editor-close'
export type EditorCloseReason = 'window' | 'quit'
export interface EditorCloseRequest { requestId: string; reason: EditorCloseReason }
export interface EditorCloseCancelled extends EditorCloseRequest { message?: string }
export interface EditorCloseAcknowledgement { requestId: string; status: 'flushed' | 'blocked'; message?: string }
