import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { BlockEditorRow } = await import('../src/renderer/src/components/BlockEditorRow')
await import('../src/renderer/src/components/MarkdownFormatToolbar')
type RowProps = import('../src/renderer/src/components/BlockEditorRow').BlockEditorRowProps

const headingCommand = {
  id: 'h1', label: 'Heading 1', description: 'Large heading', keywords: ['h1', 'heading'],
  kind: 'type' as const, type: 'heading-1' as const
}
type BodyAction = { name: string; args: unknown[] }
type Result = { prevented: boolean; forwarded: string[]; bodyActions: BodyAction[]; applied: unknown[]; dismissed: number }
type Harness = {
  input: HTMLTextAreaElement
  render: (patch: Partial<RowProps>) => Promise<void>
  reset: () => void
  key: (key: string, options?: KeyboardEventInit) => Promise<Result>
  composition: (type: 'compositionstart' | 'compositionend') => Promise<void>
  slashIndices: number[]
}

async function withRow(run: (api: Harness) => Promise<void>, initial: Partial<RowProps> = {}) {
  const dom = new JSDOM('<div id="boundary"><div id="mount"></div></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {},
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const bodyActions: BodyAction[] = []
  const forwarded: string[] = []
  const applied: unknown[] = []
  const slashIndices: number[] = []
  let dismissed = 0
  let selectedSlashIndex = 0
  const record = (name: string) => (...args: unknown[]) => { bodyActions.push({ name, args }) }
  const noop = () => {}
  const block: DocumentBlockDraft = { id: 'slash-host', type: 'paragraph', content: '/h1', checked: false, depth: 0 }
  let props: RowProps = {
    block, index: 0, draftBlockCount: 1, getDraftBlocks: () => [block],
    selectedDocument: { id: 'slash-document', title: 'Slash keyboard' },
    isSelected: false, isHighlighted: false, hasChildren: false, dropPreview: null,
    indentPx: 0, numberLabel: '', activeBlockIndex: 0, collapsedBlockIds: new Set(),
    activeSlashContext: { query: 'h1' }, filteredSlashCommands: [], activeSlashCommand: null,
    slashCommandsUnavailable: true,
    selectedBlockRange: null, selectedBlockCount: 0, blockTextareaRefs: { current: [] },
    updateDraftBlock: record('updateDraftBlock'), checkpointDraft: record('checkpointDraft'),
    updateBlockHighlight: record('updateBlockHighlight'), insertDraftBlockAt: record('insertDraftBlockAt'),
    insertChildDraftBlock: record('insertChildDraftBlock'), handleBlockContentChange: record('handleBlockContentChange'),
    navigateInlineReferenceAtCursor: record('navigateInlineReferenceAtCursor'), captureBlockCursor: noop,
    handleBlockPaste: () => false, beginBlockDrag: noop, endBlockDrag: noop,
    getDraggedBlockDepthPreview: () => null, dropBlockAt: record('dropBlockAt'),
    setDragOverBlockIndex: noop, setDragOverBlockDepth: noop,
    moveSelectedBlocks: record('moveSelectedBlocks'), moveDraftBlockBySibling: record('moveDraftBlockBySibling'),
    setSelectedSlashCommandIndex: update => {
      selectedSlashIndex = update(selectedSlashIndex)
      slashIndices.push(selectedSlashIndex)
    },
    applySlashCommand: command => { applied.push(command) }, dismissSlashCommand: () => { dismissed++ },
    adjustSelectedBlocksDepth: record('adjustSelectedBlocksDepth'), adjustBlockDepth: record('adjustBlockDepth'),
    deleteSelectedBlocks: record('deleteSelectedBlocks'), duplicateSelectedBlocks: record('duplicateSelectedBlocks'),
    duplicateDraftBlock: record('duplicateDraftBlock'), selectBlockRange: record('selectBlockRange'),
    selectAllBlocks: record('selectAllBlocks'), notifyBlockMouseDown: noop, handleBlockMouseEnter: noop,
    endBlockRangeSelection: noop, isBlockRangeSelecting: false,
    continueBlockAt: record('continueBlockAt'), downgradeBlockAt: record('downgradeBlockAt'),
    mergeWithPreviousBlock: record('mergeWithPreviousBlock'), splitDraftBlock: record('splitDraftBlock'),
    toggleBlockCollapse: record('toggleBlockCollapse'), isSelectionCoherent: () => true,
    getVisibleBlockCountInRange: () => 0, getMultiBlockOperationRange: range => range,
    removeSelectedBlockRange: record('removeSelectedBlockRange'), canMoveSelectedRange: () => false,
    onOpenSelectionAiEditor: record('onOpenSelectionAiEditor'),
    BLOCK_INDENT_SIZE: 24, ui: getUiText('en-US'), isZh: false,
    ...initial
  }
  const reset = () => {
    bodyActions.length = 0; forwarded.length = 0; applied.length = 0; slashIndices.length = 0; dismissed = 0
  }
  // This listener is above React's delegation root, so receiving the event proves
  // that the row allowed it to escape to document-level editor shortcuts.
  dom.window.document.getElementById('boundary')!.addEventListener('keydown', event => {
    forwarded.push((event as KeyboardEvent).key)
  })
  try {
    await act(async () => root.render(createElement(BlockEditorRow, props)))
    const input = dom.window.document.querySelector('textarea')!
    await act(async () => { input.focus(); input.setSelectionRange(block.content.length, block.content.length) })
    reset()
    await run({
      input, reset, slashIndices,
      render: async patch => {
        props = { ...props, ...patch }
        await act(async () => root.render(createElement(BlockEditorRow, props)))
      },
      key: async (key, options = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
        await act(async () => input.dispatchEvent(event))
        return { prevented: event.defaultPrevented, forwarded: [...forwarded], bodyActions: [...bodyActions],
          applied: [...applied], dismissed }
      },
      composition: async type => {
        await act(async () => input.dispatchEvent(new dom.window.CompositionEvent(type, { bubbles: true, data: '' })))
      }
    })
  } finally {
    await act(async () => root.unmount())
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

test('unavailable Slash commands own Enter, Tab and both arrows without editing the document or bubbling', async () => {
  await withRow(async api => {
    for (const key of ['Enter', 'Tab', 'ArrowUp', 'ArrowDown']) {
      api.reset()
      const result = await api.key(key)
      assert.deepEqual(result, { prevented: true, forwarded: [], bodyActions: [], applied: [], dismissed: 0 }, key)
      assert.equal(api.input.value, '/h1', key)
      assert.deepEqual(api.slashIndices, key.startsWith('Arrow') ? [0] : [], key)
    }
  })
})

test('Escape dismisses an unavailable Slash menu and stays inside its editor', async () => {
  await withRow(async api => {
    assert.deepEqual(await api.key('Escape'), {
      prevented: true, forwarded: [], bodyActions: [], applied: [], dismissed: 1
    })
  })
})

test('a failed catalog retries once on Enter while Tab and arrows only consume their own events', async () => {
  let retries = 0
  await withRow(async api => {
    for (const key of ['Tab', 'ArrowUp', 'ArrowDown']) {
      api.reset()
      assert.deepEqual(await api.key(key), {
        prevented: true, forwarded: [], bodyActions: [], applied: [], dismissed: 0
      }, key)
      assert.equal(retries, 0, key)
    }
    api.reset()
    assert.deepEqual(await api.key('Enter'), {
      prevented: true, forwarded: [], bodyActions: [], applied: [], dismissed: 0
    })
    assert.equal(retries, 1)
    assert.equal(api.input.value, '/h1')
    // Once the retry is loading, another Enter is consumed without queueing a
    // second request or editing the paragraph in anticipation of a result.
    await api.render({ retrySlashCommands: undefined })
    api.reset()
    assert.deepEqual(await api.key('Enter'), {
      prevented: true, forwarded: [], bodyActions: [], applied: [], dismissed: 0
    })
    assert.equal(retries, 1)
  }, { retrySlashCommands: () => { retries++ } })
})

test('ready Slash commands apply exactly once on Enter or Tab without continuing or indenting text', async () => {
  await withRow(async api => {
    for (const key of ['Enter', 'Tab']) {
      api.reset()
      assert.deepEqual(await api.key(key), {
        prevented: true, forwarded: [], bodyActions: [], applied: [headingCommand], dismissed: 0
      }, key)
    }
  }, { slashCommandsUnavailable: false, activeSlashCommand: headingCommand, filteredSlashCommands: [headingCommand] })
})

test('an immediate Enter is consumed while loading and a later Enter applies the newly ready command', async () => {
  await withRow(async api => {
    assert.deepEqual(await api.key('Enter'), {
      prevented: true, forwarded: [], bodyActions: [], applied: [], dismissed: 0
    })
    await api.render({ slashCommandsUnavailable: false, activeSlashCommand: headingCommand,
      filteredSlashCommands: [headingCommand] })
    api.reset()
    assert.deepEqual(await api.key('Enter'), {
      prevented: true, forwarded: [], bodyActions: [], applied: [headingCommand], dismissed: 0
    })
    assert.equal(api.input.value, '/h1')
  })
})

test('IME candidates retain native Enter and navigation before and after the Slash catalog becomes ready', async () => {
  await withRow(async api => {
    for (const ready of [false, true]) {
      await api.render({ slashCommandsUnavailable: !ready, activeSlashCommand: ready ? headingCommand : null,
        filteredSlashCommands: ready ? [headingCommand] : [] })
      for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
        for (const key of ['Enter', 'Tab', 'ArrowUp', 'ArrowDown']) {
          api.reset()
          assert.deepEqual(await api.key(key, options), {
            prevented: false, forwarded: [], bodyActions: [], applied: [], dismissed: 0
          }, `${ready ? 'ready' : 'unavailable'} ${key} ${JSON.stringify(options)}`)
        }
      }
      await api.composition('compositionstart')
      api.reset()
      assert.deepEqual(await api.key('Enter'), {
        prevented: false, forwarded: [], bodyActions: [], applied: [], dismissed: 0
      }, 'the composition session also protects an Enter whose browser flag is false')
      await api.composition('compositionend')
    }
  })
})

test('Slash loading and ready states preserve the existing modifier key behavior', async () => {
  await withRow(async api => {
    // Keep arrows inside the text so native Shift selection is comparable too.
    api.input.setSelectionRange(1, 1)
    for (const options of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      for (const key of ['Enter', 'Tab', 'ArrowUp', 'ArrowDown']) {
        await api.render({ activeSlashContext: null, slashCommandsUnavailable: false, activeSlashCommand: null,
          filteredSlashCommands: [] })
        api.reset()
        const baseline = await api.key(key, options)
        for (const ready of [false, true]) {
          await api.render({ activeSlashContext: { query: 'h1' }, slashCommandsUnavailable: !ready,
            activeSlashCommand: ready ? headingCommand : null, filteredSlashCommands: ready ? [headingCommand] : [] })
          api.reset()
          assert.deepEqual(await api.key(key, options), baseline,
            `${ready ? 'ready' : 'unavailable'} ${key} ${JSON.stringify(options)}`)
        }
      }
    }
  })
})

test('a ready catalog with no matching command keeps the normal paragraph Enter behavior', async () => {
  await withRow(async api => {
    const result = await api.key('Enter')
    assert.equal(result.prevented, true)
    assert.deepEqual(result.applied, [])
    assert.equal(result.dismissed, 0)
    assert.deepEqual(result.bodyActions, [{ name: 'splitDraftBlock', args: [0, 3, 3] }])
  }, { slashCommandsUnavailable: false })
})
