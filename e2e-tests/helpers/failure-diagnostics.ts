import type { TestInfo } from '@playwright/test'

/** Failure-only observations never replace the cached assertion or its error. */
export async function attachFailureDiagnostic(info: TestInfo, name: string, assertionSample: unknown,
  observe: () => Promise<unknown>): Promise<void> {
  console.error(`[${name}:assertion-sample] ${JSON.stringify(assertionSample)}`)
  let timer: NodeJS.Timeout | undefined
  try {
    const laterObservation = await Promise.race([
      observe().then(value => ({ value }), error => ({ error: String(error) })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ error: 'Failure-only observation exceeded 1000ms' }), 1_000) })
    ])
    await info.attach(name, { body: Buffer.from(JSON.stringify({ assertionSample, laterObservation }, null, 2)),
      contentType: 'application/json' })
    console.error(`[${name}:later-observation] ${JSON.stringify(laterObservation)}`)
  } catch (error) {
    console.error(`[${name}:diagnostic-error] ${String(error)}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
}
