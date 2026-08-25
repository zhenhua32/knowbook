const MAX_REGISTRY_ID_LENGTH = 200
const MAX_REGISTRY_VERSION_LENGTH = 100
const MIN_PRIORITY = -100_000
const MAX_PRIORITY = 100_000

export function normalizeRegistryId(value: string, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new Error(`Plugin ${label} is required.`)
  }
  if (normalized.length > MAX_REGISTRY_ID_LENGTH) {
    throw new Error(`Plugin ${label} exceeds ${MAX_REGISTRY_ID_LENGTH} characters.`)
  }
  if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(normalized)) {
    throw new Error(`Plugin ${label} contains unsupported characters: "${normalized}".`)
  }
  return normalized
}

export function normalizeRegistryVersion(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new Error('Plugin service version is required.')
  }
  if (normalized.length > MAX_REGISTRY_VERSION_LENGTH) {
    throw new Error(`Plugin service version exceeds ${MAX_REGISTRY_VERSION_LENGTH} characters.`)
  }
  return normalized
}

export function normalizeRegistryPriority(value: number | undefined): number {
  const normalized = value ?? 0
  if (!Number.isSafeInteger(normalized) || normalized < MIN_PRIORITY || normalized > MAX_PRIORITY) {
    throw new Error(`Plugin registry priority must be an integer from ${MIN_PRIORITY} to ${MAX_PRIORITY}.`)
  }
  return normalized
}

export function normalizeContributionOrder(value: number | undefined): number {
  const normalized = value ?? 0
  if (!Number.isFinite(normalized) || normalized < MIN_PRIORITY || normalized > MAX_PRIORITY) {
    throw new Error(`Plugin contribution order must be a finite number from ${MIN_PRIORITY} to ${MAX_PRIORITY}.`)
  }
  return normalized
}
