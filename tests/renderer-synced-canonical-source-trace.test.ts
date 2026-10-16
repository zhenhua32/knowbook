import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedCanonicalEdit } from '../src/shared/synced-blocks'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { parseMarkdownSourceStrictWithTrace } from '../src/shared/markdownSource'
import { projectMarkdownSourceRawRange } from '../src/shared/markdownSourceTrace'
import { createCanonicalSourceDraft, canonicalSourceDraftToBlocks } from '../src/renderer/src/features/synced-blocks/canonicalSource'
import { replaceMarkdownSourceChanges } from '../src/renderer/src/utils/markdownSourceDraft'

test('initial canonical CRLF/CR and emoji content survives no-op and an unrelated Source edit with its actual binding offsets', () => {
  const blocks: SyncedCanonicalEdit[] = [
    { id: ' 旧:🧭\0 ', type: 'paragraph', content: '🧭 [One](One.md)\r\nThen [Two](Two.md)\r\nEnd',
      checked: false, depth: 0, parentBlockId: null, tags: ['原始'], highlight: 'yellow' },
    { id: 'carriage', type: 'paragraph', content: '🙂 First\rLast', checked: false, depth: 0, parentBlockId: null, tags: [] },
    { id: 'tail', type: 'paragraph', content: 'Edit this', checked: false, depth: 0, parentBlockId: null }
  ]
  const initial = structuredClone(blocks), draft = createCanonicalSourceDraft(blocks), before = structuredClone(draft)
  assert.deepEqual(canonicalSourceDraftToBlocks(draft), blocks)
  assert.equal(draft.anchors[0].block.content, blocks[0].content, 'opening authority keeps original raw content, not serializer LF')
  assert.equal(draft.anchors[1].block.content, blocks[1].content)
  const originalLinks = collectDocumentMarkdownLinks(blocks)
  assert.deepEqual(originalLinks.map(link => [link.blockId, link.start, link.end, link.url]), [
    [blocks[0].id, blocks[0].content.indexOf('One.md'), blocks[0].content.indexOf('One.md') + 6, 'One.md'],
    [blocks[0].id, blocks[0].content.indexOf('Two.md'), blocks[0].content.indexOf('Two.md') + 6, 'Two.md']
  ])
  const at = draft.source.indexOf('Edit this')
  const edited = replaceMarkdownSourceChanges(draft, [{ from: at, to: at + 9, insert: 'Edited 尾🙂' }])
  const result = canonicalSourceDraftToBlocks(edited, () => { throw new Error('No new identity expected') })
  assert.deepEqual(result.slice(0, 2), blocks.slice(0, 2))
  assert.deepEqual(result[2], { ...blocks[2], content: 'Edited 尾🙂' })
  assert.deepEqual(collectDocumentMarkdownLinks(result), originalLinks)
  assert.deepEqual(blocks, initial); assert.deepEqual(draft, before)
  const syntax = parseMarkdownSourceStrictWithTrace(edited.source, { mode: 'canonical' })
  assert.equal(syntax.blocks[0].content, blocks[0].content.replace(/\r\n?/g, '\n'), 'emission trace addresses current source syntax, not original persisted CRLF')
  for (const word of ['One.md', 'Two.md']) {
    const rawFrom = edited.source.indexOf(word), contentFrom = syntax.blocks[0].content.indexOf(word)
    assert.deepEqual(projectMarkdownSourceRawRange(syntax.contentTraces[0], rawFrom, rawFrom + word.length),
      { from: contentFrom, to: contentFrom + word.length })
  }
})
