import { expect, test, type Locator, type Page } from '@playwright/test'
import { openInlineHost, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { setRichTextDomSelection } from './helpers/rich-text-selection'
import { parseSyncedBlockPayload } from '../src/shared/syncedBlockValidation'

type Point = { blockId: string; offset: number }

async function selectRich(body: Locator, from: Point, to: Point) {
  await body.evaluate(setRichTextDomSelection, { from, to, backward: true })
  await body.page().evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

function readSelection(body: Locator) {
  return body.evaluate(root => {
    const selection = window.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) return null
    const point = (node: Node, offset: number) => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
      const row = element?.closest<HTMLElement>('.block-editor-row')
      if (!row || !root.contains(row)) return null
      const before = document.createRange()
      before.selectNodeContents(row)
      before.setEnd(node, offset)
      return { blockId: row.dataset.blockId, offset: before.toString().length }
    }
    return { anchor: point(selection.anchorNode, selection.anchorOffset), head: point(selection.focusNode, selection.focusOffset) }
  })
}

async function readHost(page: Page, id: string) {
  return page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

for (const action of ['replace', 'paste'] as const) test(`Rich ${action} across a reference commits one native reversible host operation @electron`, async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { app, page } = fixture.context(), { seed } = fixture, host = seed.hosts[0]
    await openInlineHost(page, host); await setInlineReading(page, false)
    const mode = page.getByRole('group', { name: uiText('Editing mode', '编辑模式'), exact: true })
    const markdown = mode.getByRole('button', { name: 'Markdown', exact: true })
    if (await markdown.getAttribute('aria-pressed') !== 'true') await markdown.click()
    await expect(markdown).toHaveAttribute('aria-pressed', 'true')
    const first = host.blocks[0]
    const firstText = '**lef**t remove', lastText = 'remove *right*'
    await page.locator(`[data-block-id="${first.id}"] textarea`).fill(firstText)
    await page.locator('.add-block-button').first().click()
    await expect(page.locator('.block-inline-textarea').last()).toBeEditable()
    await page.locator('.block-inline-textarea').last().fill(lastText)
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await readHost(page, host.id))?.blocks.at(-1)?.content).toBe(lastText)
    const initial = (await readHost(page, host.id))!
    const last = initial.blocks.at(-1)!
    expect(initial.blocks.map(block => block.type)).toEqual(['paragraph', 'synced-block', 'synced-block', 'paragraph'])
    await mode.getByRole('button', { name: uiText('Rich text', '富文本'), exact: true }).click()
    const body = page.locator('[data-forest-owner="document"] > div > .knowbook-rich-text-editor')
    await expect(body).toBeVisible()
    const from = { blockId: first.id, offset: 4 }, to = { blockId: last.id, offset: 7 }
    await selectRich(body, from, to)
    await expect.poll(() => readSelection(body)).toEqual({ anchor: to, head: from })
    if (action === 'paste') {
      await app.evaluate(({ clipboard }) => clipboard.writeText('PASTE'))
      await page.keyboard.press('Control+v')
    } else await page.keyboard.insertText('TYPE')
    const saved = action === 'paste' ? 'PASTE' : 'TYPE'
    await expect.poll(async () => (await readHost(page, host.id))?.blocks.map(block => block.id)).toEqual([first.id])
    await expect(body.locator(`[data-block-id="${first.id}"] strong`)).toHaveText('lef')
    await expect(body.locator(`[data-block-id="${first.id}"] em`)).toHaveText('right')
    await expect(body).toHaveText(`left${saved}right`)
    const caret = { blockId: first.id, offset: from.offset + saved.length }
    await expect.poll(() => readSelection(body)).toEqual({ anchor: caret, head: caret })
    const edited = (await readHost(page, host.id))!.blocks
    expect(edited[0].content).not.toContain(seed.primaryText)
    const result = await page.evaluate(async ({ hostId, groupId }) => {
      const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: hostId })
      if (opened.status !== 'ready') throw new Error('Main host session unavailable')
      return window.knowbook.invokeSyncedEditingSession({ sessionId: opened.session.sessionId,
        method: 'getSyncedGroupSnapshots', input: { groupIds: [groupId] } })
    }, { hostId: host.id, groupId: seed.groupId })
    const group = result.items[0]
    expect(group.status).toBe('ready')
    if (group.status !== 'ready') return
    expect(group.snapshot.instances.map(item => item.instanceId)).toEqual([seed.instanceIds[2]])
    expect(group.snapshot.blocks.find(block => block.id === seed.primaryId)?.content).toBe(seed.primaryText)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await readHost(page, host.id))?.blocks).toEqual(initial.blocks)
    await expect.poll(() => readSelection(body)).toEqual({ anchor: to, head: from })
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => (await readHost(page, host.id))?.blocks).toEqual(edited)
    await expect.poll(() => readSelection(body)).toEqual({ anchor: caret, head: caret })
  })
})

