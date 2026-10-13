import assert from 'node:assert/strict'
import test from 'node:test'
import { FULL_IMAGE_CROP, computeImageCropLayout, normalizeImageCrop, normalizeImagePresentation, parseImageFigure, serializeImageFigure, type ImagePresentation } from '../src/shared/markdownMedia'
import { collectMarkdownImageOccurrences, planMarkdownImageDisplays, replaceMarkdownImageOccurrence } from '../src/shared/markdownMediaOccurrences'
import { collectMarkdownDestinations, rewriteMarkdownDestinations } from '../src/shared/markdownLinks'
import { markdownEngine } from '../src/shared/markdownEngine'
import { parseMarkdownBackupDocument, parseMarkdownBlocks, renderMarkdownFrontmatter, serializeBlocksToMarkdown } from '../src/shared/markdown'
import { htmlClipboardToMarkdown } from '../src/shared/htmlClipboard'
import { JSDOM } from 'jsdom'

const image = (patch: Partial<ImagePresentation> = {}): ImagePresentation => ({ src: 'file:///C:/assets/original.png', alt: '无障碍说明', caption: '独立图注', align: 'center', ...patch })

test('canonical media round trips Chinese, special characters, alt and independent caption without executable attributes', () => {
  const presentation = image({ alt: 'alt " < > &\n第二行', caption: '中文 <script>literal</script> & 图片\r\n说明', title: 'title " &',
    width: 480, height: 320, crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 } })
  let source = serializeImageFigure(presentation)
  for (let cycle = 0; cycle < 3; cycle++) {
    assert.deepEqual(parseImageFigure(source), presentation)
    assert.equal(serializeImageFigure(parseImageFigure(source)!), source)
    source = serializeImageFigure(parseImageFigure(source)!)
  }
  assert.ok(source.includes('&lt;script&gt;literal&lt;/script&gt;'))
  const external = source.replace('<figure ', '<figure onclick="evil()" style="position:fixed" data-block-id="stolen" ')
    .replace('<img ', '<img onerror="evil()" srcset="https://bad.test/a 2x" ')
  assert.equal(serializeImageFigure(parseImageFigure(external)!), source)
})

test('media normalization rejects unsafe sources, impossible dimensions and crop rectangles', () => {
  for (const src of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:image/svg+xml,a', 'blob:opaque', 'mailto:x@y.test', '//example.test/a', 'https://example.test/\u0000x', 'file:///C:\\private.png']) {
    assert.equal(normalizeImagePresentation(image({ src })), null, src)
    assert.equal(parseImageFigure(`<figure><img src="${src}"><figcaption>Keep</figcaption></figure>`), null)
  }
  for (const width of [0, -1, 1.5, 10001, Infinity, NaN]) assert.equal(normalizeImagePresentation(image({ width })), null)
  assert.equal(normalizeImagePresentation(image({ width: 1, height: 10000 }))?.height, 10000)
  for (const crop of [null, {}, { x: -0.1, y: 0, width: 1, height: 1 }, { x: 0.8, y: 0, width: 0.3, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 1, height: Infinity },
    { x: 0, y: 0, width: 1e-310, height: 1e-310 }, { x: '0', y: 0, width: 1, height: 1 }]) assert.equal(normalizeImageCrop(crop), null)
  assert.deepEqual(normalizeImageCrop(FULL_IMAGE_CROP), FULL_IMAGE_CROP)
  assert.throws(() => serializeImageFigure(image({ crop: { x: 1, y: 0, width: 1, height: 1 } })), /Invalid image presentation/)
})

