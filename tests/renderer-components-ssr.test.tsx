import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlockTagFilterPanel } from '../src/renderer/src/components/BlockTagFilterPanel.tsx'
import { CodeBlockLanguageSelector } from '../src/renderer/src/components/CodeBlockLanguageSelector.tsx'
import { DocumentOutlinePanel } from '../src/renderer/src/components/DocumentOutlinePanel.tsx'
import { DocumentStatsBar } from '../src/renderer/src/components/DocumentStatsBar.tsx'
import { DocumentSummaryCard } from '../src/renderer/src/components/DocumentSummaryCard.tsx'

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

test('DocumentSummaryCard SSR renders path, labels, and current values', () => {
  const html = renderToStaticMarkup(
    <DocumentSummaryCard
      path="Home/Product"
      title="Product"
      summary="Summary text"
      updatedText="Updated now"
      titleLabel="Title"
      summaryLabel="Summary"
      onTitleChange={() => undefined}
      onSummaryChange={() => undefined}
    />
  )

  assert.equal(html.includes('Home/Product'), true)
  assert.equal(html.includes('Title'), true)
  assert.equal(html.includes('Summary'), true)
  assert.equal(html.includes('Updated now'), true)
  assert.equal(html.includes('value="Product"'), true)
  assert.equal(html.includes('Summary text'), true)
})

test('BlockTagFilterPanel SSR returns empty output without tags', () => {
  const html = renderToStaticMarkup(
    <BlockTagFilterPanel
      title="Tags"
      clearLabel="Clear"
      showingLabel="Showing"
      totalCount={10}
      filteredCount={3}
      allTags={[]}
      selectedTags={new Set<string>()}
      tagCounts={new Map<string, number>()}
      onClear={() => undefined}
      onToggleTag={() => undefined}
    />
  )

  assert.equal(html, '')
})

test('BlockTagFilterPanel SSR shows clear button and selected summary when active', () => {
  const html = renderToStaticMarkup(
    <BlockTagFilterPanel
      title="Tags"
      clearLabel="Clear"
      showingLabel="Showing"
      totalCount={10}
      filteredCount={3}
      allTags={['AI', 'UX']}
      selectedTags={new Set<string>(['AI'])}
      tagCounts={new Map<string, number>([['AI', 2], ['UX', 1]])}
      onClear={() => undefined}
      onToggleTag={() => undefined}
    />
  )

  assert.equal(html.includes('Clear'), true)
  assert.equal(html.includes('AI'), true)
  assert.equal(html.includes('UX'), true)
  assert.equal(html.includes('Showing 3 / 10'), true)
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
