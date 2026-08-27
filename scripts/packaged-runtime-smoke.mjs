import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const candidates = process.platform === 'win32'
  ? [resolve('release', 'win-unpacked', 'KnowBook.exe')]
  : process.platform === 'darwin'
    ? [
        resolve('release', 'mac', 'KnowBook.app', 'Contents', 'MacOS', 'KnowBook'),
        resolve('release', 'mac-arm64', 'KnowBook.app', 'Contents', 'MacOS', 'KnowBook')
      ]
    : [resolve('release', 'linux-unpacked', 'knowbook')]
const executable = candidates.find(existsSync) ?? candidates[0]

if (!existsSync(executable)) {
  throw new Error(`Packaged KnowBook executable is missing: ${executable}`)
}

const profile = mkdtempSync(join(tmpdir(), 'knowbook-packaged-runtime-smoke-'))
const resultPath = join(profile, 'runtime-smoke-result.json')
try {
  await new Promise((resolve_, reject) => {
    const child = spawn(executable, [
      '--no-sandbox',
      '--disable-gpu',
      '--enable-logging=stderr',
      `--user-data-dir=${profile}`
    ], {
      env: {
        ...process.env,
        KNOWBOOK_DISABLE_HARDWARE_ACCELERATION: '1',
        KNOWBOOK_PACKAGED_PLUGIN_RUNTIME_SMOKE: '1',
        KNOWBOOK_PACKAGED_PLUGIN_RUNTIME_SMOKE_RESULT: resultPath,
        // Electron's Chromium switch does not provide a strong contract for
        // app.getPath('userData'), which is also the single-instance lock root.
        KNOWBOOK_USER_DATA_DIR: profile
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    const timeout = setTimeout(() => {
      child.kill()
      const result = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'result file was not created'
      reject(new Error(`Packaged runtime smoke timed out (${result}).\n${output.slice(-8_000)}`))
    }, 90_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        process.stdout.write(output || 'Packaged runtime smoke passed.\n')
        resolve_()
      } else {
        reject(new Error(`Packaged runtime smoke exited with code ${code}.\n${output.slice(-8_000)}`))
      }
    })
  })
} finally {
  rmSync(profile, { recursive: true, force: true })
}
