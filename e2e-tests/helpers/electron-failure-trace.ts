import type { TestInfo } from '@playwright/test'
import { withElectronApp, type ElectronAppContext, type ElectronLaunchOptions } from './electron'

/** Electron's BrowserContext is created outside Playwright's browser fixture.
 * Start its actual DOM/screenshot trace explicitly; the ordinary test trace
 * alone records test steps without those native-page snapshots. */
export async function withElectronFailureTrace(
  info: TestInfo,
  run: (context: ElectronAppContext) => Promise<void>,
  extraEnv: Record<string, string> = {},
  options: ElectronLaunchOptions = {}
): Promise<void> {
  await withElectronApp(async context => {
    const tracing = context.app.context().tracing
    await tracing.start({ screenshots: true, snapshots: true, sources: true })
    let failed = false
    try {
      await run(context)
    } catch (error) {
      failed = true
      try {
        const path = info.outputPath('electron-first-attempt-trace.zip')
        await tracing.stop({ path })
        await info.attach('electron-first-attempt-trace', { path, contentType: 'application/zip' })
      } catch (captureError) {
        // Diagnostics must not replace the original interaction failure.
        await info.attach('electron-trace-capture-error', {
          body: String(captureError), contentType: 'text/plain'
        }).catch(() => undefined)
      }
      throw error
    } finally {
      if (!failed) await tracing.stop()
    }
  }, extraEnv, options)
}
