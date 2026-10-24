;(async()=>{
  const {captureReopenedPreparedMixedOriginBundle}=await import('../../src/main/database/restore-knowledge-mixed-origin-bundle-read.ts')
  const {value}=await captureReopenedPreparedMixedOriginBundle(JSON.parse(process.argv[2]))
  process.stdout.write(JSON.stringify({pid:process.pid,value}))
})().catch(error=>{console.error(error);process.exitCode=1})
