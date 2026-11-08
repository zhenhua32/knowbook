import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expectHostReferencesUnchanged, inlineInstance, openInlineHost, withCanonicalInlineApp } from './helpers/canonical-inline'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { expectSource, measureNextFrame, selectSource, sourceValue } from './helpers/markdown-source'

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before running this acceptance slice')

test('a 4000-block synced source meets frame budgets and survives a real save and restart @electron', async ({}, info) => {
  test.setTimeout(240_000)
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, { page } = fixture.context(), host = seed.hosts[1], instanceId = seed.instanceIds[2]
    const input = { hostDocumentId: host.id, instanceId, groupId: seed.groupId }
    const read = () => page.evaluate(async value => {
      const result = await window.knowbook.resolveSyncedInlineInstance(value)
      return result.status === 'ready' ? result.snapshot.blocks : null
    }, input)
    const baseline = await read()
    expect(baseline).toHaveLength(4000)
    await openInlineHost(page, host)
    const open = inlineInstance(page, instanceId).getByRole('button', { name: uiText('Edit source', '编辑源码'), exact: true })
    await measureNextFrame(open, 'click', 'source-open-frame')
    await open.click()
    const editor = page.getByRole('textbox', { name: uiText('Shared body Markdown source', '共享正文 Markdown 源码'), exact: true })
    await expect(editor).toBeFocused()
    const initial = await sourceValue(editor)
    const suffix = ' 中文🙂'
    const edited = new Map([0, 2000, 3999].map(index => [index, baseline![index].content + suffix]))
    const entries = (name: string) => page.evaluate(value => performance.getEntriesByName(value).map(entry => entry.duration), name)
    for (const [index, after] of edited) {
      const before = baseline![index].content, source = await sourceValue(editor), offset = source.indexOf(before)
      expect(offset).toBeGreaterThanOrEqual(0)
      await selectSource(editor, offset + before.length)
      await measureNextFrame(editor, 'input', 'source-input-frame')
      await page.keyboard.insertText(suffix)
      expect(await sourceValue(editor)).toContain(after)
    }
    await expectSource(editor, [...edited].reduce((source, [index, after]) => source.replace(baseline![index].content, after), initial))

    await editor.press('Control+a')
    await measureNextFrame(editor, 'keydown', 'source-format-frame')
    await editor.press('Control+b')
    expect(await sourceValue(editor)).toContain(`**${edited.get(0)}**`)
    expect(await editor.locator('.cm-line').count()).toBeLessThan(150)
    const apply = page.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true })
    await measureNextFrame(apply, 'click', 'source-apply-frame')
    const applyStarted = performance.now()
    await apply.click({ noWaitAfter: true })
    await expect(editor).toHaveCount(0)
    await expect.poll(async () => (await read())?.[0].content, { timeout: 30_000 }).toBe(`**${edited.get(0)}**`)
    const applyAndReadBackMs = performance.now() - applyStarted
    const saved = (await read())!
    expect(saved.map(({ id, createdAt }) => [id, createdAt])).toEqual(baseline!.map(({ id, createdAt }) => [id, createdAt]))
    for (const [index, after] of edited) expect(saved[index].content).toBe(`**${after.trimEnd()}**`)
    await expectHostReferencesUnchanged(page, seed)

    const metrics = []
    for (const [name, sampleCount, ceilingMs] of [
      ['source-open-frame', 1, 3000], ['source-input-frame', 3, 500], ['source-format-frame', 1, 1500], ['source-apply-frame', 1, 8000]
    ] as const) {
      await expect.poll(async () => (await entries(name)).length).toBe(sampleCount)
      const samples = (await entries(name)).toSorted((a, b) => a - b)
      metrics.push({ name, samples, p95Ms: samples[Math.ceil(samples.length * 0.95) - 1], ceilingMs })
    }
    const reportPath = info.outputPath('synced-source-frame-4000.json')
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, JSON.stringify({ metrics, applyAndReadBackMs }, null, 2) + '\n')
    await info.attach('synced-source-frame-4000', { path: reportPath, contentType: 'application/json' })
    for (const metric of metrics) expect(metric.p95Ms, metric.name).toBeLessThan(metric.ceilingMs)

    await fixture.restart()
    const reopened = fixture.context().page
    await openInlineHost(reopened, seed.hosts[0])
    const restored = await reopened.evaluate(async value => {
      const result = await window.knowbook.resolveSyncedInlineInstance(value)
      return result.status === 'ready' ? result.snapshot.blocks : null
    }, { ...input, hostDocumentId: seed.hosts[0].id, instanceId: seed.instanceIds[0] })
    expect(restored).toEqual(saved)
    await expectHostReferencesUnchanged(reopened, seed)
  }, 4000)
})
