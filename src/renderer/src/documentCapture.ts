export const DOCUMENT_CAPTURE_EVENTS = {
  templates: 'knowbook:open-document-templates',
  quick: 'knowbook:quick-capture',
  saveTemplate: 'knowbook:save-document-template'
} as const

function openCapture(event: string, detail?: { parentId: string | null }): void {
  // Commands and document menus close before the modal takes focus.
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(event, { detail })), 0)
}

export function openDocumentTemplates(parentId: string | null = null): void {
  openCapture(DOCUMENT_CAPTURE_EVENTS.templates, { parentId })
}

export function openQuickCapture(): void {
  openCapture(DOCUMENT_CAPTURE_EVENTS.quick)
}

export function openSaveDocumentTemplate(): void {
  openCapture(DOCUMENT_CAPTURE_EVENTS.saveTemplate)
}
