import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts.ts'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument.ts'
import { matchingOpeningTitleIndex } from '../src/renderer/src/utils/documentReadingTitle.ts'

function block(content: string, type = 'heading-1'): DocumentBlockDraft {
  return { type, content, checked: false, depth: 0, parentBlockId: null }
}

function openingTitle(title: string, blocks: DocumentBlockDraft[], withModel = false) {
  return matchingOpeningTitleIndex(title, blocks.map((block, index) => ({ block, index })),
    withModel ? parseMarkdownDocumentBlocks(blocks, title) : undefined)
}

test('opening reading title matches CJK spacing and separator typography from imported articles', () => {
  const title = '16 万 Star 的 OpenCode 彻底重写: API 全部重做、 Bun 换 Node、 桌面端迁移 Electron'
  const heading = '16万 Star 的 OpenCode 彻底重写：API 全部重做、Bun 换 Node、桌面端迁移 Electron'
  for (const withModel of [false, true]) {
    assert.equal(openingTitle(title, [block(heading)], withModel), 0)
    assert.equal(openingTitle('发布说明，版本：2', [block('发布说明, 版本 : 2')], withModel), 0)
    assert.equal(openingTitle('Cafe\u0301\t项目 API', [block('Café项目API')], withModel), 0)
  }
})

test('title matching retains meaningful English word boundaries, case, numbers and punctuation', () => {
  const distinctPairs = [
    ['Open Code 项目', 'OpenCode项目'],
    ['API 项目', 'api项目'],
    ['版本 16', '版本 1 6'],
    ['版本 16', '版本 17'],
    ['版本 16', '版本 １６'],
    ['发布说明: API', '发布说明 API'],
    ['发布说明, API', '发布说明、API'],
    ['API v2', 'APIv2'],
    ['南京 市长', '南京市 长'],
    ['아버지가 방에 들어가신다', '아버지 가방에 들어가신다']
  ]
  for (const withModel of [false, true]) {
    for (const [title, heading] of distinctPairs) {
      assert.equal(openingTitle(title, [block(heading)], withModel), null, `${title} / ${heading}`)
    }
    assert.equal(openingTitle(' \t ', [block('')], withModel), null)
  }
})

test('only the opening H1 qualifies, with frontmatter and empty paragraphs skipped', () => {
  for (const withModel of [false, true]) {
    assert.equal(openingTitle('项目 API', [block('项目API', 'heading-2')], withModel), null)
    assert.equal(openingTitle('项目 API', [block('另一个标题'), block('项目API')], withModel), null)
    assert.equal(openingTitle('项目 API', [block('正文', 'paragraph'), block('项目API')], withModel), null)
    assert.equal(openingTitle('项目 API', [block('title: 项目 API', 'frontmatter'), block(' \n ', 'paragraph'),
      block('**项目** API')], withModel), 2)
  }
})
