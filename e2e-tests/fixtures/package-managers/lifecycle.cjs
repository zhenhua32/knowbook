const fs = require('node:fs')
const path = require('node:path')
const eventsPath = path.join(__dirname, 'events.json')
module.exports = (stage) => {
  const events = fs.existsSync(eventsPath) ? JSON.parse(fs.readFileSync(eventsPath, 'utf8')) : []
  events.push(stage)
  fs.writeFileSync(eventsPath, JSON.stringify(events))
  console.log('KNOWBOOK_MANAGER_PHASE_' + stage)
}
if (require.main === module) module.exports(process.argv[2])
