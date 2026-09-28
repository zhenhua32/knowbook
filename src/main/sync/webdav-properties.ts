import { JSDOM } from 'jsdom'

/** Read only a successful DAV:getetag belonging to the requested resource. */
export function readWebDavEtag(xml: string, resourceUrl: string): string | null {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('WebDAV 文件属性包含不支持的 XML 声明。')
  let dom: JSDOM
  try { dom = new JSDOM(xml, { contentType: 'application/xml' }) }
  catch { throw new Error('WebDAV 文件属性不是有效的 XML。') }
  try {
    const root = dom.window.document.documentElement
    if (root.namespaceURI !== 'DAV:' || root.localName !== 'multistatus') throw new Error('WebDAV 文件属性响应格式无效。')
    const children = (element: Element, name: string): Element[] => Array.from(element.children)
      .filter(child => child.namespaceURI === 'DAV:' && child.localName === name)
    const requested = new URL(resourceUrl)
    const matches: Element[] = []
    for (const response of children(root, 'response')) {
      const href = children(response, 'href')[0]?.textContent?.trim()
      if (!href) continue
      let url: URL
      try { url = new URL(href, requested) } catch { continue }
      if (url.origin !== requested.origin || url.search || url.hash || url.username || url.password) continue
      try { if (decodeURIComponent(url.pathname) !== decodeURIComponent(requested.pathname)) continue } catch { continue }
      matches.push(response)
    }
    if (matches.length !== 1) throw new Error('WebDAV 文件属性未唯一对应当前文件。')
    const etags: string[] = []
    for (const propstat of children(matches[0], 'propstat')) {
      if (!/^HTTP\/\d(?:\.\d)?\s+200(?:\s|$)/.test(children(propstat, 'status')[0]?.textContent?.trim() ?? '')) continue
      for (const prop of children(propstat, 'prop')) {
        for (const etag of children(prop, 'getetag')) etags.push(etag.textContent?.trim() ?? '')
      }
    }
    if (etags.length > 1) throw new Error('WebDAV 返回了多个文件版本标识。')
    return etags[0] || null
  } finally { dom.window.close() }
}
