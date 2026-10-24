;(async()=>{
  const {reopenActualFirstRequiredSqlDag,readActualFirstRequiredSqlDagMaterial}=await import('../../src/main/database/restore-knowledge-mixed-required-dag-read.ts')
  const handle=await reopenActualFirstRequiredSqlDag(JSON.parse(process.argv[2]))
  process.stdout.write(JSON.stringify({pid:process.pid,material:await readActualFirstRequiredSqlDagMaterial(handle)}))
})().catch(error=>{console.error(error);process.exitCode=1})