test('figure parsing does not silently discard extra images, nested markup or visible text', () => {
  for (const source of [
    '<figure><img src="a.png"><img src="b.png"></figure>',
    '<figure>Before<img src="a.png"><figcaption>Caption</figcaption></figure>',
    '<figure><img src="a.png"><figcaption><strong>Caption</strong></figcaption></figure>',
    '<figure><img src="a.png"><script>evil()</script></figure>',
    '<figure><img src="a.png"><figcaption>Unclosed',
    '<figure><img src="a.png"><figcaption>Unclosed caption</figure>',
    '<figure><img src="a.png"></figure>Extra text',
    '<figure data-knowbook-crop="0,,1,1"><img src="a.png"></figure>',
    '<figure data-knowbook-align="expression()"><img src="a.png"></figure>'
  ]) assert.equal(parseImageFigure(source), null, source)
})

test('every duplicate URL occurrence has exact independent source bounds and replacing one retains surrounding text', () => {
  const source = '前文 ![first](file:///C:/assets/original.png "First title") 中间 '
    + '<img src="file:///C:/assets/original.png" alt="second" width="240" height="120"> 后文'
  const occurrences = collectMarkdownImageOccurrences(source)
  assert.equal(occurrences.length, 2)
  assert.deepEqual(occurrences.map(entry => source.slice(entry.start, entry.end)), occurrences.map(entry => entry.source))
  assert.equal(occurrences[0].presentation.alt, 'first')
  assert.equal(occurrences[0].presentation.title, 'First title')
  assert.deepEqual(occurrences[1].presentation, image({ alt: 'second', caption: '', align: 'left', width: 240, height: 120 }))
  const next = { ...occurrences[1].presentation, caption: '第二张的图注', align: 'right' as const, crop: { x: 0.25, y: 0, width: 0.5, height: 1 } }
  const replaced = replaceMarkdownImageOccurrence(source, occurrences[1], next)!
  assert.equal(replaced, source.slice(0, occurrences[1].start) + serializeImageFigure(next) + ' 后文')
  assert.ok(replaced.includes(occurrences[0].source))
  assert.equal(replaceMarkdownImageOccurrence('changed ' + source, occurrences[1], next), null)
  assert.equal(replaceMarkdownImageOccurrence(source.replace('前文', '外文'), occurrences[1], next), null)
  assert.equal(replaceMarkdownImageOccurrence(source, occurrences[1], { ...next, src: 'javascript:bad' }), null)
})

test('canonical figures and regular images retain occurrences through portable source rewriting', () => {
  const source = serializeImageFigure(image({ width: 420, crop: { x: 0, y: 0.2, width: 1, height: 0.6 } }))
  const occurrences = collectMarkdownImageOccurrences(source)
  assert.equal(occurrences.length, 1)
  assert.equal(occurrences[0].start, 0)
  assert.equal(occurrences[0].end, source.length)
  assert.deepEqual(occurrences[0].presentation, parseImageFigure(source))
  assert.equal(collectMarkdownDestinations(source).filter(link => link.kind === 'image').length, 1)
  const portable = rewriteMarkdownDestinations(source, link => link.kind === 'image' ? 'assets/图片 & original.png' : null)
  const restored = parseImageFigure(portable)!
  assert.equal(restored.src, 'assets/图片 & original.png')
  assert.equal(restored.caption, '独立图注')
  assert.deepEqual(restored.crop, occurrences[0].presentation.crop)
  assert.equal(collectMarkdownImageOccurrences(portable).length, 1)
})

test('the existing Markdown grammar excludes code, YAML, escaped syntax and unsafe images', () => {
  const source = '---\nimage: "![yaml](hidden.png)"\n---\n\n`![inline](hidden.png)`\n\n```md\n<img src="hidden.png">\n```\n\n'
    + '\\![escaped](hidden.png)\n\n![unsafe](javascript:alert(1))\n\n![real](assets/real.png)'
  const occurrences = collectMarkdownImageOccurrences(source)
  assert.equal(occurrences.length, 1)
  assert.equal(occurrences[0].source, '![real](assets/real.png)')
  assert.equal(occurrences[0].presentation.src, 'assets/real.png')
  const invalidStart = '![incomplete \n\n\\![escaped](hidden.png)\n\n![real](assets/real.png)'
  assert.deepEqual(collectMarkdownImageOccurrences(invalidStart).map(image => image.source), ['![real](assets/real.png)'])
})

