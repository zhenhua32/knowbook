import { setTimeout } from 'node:timers/promises'
import { basename, dirname, join } from 'node:path'
import { capsuleRecord } from './restore-knowledge-capsule-model'
import type { ControlledV3RestorePreview } from './restore-safety'
import { canonicalRestoreRoot, readRestoreText, restoreExists, writeRestoreJson } from './restore-safety-files'

/** Match only the V3 Playwright fixture's fresh, isolated profile. */
export function isV3RestoreConsentFixture(profile: string): boolean {
  return basename(profile) === 'target' && /^knowbook-e2e-v3-[a-zA-Z0-9]{6}$/.test(basename(dirname(profile)))
    && process.env.APPDATA === profile && process.env.LOCALAPPDATA === profile
}

export async function readV3RestoreConsentFixture(profile: string, preview: ControlledV3RestorePreview): Promise<boolean> {
  if (!isV3RestoreConsentFixture(profile)) throw new Error('V3 恢复确认夹具需要独立的测试工作区。')
  const root = await canonicalRestoreRoot(profile), previewPath = join(root, 'database-restore-e2e-preview.json')
  const consentPath = join(root, 'database-restore-e2e-consent.json')
  // A previous or premature response cannot choose this newly prepared plan.
  if (await restoreExists(consentPath)) throw new Error('V3 恢复确认夹具已存在旧响应。')
  await writeRestoreJson(previewPath, preview, root)
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    if (await restoreExists(consentPath)) {
      const consent = capsuleRecord(JSON.parse(await readRestoreText(consentPath)), ['operationId', 'intentHash', 'confirmed'])
      if (consent.operationId !== preview.operationId || consent.intentHash !== preview.intentHash || typeof consent.confirmed !== 'boolean')
        throw new Error('V3 恢复夹具的响应不属于当前计划。')
      return consent.confirmed
    }
    await setTimeout(100)
  }
  return false
}
