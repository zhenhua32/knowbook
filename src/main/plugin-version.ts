import semver from 'semver'

export function isPluginVersionCompatible(
  manifest: { engines?: { knowbook?: string } },
  currentVersion: string
): boolean {
  const range = manifest.engines?.knowbook
  if (!range) {
    return true // No engines field means compatible with all versions
  }

  try {
    return semver.satisfies(currentVersion, range)
  } catch {
    return false
  }
}

export function getVersionCompatibilityMessage(
  manifest: { engines?: { knowbook?: string } },
  currentVersion: string
): string | null {
  if (!manifest.engines?.knowbook) {
    return null
  }

  if (isPluginVersionCompatible(manifest, currentVersion)) {
    return null
  }

  return `Requires KnowBook version ${manifest.engines.knowbook}, current version is ${currentVersion}`
}