test('Markdown image bounds use its parser for nested labels, spaces, parentheses and CRLF source positions', () => {
  const source = '中文😀\r\n\r\n![a [nested] \\] label](<assets/图 (1).png> "独立title")\r\n尾部'
  const occurrences = collectMarkdownImageOccurrences(source)
  assert.equal(occurrences.length, 1)
  assert.equal(occurrences[0].source, '![a [nested] \\] label](<assets/图 (1).png> "独立title")')
  assert.equal(source.slice(occurrences[0].start, occurrences[0].end), occurrences[0].source)
  assert.equal(occurrences[0].presentation.alt, 'a [nested] ] label')
  assert.equal(occurrences[0].presentation.title, '独立title')
})

test('reference-style images stay independent of their shared definition and code spans remain excluded', () => {
  const source = '![First][cover] and ![Second][cover] `![hidden][cover]`\n\n[cover]: assets/cover.png "Title"'
  const occurrences = collectMarkdownImageOccurrences(source)
  assert.equal(occurrences.length, 2)
  assert.deepEqual(occurrences.map(image => image.presentation.alt), ['First', 'Second'])
  assert.deepEqual(occurrences.map(image => image.source), ['![First][cover]', '![Second][cover]'])
  const changed = replaceMarkdownImageOccurrence(source, occurrences[1], { ...occurrences[1].presentation, caption: 'Second only' })!
  assert.ok(changed.includes('![First][cover]'))
  assert.ok(changed.endsWith('[cover]: assets/cover.png "Title"'))
})

test('linked images retain exact inner ranges, outer links and multiline captions through rendering and source round trips', () => {
  const source = '[![Linked](file:///C:/assets/original.png)](https://example.test) and ![Normal](file:///C:/assets/original.png)'
  const occurrences = collectMarkdownImageOccurrences(source)
  assert.deepEqual(occurrences.map(item => item.presentation.alt), ['Linked', 'Normal'])
  assert.equal(occurrences[0].source, '![Linked](file:///C:/assets/original.png)')
  const next = { ...occurrences[0].presentation, caption: 'First line\n\n第二段\r\nFinal line', width: 320 }
  let updated = replaceMarkdownImageOccurrence(source, occurrences[0], next)!
  assert.ok(updated.startsWith('[<figure'))
  assert.ok(updated.includes('](https://example.test) and ![Normal]'))
  for (let cycle = 0; cycle < 3; cycle++) {
    const rendered = new JSDOM(markdownEngine.render(updated, {}))
    assert.equal(rendered.window.document.querySelectorAll('img').length, 2)
    assert.equal(rendered.window.document.querySelector('a')?.getAttribute('href'), 'https://example.test')
    assert.equal(rendered.window.document.querySelector('.markdown-image-caption')?.textContent, next.caption.replace(/\r\n?/g, '\n'))
    assert.deepEqual(collectMarkdownImageOccurrences(updated)[0].presentation, next)
    assert.deepEqual(planMarkdownImageDisplays(updated).map(item => Boolean(item.occurrence)), [true, true])
    rendered.window.close()
    updated = serializeBlocksToMarkdown(parseMarkdownBlocks(updated))
  }
})

test('rendered image planning retains unsupported source images without borrowing another duplicate URL occurrence', () => {
  const url = 'file:///C:/assets/original.png'
  const source = `<img width="50%" alt="Unsupported" src="${url}"> and ![Normal](${url})`
  const displays = planMarkdownImageDisplays(source)
  assert.equal(displays.length, 2)
  assert.deepEqual(displays.map(item => item.presentation.alt), ['Unsupported', 'Normal'])
  assert.deepEqual(displays.map(item => Boolean(item.occurrence)), [false, true])
  const ambiguous = planMarkdownImageDisplays(`<img width="50%" alt="Same" src="${url}"> and ![Same](${url})`)
  assert.equal(ambiguous.length, 2)
  assert.deepEqual(ambiguous.map(item => Boolean(item.occurrence)), [false, false])
  const repeated = planMarkdownImageDisplays(`![Same](${url}) and ![Same](${url})`)
  assert.equal(repeated.length, 2)
  assert.ok(repeated.every(item => item.occurrence))
  assert.notEqual(repeated[0].occurrence?.start, repeated[1].occurrence?.start)
})

