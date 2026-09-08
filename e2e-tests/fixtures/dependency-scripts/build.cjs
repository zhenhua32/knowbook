const fs = require('node:fs')
const path = require('node:path')
const record = require('./lifecycle.cjs')
const config = require('./fixture.json')
record('build')
if (config.failure === 'build') {
  console.error('KNOWBOOK_CONTROLLED_BUILD_FAILURE')
  process.exitCode = 23
} else {
  const events = JSON.parse(fs.readFileSync(path.join(__dirname, 'events.json'), 'utf8'))
  const expected = config.allowScripts ? ['preinstall', 'install', 'postinstall', 'prebuild', 'build'] : ['build']
  if (JSON.stringify(events) !== JSON.stringify(expected)) throw new Error('Unexpected lifecycle execution order: ' + events)
  fs.writeFileSync(path.join(__dirname, 'generated.cjs'), 'module.exports = ' + JSON.stringify({ answer: 42, label: config.label }))
}
