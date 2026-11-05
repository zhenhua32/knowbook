import type { EditorRecoverySourceBuffer } from '@shared/editor-recovery-drafts'

export type RecoverySourceAddress = { kind: 'host'; documentId: string } | { kind: 'group'; groupId: string }
export interface RecoverySourceSnapshot {
  openingSource: string; acceptedSource: string; source: string
  selection: { anchor: number; head: number }; composing: boolean; applying: boolean; importing: boolean
  /** The real draft objects, including original block anchors and reference
   * anchors. This is preserved data; it never creates Source write authority. */
  replayJson: string
  dirty: boolean
}
type Entry = { address: RecoverySourceAddress; value: EditorRecoverySourceBuffer | null }
const entries = new Map<object, Entry>(), listeners = new Set<() => void>()
const changed = () => { for (const listener of listeners) listener() }

/** Called by the one mounted CM opening. An unexpected React cleanup cannot
 * erase unresolved input or manufacture a compositionend. */
export function registerRecoverySource(identity: object, address: RecoverySourceAddress) {
  if (entries.has(identity)) throw new Error('Source recovery opening already registered')
  const entry: Entry = { address: { ...address }, value: null }, sourceId = crypto.randomUUID()
  entries.set(identity, entry)
  return {
    update(snapshot: RecoverySourceSnapshot) {
      if (entries.get(identity) !== entry) return
      entry.value = { sourceId, kind: address.kind === 'group' ? 'canonical' : 'synced-host', ...snapshot }
      changed()
    },
    /** Only actual Cancel or accepted Apply calls this after the original modal
     * has checked composition, import and pending application. */
    acceptedClose() { if (entries.delete(identity)) changed() }
  }
}
export function readRecoverySources(address: RecoverySourceAddress): EditorRecoverySourceBuffer[] {
  const same = (other: RecoverySourceAddress) => address.kind === 'host' ? other.kind === 'host' && address.documentId === other.documentId
    : other.kind === 'group' && address.groupId === other.groupId
  return [...entries.values()].filter(entry => same(entry.address) && entry.value
    && (entry.value.dirty || entry.value.source !== entry.value.acceptedSource || entry.value.composing || entry.value.applying || entry.value.importing))
    .map(entry => structuredClone(entry.value!))
}
export function subscribeRecoverySources(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }

/** IPC omits optional undefined fields. It never normalizes UTF16 or changes
 * empty collections. Accessors, exotic objects, cycles and sparse arrays fail. */
export function recoveryData(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || active.has(value)) throw new Error('Recovery snapshot must contain plain data')
  const array = Array.isArray(value)
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Recovery snapshot object differs')
  const descriptors = Object.getOwnPropertyDescriptors(value), result: unknown[] | Record<string, unknown> = array ? [] : {}
  if (array && Reflect.ownKeys(descriptors).length !== value.length + 1) throw new Error('Recovery array is not dense')
  active.add(value)
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === 'length') continue
      if (typeof key !== 'string' || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new Error('Recovery own fields differ')
      const descriptor = descriptors[key]
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Recovery accessor cannot be read')
      if (descriptor.value === undefined && !array) continue
      Object.defineProperty(result, key, { value: recoveryData(descriptor.value, active), enumerable: true, configurable: true, writable: true })
    }
  } finally { active.delete(value) }
  return result
}
