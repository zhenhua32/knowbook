const fs = require('node:fs')
const path = require('node:path')
require('./lifecycle.cjs')('build')
const config = require('./fixture.json')
const dependencyPath = path.dirname(require.resolve('knowbook-manager-value'))
const dependencyScriptRan = fs.existsSync(path.join(dependencyPath, 'installed.json'))
if (dependencyScriptRan !== config.allowScripts) throw new Error('Dependency lifecycle policy was not respected')
fs.writeFileSync(path.join(__dirname, 'generated.cjs'), 'module.exports = ' + JSON.stringify({
  value: require('knowbook-manager-value'), dependencyScriptRan, label: config.label
}))