test('image capture shares existing nested source maps and never treats image alt text or code as another image', () => {
  const source = '> [![Linked][asset]](https://example.test)\r\n> `![Code][asset]`\r\n\r\n[asset]: assets/pic.png "Title"'
  const occurrences = collectMarkdownImageOccurrences(source)
  assert.equal(occurrences.length, 1)
  assert.equal(occurrences[0].source, '![Linked][asset]')
  assert.equal(source.slice(occurrences[0].start, occurrences[0].end), occurrences[0].source)
  assert.equal(occurrences[0].presentation.title, 'Title')
  assert.equal(collectMarkdownImageOccurrences('![outer ![not-image](hidden.png)](real.png)').length, 1)
})

test('identical images across relocated footnotes stay visible and cannot edit each other by source order', () => {
  const source = '[^n]: ![Same](file:///C:/assets/original.png "Title")\n\nBody ![Same](file:///C:/assets/original.png "Title") then ref[^n].'
  const occurrences = collectMarkdownImageOccurrences(source)
  assert.equal(occurrences.length, 2)
  assert.ok(occurrences[0].start < source.indexOf('Body'))
  const displays = planMarkdownImageDisplays(source)
  assert.equal(displays.length, 2)
  assert.ok(displays.every(item => !item.occurrence))
  const unique = planMarkdownImageDisplays(source.replace('Body ![Same]', 'Body ![Unique]'))
  assert.deepEqual(unique.map(item => item.presentation.alt), ['Unique', 'Same'])
  assert.equal(unique[0].occurrence?.start, source.indexOf('Body') + 5)
  assert.equal(unique[1].occurrence?.start, occurrences[0].start)
})

test('external reference definitions resolve every image occurrence without mutating the other block definitions', () => {
  const definitions = '[cover]: file:///C:/assets/original.png "External title"'
  const env: Parameters<typeof markdownEngine.parse>[1] = {}
  markdownEngine.parse(definitions, env)
  const references = structuredClone(env.references), unchanged = structuredClone(references)
  const source = '![First][cover] and ![Second][cover]'
  assert.deepEqual(collectMarkdownImageOccurrences(source), [])
  const occurrences = collectMarkdownImageOccurrences(source, references)
  assert.equal(occurrences.length, 2)
  assert.deepEqual(occurrences.map(image => image.presentation.alt), ['First', 'Second'])
  assert.equal(occurrences[1].presentation.title, 'External title')
  const replacement = { ...occurrences[1].presentation, width: 320, caption: 'Only second', align: 'right' as const }
  assert.equal(replaceMarkdownImageOccurrence(source, occurrences[1], replacement), null)
  const changed = replaceMarkdownImageOccurrence(source, occurrences[1], replacement, references)!
  assert.ok(changed.startsWith('![First][cover] and <figure'))
  const after = collectMarkdownImageOccurrences(changed, references)
  assert.equal(after.length, 2)
  assert.equal(after[0].source, occurrences[0].source)
  assert.equal(after[0].presentation.caption, '')
  assert.equal(after[1].presentation.caption, 'Only second')
  assert.deepEqual(references, unchanged)
  assert.equal(definitions, '[cover]: file:///C:/assets/original.png "External title"')
  const updated = { ...references, COVER: { href: 'assets/new.png', title: 'External title' } }
  assert.equal(replaceMarkdownImageOccurrence(source, occurrences[1], replacement, updated), null)
})

