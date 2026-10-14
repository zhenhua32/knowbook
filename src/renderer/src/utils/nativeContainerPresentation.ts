import type { MarkdownBlockFormat } from '@shared/markdownFormat'
import { normalizeMarkdownFormat } from '@shared/markdownFormat'

export function nativeContainerPresentation(type: string, input?: MarkdownBlockFormat) {
  const format = normalizeMarkdownFormat(type, input) ?? {}
  const kind = format.calloutKind ?? 'note'
  const tone = format.calloutTone ?? ({ note: 'gray', info: 'blue', tip: 'green', warning: 'yellow', danger: 'red' } as const)[kind]
  return { kind, icon: format.calloutIcon ?? kind, tone, defaultOpen: format.toggleDefaultOpen ?? true }
}
