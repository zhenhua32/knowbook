import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlockEditToolbar } from '../src/renderer/src/components/BlockEditToolbar.tsx'
import { BlockRichMediaPreview } from '../src/renderer/src/components/BlockRichMediaPreview.tsx'
import { CodeBlockLanguageSelector } from '../src/renderer/src/components/CodeBlockLanguageSelector.tsx'
import { DocumentOutlinePanel } from '../src/renderer/src/components/DocumentOutlinePanel.tsx'
import { DocumentStatsBar } from '../src/renderer/src/components/DocumentStatsBar.tsx'
import { DocumentSummaryCard } from '../src/renderer/src/components/DocumentSummaryCard.tsx'
import { PageRail } from '../src/renderer/src/components/PageRail.tsx'

test('DocumentStatsBar SSR hides optional counters when zero', () => {
  const html = renderToStaticMarkup(
    <DocumentStatsBar
      blockCount={10}
      wordCount={100}
      charCount={500}
      codeBlockCount={0}
      todoCount={0}
      blocksLabel="blocks"
      wordsLabel="words"
      charsLabel="chars"
      codeBlocksLabel="code"
      todosLabel="todos"
    />
  )

  assert.equal(html.includes('10</strong> blocks'), true)
  assert.equal(html.includes('100</strong> words'), true)
  assert.equal(html.includes('500</strong> chars'), true)
  assert.equal(html.includes('code</span>'), false)
  assert.equal(html.includes('todos</span>'), false)
})

test('DocumentStatsBar SSR shows optional counters when non-zero', () => {
  const html = renderToStaticMarkup(
    <DocumentStatsBar
      blockCount={10}
      wordCount={100}
      charCount={500}
      codeBlockCount={2}
      todoCount={3}
      blocksLabel="blocks"
      wordsLabel="words"
      charsLabel="chars"
      codeBlocksLabel="code"
      todosLabel="todos"
    />
  )

  assert.equal(html.includes('2</strong> code'), true)
  assert.equal(html.includes('3</strong> todos'), true)
})

test('DocumentSummaryCard SSR renders compact metadata before editing', () => {
  const html = renderToStaticMarkup(
    <DocumentSummaryCard
      path="Home/Product"
      title="Product"
      summary="Summary text"
      updatedText="Updated now"
      titleLabel="Title"
      summaryLabel="Summary"
      editLabel="Edit properties"
      collapseLabel="Collapse properties"
      onTitleChange={() => undefined}
      onSummaryChange={() => undefined}
    />
  )

  assert.equal(html.includes('Home/Product'), true)
  assert.equal(html.includes('Title'), false)
  assert.equal(html.includes('Summary'), true)
  assert.equal(html.includes('Updated now'), true)
  assert.equal(html.includes('Edit properties'), true)
  assert.equal(html.includes('value="Product"'), false)
  assert.equal(html.includes('Summary text'), true)
})

test('BlockEditToolbar SSR renders manual highlight controls when enabled', () => {
  const html = renderToStaticMarkup(
    <BlockEditToolbar
      block={{ type: 'paragraph', content: 'Hello', checked: false, depth: 0, highlight: 'yellow' }}
      index={0}
      isActive={true}
      onDelete={() => undefined}
      onDuplicate={() => undefined}
      onHighlightChange={() => undefined}
      onTypeChange={() => undefined}
      typeOptions={{
        paragraph: 'Paragraph',
        'heading-1': 'Heading 1',
        'heading-2': 'Heading 2',
        todo: 'Todo',
        code: 'Code',
        math: 'Math',
        quote: 'Quote',
        'bulleted-list': 'Bulleted list',
        'numbered-list': 'Numbered list',
        divider: 'Divider'
      }}
      ui={{ noHighlight: 'No highlight' }}
      isZh={false}
    />
  )

  assert.equal(html.includes('No highlight'), true)
  assert.equal(html.includes('Block highlight'), true)
  assert.equal(html.includes('highlight-swatch'), true)
})