test('crop CSS uses an independent viewport and original image with responsive alignment', () => {
  const original = image({ width: 400, height: 200, align: 'right', crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.5 } })
  const unchanged = structuredClone(original)
  const layout = computeImageCropLayout(original, 1600, 1200)!
  assert.equal(layout.width, 400)
  assert.equal(layout.height, 300)
  assert.equal(layout.aspectRatio, 4 / 3)
  assert.deepEqual(layout.frameStyle, { width: '400px', maxWidth: '100%', aspectRatio: String(4 / 3), position: 'relative', overflow: 'hidden', marginLeft: 'auto', marginRight: '0' })
  assert.deepEqual(layout.imageStyle, { position: 'absolute', left: '-50%', top: '-20%', width: '200%', height: '200%', maxWidth: 'none', maxHeight: 'none', display: 'block' })
  assert.equal(computeImageCropLayout(image({ height: 150 }), 800, 600)?.width, 200)
  assert.equal(computeImageCropLayout(image(), 0, 600), null)
  assert.equal(computeImageCropLayout(image(), Infinity, 600), null)
  assert.deepEqual(original, unchanged)
  assert.equal(original.src, 'file:///C:/assets/original.png')
})

test('the real Markdown figure parser renders safe block HTML and retains media through three plain and backup cycles', () => {
  const media = image({ width: 480, height: 320, crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 }, caption: '独立 & < > 图注，![literal](hidden.png)' })
  let source = serializeImageFigure(media)
  for (let cycle = 0; cycle < 3; cycle++) {
    const tokens = markdownEngine.parse(source, {})
    assert.equal(tokens[0].type, 'html_figure_open')
    assert.equal(tokens[0].tag, 'figure')
    assert.deepEqual(tokens[0].map, [0, 1])
    assert.deepEqual(tokens[0].meta?.imagePresentation, media)
    const tree = JSDOM.fragment(markdownEngine.render(source))
    assert.equal(tree.querySelectorAll('figure').length, 1)
    assert.equal(tree.querySelectorAll('p > figure').length, 0)
    assert.equal(tree.querySelector('figcaption')?.textContent, media.caption)
    assert.equal(tree.querySelector('img')?.getAttribute('alt'), media.alt)
    const parsed = parseMarkdownBlocks(source)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].type, 'html')
    assert.equal(parsed[0].content, source)
    const withMetadata = [{ ...parsed[0], id: 'persistent-image', tags: ['media-tag'], highlight: 'blue' }]
    const backup = renderMarkdownFrontmatter({ id: 'doc', path: 'Root/Media' }) + serializeBlocksToMarkdown(withMetadata, { includeBlockMetadata: true })
    const restored = parseMarkdownBackupDocument(backup)
    assert.equal(restored.isKnowbookBackup, true)
    assert.deepEqual(restored.blocks, [{ ...withMetadata[0], parentBlockId: null }])
    assert.deepEqual(parseImageFigure(restored.blocks[0].content), media)
    source = serializeBlocksToMarkdown(parsed)
    assert.equal(collectMarkdownDestinations(source).filter(link => link.kind === 'image').length, 1)
  }
})

