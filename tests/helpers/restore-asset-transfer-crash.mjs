import { createRequire, syncBuiltinESMExports } from 'node:module'
import { publishRestoreAssetTransfer4, reopenRestoreAssetTransfer4 } from '../../src/main/database/restore-asset-transfer4.ts'

const original = await reopenRestoreAssetTransfer4(...process.argv.slice(2))
const fs = createRequire(import.meta.url)('node:fs/promises')
const link = fs.link
let calls = 0
fs.link = (...args) => {
  if (++calls === 2) process.exit(77)
  return link(...args)
}
syncBuiltinESMExports()
await publishRestoreAssetTransfer4(original.transfer)
process.exitCode = 78
