'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'))
contextBridge.exposeInMainWorld('capabilityPreload', {
  proof: fs.readFileSync(path.join(__dirname, 'preload-proof.txt'), 'utf8'),
  node: process.versions.node,
  ping: (value) => ipcRenderer.invoke(`knowbook-capability-${config.token}`, value)
})