test('blockquotes and list containers retain exact multiline figure and image destination ranges', () => {
  const media = image({ width: 360, crop: { x: 0.25, y: 0, width: 0.5, height: 1 } })
  const multiline = serializeImageFigure(media).replace('><img', '>\n<img').replace('><figcaption', '>\n<figcaption').replace('</figcaption></figure>', '</figcaption>\n</figure>')
  for (const source of ['> ' + multiline.replace(/\n/g, '\n> '), '- Parent\n\n  ' + multiline.replace(/\n/g, '\n  '),
    '<details><summary>Media</summary>\n\n' + multiline + '\n\n</details>']) {
    const normalized = source.replace(/\n/g, '\r\n'), links = collectMarkdownDestinations(normalized)
    assert.equal(links.length, 1)
    assert.equal(links[0].kind, 'image')
    assert.equal(normalized.slice(links[0].start, links[0].end), media.src)
    const occurrences = collectMarkdownImageOccurrences(normalized)
    assert.equal(occurrences.length, 1)
    assert.deepEqual(occurrences[0].presentation, media)
    assert.equal(normalized.slice(occurrences[0].start, occurrences[0].end), occurrences[0].source)
    assert.ok(occurrences[0].source.startsWith('<figure') && occurrences[0].source.endsWith('</figure>'))
    const portable = rewriteMarkdownDestinations(normalized, link => link.kind === 'image' ? 'assets/新 图片 & 原图.png' : null)
    assert.deepEqual(collectMarkdownImageOccurrences(portable)[0].presentation, { ...media, src: 'assets/新 图片 & 原图.png' })
    const tree = JSDOM.fragment(markdownEngine.render(portable))
    assert.equal(tree.querySelectorAll('figure img').length, 1)
    assert.equal(tree.querySelector('figcaption')?.textContent, media.caption)
  }
})

test('figure sanitizer never reflects unsafe attributes and inline figures use a valid phrasing wrapper', () => {
  const source = serializeImageFigure(image()).replace('<figure ', '<figure style="position:fixed" onclick="evil()" data-block-id="stolen" ')
    .replace('<img ', '<img onerror="evil()" srcset="https://bad.test/a 2x" ')
    .replace('<figcaption>', '<figcaption style="color:red" onmouseover="evil()">')
  const tree = JSDOM.fragment(markdownEngine.render(source))
  assert.equal(tree.querySelectorAll('figure img').length, 1)
  assert.equal(tree.querySelectorAll('[style], [onclick], [onerror], [onmouseover], [srcset], [data-block-id]').length, 0)
  const inline = JSDOM.fragment(markdownEngine.render('Before ' + serializeImageFigure(image()) + ' After'))
  assert.equal(inline.querySelectorAll('figure, figcaption').length, 0)
  assert.equal(inline.querySelectorAll('p span img').length, 1)
  assert.ok(inline.textContent?.includes('Before') && inline.textContent.includes('After') && inline.textContent.includes('独立图注'))
  for (const malformed of ['<figure><img src="safe.png"><figcaption>Lost', '<figure><img src="javascript:bad"><figcaption>Keep</figcaption></figure>']) {
    const unsafe = JSDOM.fragment(markdownEngine.render(malformed))
    assert.equal(unsafe.querySelectorAll('figure, [src^="javascript:"]').length, 0)
    assert.ok(unsafe.textContent?.includes('Lost') || unsafe.textContent?.includes('Keep'))
  }
})

test('HTML clipboard preserves canonical media presentation while discarding foreign identity and unsafe attributes', () => {
  const media = image({ alt: '屏幕阅读说明', caption: '可见图注 " & 中文', width: 500, height: 300, align: 'right', crop: { x: 0.1, y: 0, width: 0.8, height: 1 } })
  const source = serializeImageFigure(media).replace('<figure ', '<figure id="foreign" data-block-id="foreign" style="position:fixed" onclick="evil()" ')
    .replace('<img ', '<img onerror="evil()" data-unknown="drop" ')
  const pasted = htmlClipboardToMarkdown(source)
  assert.deepEqual(parseImageFigure(pasted), media)
  assert.ok(!/foreign|position:fixed|onclick|onerror|data-unknown/.test(pasted))
  const unsafe = htmlClipboardToMarkdown('<figure data-knowbook-crop="0,0,9,9"><img src="javascript:bad" alt="Keep alt"><figcaption>Keep caption</figcaption><script>evil()</script></figure>')
  assert.ok(unsafe.includes('Keep alt') && unsafe.includes('Keep caption'))
  assert.ok(!/javascript:|evil\(\)|data-knowbook-crop/.test(unsafe))
})