test('Rich mixed complete roots copy and cut through the actual system clipboard and paste fresh reversible references @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { app, page } = fixture.context(), { seed } = fixture, [source, destination] = seed.hosts
    const read = () => app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }))
    const mode = page.getByRole('group', { name: uiText('Editing mode', '编辑模式'), exact: true })
    const rich = mode.getByRole('button', { name: uiText('Rich text', '富文本'), exact: true })
    const body = page.locator('[data-forest-owner="document"] > div > .knowbook-rich-text-editor')
    await openInlineHost(page, source); await setInlineReading(page, false)
    if (await rich.getAttribute('aria-pressed') !== 'true') await rich.click()
    await expect(body).toBeVisible()
    const before = (await readHost(page, source.id))!, previousDestination = (await readHost(page, destination.id))!
    await body.focus()
    await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c')
    await expect.poll(async () => (await read()).text).toContain(seed.primaryText)
    const copied = await read()
    expect(copied.text).toContain(before.blocks[0].content)
    expect(copied.text.split(seed.primaryText)).toHaveLength(3)
    expect(copied.text).not.toContain(seed.groupId)
    expect(copied.html).not.toContain(seed.groupId)
    expect(copied.html).toContain('data-knowbook-synced-clipboard')
    expect((await readHost(page, source.id))?.blocks).toEqual(before.blocks)

    await openInlineHost(page, destination); await expect(body).toBeVisible()
    const target = previousDestination.blocks[0]
    const caret = { blockId: target.id, offset: target.content.length }
    await selectRich(body, caret, caret)
    await expect.poll(() => readSelection(body)).toEqual({ anchor: caret, head: caret })
    await expect(body).toBeFocused()
    await page.keyboard.press('Control+v')
    const failedCommand = page.getByRole('dialog', { name: uiText('Block edit', '正文块编辑') })
    await expect.poll(async () => await failedCommand.isVisible() ? failedCommand.getByRole('alert').textContent()
      : (await readHost(page, destination.id))?.blocks.map(block => block.type))
      .toEqual(['paragraph', 'paragraph', 'synced-block', 'synced-block', 'synced-block'])
    const pasted = (await readHost(page, destination.id))!
    expect(pasted.blocks[0]).toEqual(previousDestination.blocks[0])
    const newRefs = pasted.blocks.slice(2, 4)
    const oldIds = new Set([...before.blocks, ...previousDestination.blocks].map(block => block.id))
    expect(pasted.blocks.slice(1, 4).every(block => !oldIds.has(block.id))).toBe(true)
    expect(new Set(newRefs.map(block => block.id)).size).toBe(2)
    expect(newRefs.map(block => parseSyncedBlockPayload(block.content).groupId)).toEqual([seed.groupId, seed.groupId])
    expect(pasted.blocks.some(block => block.content.includes(seed.primaryText))).toBe(false)
    const pastedCaret = { blockId: pasted.blocks[1].id, offset: 0 }
    await expect.poll(() => readSelection(body)).toEqual({ anchor: pastedCaret, head: pastedCaret })
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await readHost(page, destination.id))?.blocks).toEqual(previousDestination.blocks)
    await expect.poll(() => readSelection(body)).toEqual({ anchor: caret, head: caret })

    await openInlineHost(page, source); await expect(body).toBeVisible(); await body.focus()
    await app.evaluate(({ clipboard }) => clipboard.writeText('Before complete Rich cut'))
    await page.keyboard.press('Control+a'); await page.keyboard.press('Control+x')
    await expect.poll(async () => (await read()).text).toBe(copied.text)
    await expect.poll(async () => (await readHost(page, source.id))?.blocks.map(block => [block.type, block.content])).toEqual([['paragraph', '']])
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await readHost(page, source.id))?.blocks).toEqual(before.blocks)
  })
})
