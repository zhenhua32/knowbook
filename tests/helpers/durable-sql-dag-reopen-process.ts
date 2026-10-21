import { reopenCertifiedDurableSqlDag, readCertifiedDurableSqlDag,
  type ReopenCertifiedDurableSqlDagInput } from '../../src/main/database/restore-knowledge-dag-read'

export interface DagReopenProcessResult {
  pid: number
  diagnostic: Awaited<ReturnType<typeof readCertifiedDurableSqlDag>>
}

try {
  const input = JSON.parse(process.argv[2]) as ReopenCertifiedDurableSqlDagInput
  const diagnostic = await readCertifiedDurableSqlDag(await reopenCertifiedDurableSqlDag(input))
  const result: DagReopenProcessResult = { pid: process.pid, diagnostic }
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(String(error)); process.exitCode = 1
}
