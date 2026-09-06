import { runPackagedRuntimeSmoke } from './lib/packaged-runtime-smoke.mjs'

const { output } = await runPackagedRuntimeSmoke()
process.stdout.write(output || 'Packaged runtime smoke passed.\n')