test('DocumentOutlinePanel SSR uses empty heading fallback labels', () => {
  const html = renderToStaticMarkup(
    <DocumentOutlinePanel
      title="Outline"
      items={[
        { index: 0, level: 1, title: '' },
        { index: 1, level: 2, title: '' }
      ]}
      emptyHeadingTitleLevel1="Untitled H1"
      emptyHeadingTitleLevel2="Untitled H2"
      onSelect={() => undefined}
    />
  )

  assert.equal(html.includes('Outline'), true)
  assert.equal(html.includes('Untitled H1'), true)
  assert.equal(html.includes('Untitled H2'), true)
})

test('DocumentOutlinePanel SSR nests level 2 headings under the preceding level 1 heading', () => {
  const html = renderToStaticMarkup(
    <DocumentOutlinePanel
      title="Outline"
      items={[
        { index: 0, level: 1, title: 'Introduction' },
        { index: 1, level: 2, title: 'Context' },
        { index: 2, level: 2, title: 'Goals' },
        { index: 3, level: 1, title: 'Implementation' }
      ]}
      emptyHeadingTitleLevel1="Untitled H1"
      emptyHeadingTitleLevel2="Untitled H2"
      onSelect={() => undefined}
    />
  )

  assert.match(
    html,
    /toc-entry-h1[^]*Introduction[^]*toc-children[^]*Context[^]*Goals[^]*<\/ol><\/li><li class="toc-entry toc-entry-h1"[^]*Implementation/
  )
  assert.equal((html.match(/class="toc-children"/g) ?? []).length, 1)
})

test('CodeBlockLanguageSelector SSR exposes current language and localized placeholder', () => {
  const zh = renderToStaticMarkup(
    <CodeBlockLanguageSelector
      currentLanguage="python"
      onChange={() => undefined}
      onBlur={() => undefined}
      isZh={true}
    />
  )
  const en = renderToStaticMarkup(
    <CodeBlockLanguageSelector
      currentLanguage={undefined}
      onChange={() => undefined}
      onBlur={() => undefined}
      isZh={false}
    />
  )

  assert.equal(zh.includes('value="python"'), true)
  assert.equal(zh.includes('无（自动检测）'), true)
  assert.equal(en.includes('None (auto-detect)'), true)
  assert.equal(en.includes('javascript'), true)
  assert.equal(en.includes('typescript'), true)
})

test('BlockRichMediaPreview SSR renders compact accessible image and link cards', () => {
  const html = renderToStaticMarkup(
    <BlockRichMediaPreview
      content={[
        '![Cover](https://example.com/cover.png)',
        'Source URL: https://example.com/article'
      ].join('\n')}
      ui={{
        blockPreviewImagesLabel: 'Image previews',
        blockPreviewImageUnavailable: 'Image preview unavailable',
        blockPreviewOpenImage: 'Open original image',
        blockPreviewLinksLabel: 'Link previews',
        openExternalLink: 'Open'
      }}
    />
  )

  assert.equal(html.includes('block-rich-media-image-card'), true)
  assert.equal(html.includes('Open original image: Cover'), true)
  assert.equal(html.includes('block-rich-media-link-copy'), true)
  assert.equal(html.includes('example.com/article'), true)
  assert.equal(html.includes('tabindex="-1"'), false)
})

test('PageRail SSR renders labeled SVG navigation without emoji icons', () => {
  const html = renderToStaticMarkup(
    <PageRail
      activePage="documents"
      brandEyebrow="Local workspace"
      collapseTitle="Collapse"
      currentPageHint=""
      currentPageLabel="Current page"
      isCollapsed={false}
      navLabel="Navigation"
      onSelectPage={() => undefined}
      onToggleCollapse={() => undefined}
      pageDescription="Tree and editor"
      pageItems={[
        { id: 'documents', label: 'Documents', description: 'Tree and editor' },
        { id: 'settings', label: 'Settings', description: 'Preferences' }
      ]}
      pageTitle="Documents"
    />
  )

  assert.equal(html.includes('aria-label="Navigation"'), true)
  assert.equal(html.includes('nav-icon-svg'), true)
  assert.equal(html.includes('Documents'), true)
  assert.equal(html.includes('📂'), false)
  assert.equal(html.includes('⚙️'), false)
})
