// Read-only instrumentation for manually/native-operated, isolated desktop apps.
// This tool never launches an application, sends input, or changes its documents.
import { chromium } from 'playwright'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import os from 'node:os'
import { parseArgs } from 'node:util'

const hash = value => createHash('sha256').update(value).digest('hex')
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  help: { type: 'boolean' }, app: { type: 'string' }, endpoint: { type: 'string' },
  fixtures: { type: 'string' }, output: { type: 'string' }, blocks: { type: 'string' },
  mode: { type: 'string' }, 'launch-flags': { type: 'string' }
} })
if (values.help) {
  console.log('Prepare: node --import tsx scripts/markdown-native-input.mjs prepare <new-directory>\nCollect: node scripts/markdown-native-input.mjs collect --app <name> --endpoint <loopback-CDP-URL> --fixtures <directory> --output <new-report.json> --blocks <800|4000> --mode <description> --launch-flags <actual-flags>')
} else if (positionals[0] === 'prepare') {
  if (!positionals[1]) throw new Error('Expected a new fixture directory')
  const directory = resolve(positionals[1])
  if (existsSync(directory)) throw new Error('Refusing to replace an existing fixture directory')
  const { sourceEditingBlocks } = await import('../tests/fixtures/markdown-source-performance.ts')
  const { createMarkdownSourceDraft } = await import('../src/renderer/src/utils/markdownSourceDraft.ts')
  mkdirSync(directory, { recursive: true })
  const inputs = [800, 4000].map(blocks => {
    const source = createMarkdownSourceDraft(sourceEditingBlocks(blocks)).source
    writeFileSync(resolve(directory, `Source-${blocks}.md`), source)
    return { blocks, characters: source.length, sha256: hash(source) }
  })
  writeFileSync(resolve(directory, 'fixtures.json'), JSON.stringify(inputs, null, 2) + '\n')
  console.log(JSON.stringify(inputs, null, 2))
} else if (positionals[0] === 'collect') {
  for (const name of ['app', 'endpoint', 'fixtures', 'output', 'blocks', 'mode', 'launch-flags']) {
    if (!values[name]) throw new Error(`Missing --${name}`)
  }
  const endpoint = new URL(values.endpoint)
  if (endpoint.hostname !== '127.0.0.1' || !['http:', 'ws:'].includes(endpoint.protocol)) {
    throw new Error('Expected the isolated application’s own loopback CDP endpoint')
  }
  const blocks = Number(values.blocks), output = resolve(values.output)
  if (![800, 4000].includes(blocks)) throw new Error('Expected 800 or 4000 blocks')
  if (existsSync(output)) throw new Error('Refusing to replace an existing report')
  const fixture = readFileSync(resolve(values.fixtures, `Source-${blocks}.md`), 'utf8')
  mkdirSync(dirname(output), { recursive: true })
  const browser = await chromium.connectOverCDP(values.endpoint)
  const callbackName = `recordNativeMarkdownFrame_${randomUUID().replaceAll('-', '')}`
  const cleanupName = `${callbackName}_cleanup`
  let selected, timeout, finish, fail
  const complete = new Promise((resolve, reject) => { finish = resolve; fail = reject })
  try {
    const deadline = Date.now() + 120000
    while (!selected && Date.now() < deadline) {
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        for (const frame of page.frames()) {
          const probe = await frame.evaluate(() => {
            const cm6 = document.querySelector('.cm-content'), cm5 = document.querySelector('.CodeMirror')
            const view = cm6?.cmTile?.root?.view ?? cm6?.cmView?.view
            if (!(cm6 ?? cm5)?.getBoundingClientRect().height) return null
            if (globalThis.app?.workspace?.activeEditor?.editor) return { reader: 'obsidian', source: globalThis.app.workspace.activeEditor.editor.getValue() }
            if (view?.state?.doc) return { reader: 'cm6', source: view.state.doc.toString() }
            if (cm5?.CodeMirror) return { reader: 'cm5', source: cm5.CodeMirror.getValue() }
            return null
          }).catch(() => null)
          if (probe?.source === fixture) selected = { frame, reader: probe.reader }
        }
      }
      if (!selected) await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (!selected) throw new Error('No visible source editor matched the complete fixture within 120 seconds')
    await selected.frame.page().exposeFunction(callbackName, result => {
      try {
        const measured = result.samples.slice(2).map(sample => sample.ms).sort((a, b) => a - b)
        const done = result.samples.length === 9
        const report = {
          recordedAt: new Date().toISOString(), app: values.app, blocks, mode: values.mode, reader: selected.reader,
          method: 'Native numeric 7 key at source start; trusted non-composing insertText event to second requestAnimationFrame; two warmups and seven samples. No simulated input.',
          environment: { platform: process.platform, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
            launchFlags: values['launch-flags'], renderer: result.renderer, viewport: result.viewport },
          input: { characters: fixture.length, sha256: hash(fixture) }, raw: result.samples,
          summary: measured.length ? { samples: measured.length, medianMs: measured[Math.floor(measured.length / 2)], p95Ms: measured[Math.ceil(measured.length * .95) - 1] } : null,
          complete: done, sourceVerified: done ? result.source === '7'.repeat(9) + fixture : null,
          output: done ? { characters: result.source.length, sha256: hash(result.source) } : null,
          overlappingInputs: result.overlappingInputs
        }
        writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
        console.log(`Recorded ${result.samples.length}/9`)
        if (done) finish(report)
      } catch (error) { fail(error) }
    })
    await selected.frame.evaluate(({ reader, callbackName, cleanupName }) => {
      const samples = []
      let pending = false, overlappingInputs = false
      const readSource = () => {
        if (reader === 'obsidian') return globalThis.app.workspace.activeEditor.editor.getValue()
        if (reader === 'cm5') return document.querySelector('.CodeMirror').CodeMirror.getValue()
        const content = document.querySelector('.cm-content')
        return (content.cmTile?.root?.view ?? content.cmView?.view).state.doc.toString()
      }
      const listener = event => {
        if (!event.isTrusted || event.isComposing || event.inputType !== 'insertText' || event.data !== '7'
          || samples.length >= 9 || !event.target.closest('.cm-content,.CodeMirror')) return
        if (pending) { overlappingInputs = true; return }
        pending = true
        const start = performance.now()
        requestAnimationFrame(() => requestAnimationFrame(() => {
          samples.push({ index: samples.length + 1, ms: performance.now() - start, isTrusted: event.isTrusted,
            isComposing: event.isComposing, inputType: event.inputType, data: event.data, target: event.target.tagName })
          pending = false
          void globalThis[callbackName]({ samples, source: readSource(), overlappingInputs,
            renderer: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio } })
          if (samples.length === 9) document.removeEventListener('input', listener, true)
        }))
      }
      document.addEventListener('input', listener, true)
      globalThis[cleanupName] = () => document.removeEventListener('input', listener, true)
    }, { reader: selected.reader, callbackName, cleanupName })
    console.log(`Armed ${values.app} ${blocks}; focus source, Ctrl+Home, press 7 nine times. Wait for each Recorded line.`)
    const report = await Promise.race([complete, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Native sampling timed out after 30 minutes')), 1800000)
    })])
    if (!report.sourceVerified || report.overlappingInputs) throw new Error('Invalid run: source mismatch or overlapping inputs; retain this report and use a new output path to retry')
    console.log(JSON.stringify(report.summary))
  } finally {
    clearTimeout(timeout)
    await selected?.frame.evaluate(cleanupName => {
      globalThis[cleanupName]?.()
      delete globalThis[cleanupName]
    }, cleanupName).catch(() => {})
    await browser.close()
  }
} else {
  throw new Error('Expected prepare or collect; use --help')
}
