'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { mode } = require('./fixture.json')
module.exports.activate = (context) => {
  const marker = path.join(context.plugin.dataRoot, 'attempts.json')
  const attempts = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : []
  attempts.push({ mode, version: context.plugin.version, revisionHash: context.plugin.revisionHash, pid: process.pid })
  if (mode === 'good') {
    if (context.settings.get('system.e2e.recovery.sentinel') === null) context.settings.set('system.e2e.recovery.sentinel', 'before-failure')
    fs.writeFileSync(marker, JSON.stringify(attempts))
    return
  }
  // Deliberately prove that code rollback does not undo persistent side effects.
  context.settings.set('system.e2e.recovery.sentinel', `mutated-by-${mode}`)
  fs.writeFileSync(marker, JSON.stringify(attempts))
  if (mode === 'throw') throw new Error('KNOWBOOK_CONTROLLED_ACTIVATION_THROW')
  if (mode === 'exit') {
    // Electron can schedule process.exit rather than synchronously stop JS.
    // Keep activation pending until the real exit; falling through to the
    // unknown-mode throw would accidentally exercise ordinary rollback.
    process.exit(41)
    return new Promise(() => {})
  }
  if (mode === 'crash') process.crash()
  if (mode === 'loop') for (;;) { /* External test watchdog terminates only this isolated KnowBook process. */ }
  throw new Error(`Unknown controlled failure mode: ${mode}`)
}
