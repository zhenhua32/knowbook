'use strict'
module.exports = {
  activate(context) {
    const fs = context.require('node:fs')
    const path = context.require('node:path')
    const binaryPath = context.require.resolve('./build/Release/abi_probe.node')
    const addon = context.require(binaryPath)
    fs.writeFileSync(path.join(context.plugin.dataRoot, 'compiled-native.json'), JSON.stringify({
      ...addon,
      version: context.plugin.version,
      revisionHash: context.plugin.revisionHash,
      binaryPath,
      binaryHash: context.require('node:crypto').createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex'),
      electron: process.versions.electron,
      modules: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
      packaged: context.desktop.electron.app.isPackaged
    }))
  }
}
