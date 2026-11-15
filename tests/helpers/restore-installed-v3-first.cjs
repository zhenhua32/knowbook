async function run() {
  const { restoreControlledBackupV3 } = await import('../../src/main/database/restore-safety.ts')
  const [profileRoot, backupDirectory] = process.argv.slice(2)
  const result = await restoreControlledBackupV3({ userDataRoot: profileRoot, backupDirectory, stopProcesses: async () => [] }, {
    readCurrentIdentities: async () => [],
    recoverLegacy: async () => { throw new Error('Unexpected legacy restore') }
  })
  process.stdout.write(JSON.stringify({ status: result.status, operationId: result.operationId }))
}

run().catch(error => { console.error(error); process.exitCode = 1 })
