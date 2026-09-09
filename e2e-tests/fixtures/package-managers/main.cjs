const generated = require('./generated.cjs')
const value = require('knowbook-manager-value')
module.exports.activate = (context) => {
  const fs = context.require('node:fs')
  const path = context.require('node:path')
  const historyPath = path.join(context.plugin.dataRoot, 'manager-history.json')
  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : []
  history.push({
    ...generated, value, revisionHash: context.plugin.revisionHash,
    resolvedDependency: require.resolve('knowbook-manager-value'),
    events: JSON.parse(fs.readFileSync(path.join(__dirname, 'events.json'), 'utf8'))
  })
  fs.writeFileSync(historyPath, JSON.stringify(history))
}
