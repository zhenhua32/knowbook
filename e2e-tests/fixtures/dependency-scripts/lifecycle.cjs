const fs = require('node:fs')
const path = require('node:path')
const config = require('./fixture.json')
module.exports = function record(stage) {
  const file = path.join(__dirname, 'events.json')
  const events = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
  events.push(stage)
  fs.writeFileSync(file, JSON.stringify(events))
  console.log('KNOWBOOK_PHASE_' + stage)
}
if (require.main === module) {
  module.exports(process.argv[2])
  if (config.failure === 'install' && process.argv[2] === 'install') {
    console.error('KNOWBOOK_CONTROLLED_INSTALL_FAILURE')
    process.exitCode = 17
  }
}
