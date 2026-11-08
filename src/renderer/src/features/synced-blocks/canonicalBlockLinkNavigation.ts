import type { AppMessageHandler } from '../../notify'
import { getCanonicalInlineRuntime } from './inlineRuntime'

export async function navigateCanonicalBlockLink(url: string, current: () => boolean, notify: AppMessageHandler, isZh: boolean) {
  if (!current()) return
  const result = await window.knowbook.resolveSyncedCanonicalBlockAddress(url)
  if (!current()) return
  if (result.status === 'ready' && await getCanonicalInlineRuntime().openSearch(result.occurrence, current)) return
  if (!current()) return
  if (result.status === 'ambiguous-instance') {
    notify(isZh ? '目标正文有多个引用，请通过搜索打开要查看的引用。' : 'This body has multiple references. Open the one you want through search.', 'warning')
  } else {
    notify(isZh ? '无法打开链接指向的同步块。' : 'The linked synced block could not be opened.', 'warning')
  }
}
