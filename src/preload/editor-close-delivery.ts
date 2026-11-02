import type { EditorCloseRequest, EditorCloseCancelled } from '../shared/editor-close'

/** Delivery only. Both values must originate in actual Main IPC events. This
 * keeps the original live nonce across the App's lazy chunk/effect interval;
 * it never acknowledges, starts an attempt or declares an editor clean. */
export function createEditorCloseDelivery() {
  const requests = new Set<(value: EditorCloseRequest) => void>()
  const cancellations = new Set<(value: EditorCloseCancelled) => void>()
  let pending: EditorCloseRequest | null = null, cancelled: EditorCloseCancelled | null = null
  return {
    request(value: EditorCloseRequest) {
      if (pending?.requestId === value.requestId) return
      pending = value; cancelled = null
      for (const listener of [...requests]) listener(value)
    },
    cancel(value: EditorCloseCancelled) {
      if (pending?.requestId === value.requestId) pending = null
      cancelled = value
      for (const listener of [...cancellations]) listener(value)
    },
    onRequest(listener: (value: EditorCloseRequest) => void) {
      requests.add(listener)
      if (pending) listener(pending)
      return () => { requests.delete(listener) }
    },
    onCancelled(listener: (value: EditorCloseCancelled) => void) {
      cancellations.add(listener)
      if (cancelled) listener(cancelled)
      return () => { cancellations.delete(listener) }
    }
  }
}
