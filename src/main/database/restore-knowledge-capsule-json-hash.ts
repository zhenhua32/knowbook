import { createHash } from 'node:crypto'
import { capsuleJson } from './restore-knowledge-capsule-model'

const bufferLimit = 64 * 1024
const stringUnits = Math.floor(bufferLimit / 6) // An escaped code unit can occupy six bytes.
const storedArrays = new WeakMap<readonly unknown[], () => Iterable<string>>()
const projectedArrays = new WeakMap<readonly unknown[], () => Iterable<unknown>>()

/** Private hash serializer input for arrays already encoded by an owned plan. */
export function capsuleJsonStoredArray<T>(encodedItems: () => Iterable<string>): readonly T[] {
  const array: readonly T[] = Object.freeze([])
  storedArrays.set(array, encodedItems)
  return array
}

/** An ordered view of privately produced values. Used only for canonical hashes. */
export function capsuleJsonProjectedArray<T>(values: () => Iterable<T>): readonly T[] {
  const array: readonly T[] = Object.freeze([])
  projectedArrays.set(array, values)
  return array
}

function* capsuleJsonStringChunks(value: string): IterableIterator<string> {
  if (value.length <= stringUnits) { yield JSON.stringify(value); return }
  yield '"'
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + stringUnits)
    const trailing = value.charCodeAt(end - 1), following = value.charCodeAt(end)
    if (trailing >= 0xd800 && trailing <= 0xdbff && following >= 0xdc00 && following <= 0xdfff) end--
    yield JSON.stringify(value.slice(start, end)).slice(1, -1)
    start = end
  }
  yield '"'
}

export function capsuleJsonStringBytes(value: string, limit: number): number {
  if (value.length <= stringUnits) return Buffer.byteLength(JSON.stringify(value))
  let bytes = 0
  for (const chunk of capsuleJsonStringChunks(value)) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > limit) break
  }
  return bytes
}

/** Canonical bytes for privately built SQL packets. A complete encoded packet
 * is never needed for its byte budget or digest. JSON still orders array-index
 * object keys numerically after the canonical lexical property sort. */
export function hashBoundedCapsuleJson(value: object, maxBytes: number, prefix = ''): string | null {
  const hash = createHash('sha256').update(prefix)
  let pending = '', bytes = 0
  const emit = (part: string) => {
    if (part.length >= bufferLimit) {
      flush()
      bytes += Buffer.byteLength(part)
      if (bytes <= maxBytes) hash.update(part)
      return
    }
    pending += part
    if (pending.length >= bufferLimit) flush()
  }
  const flush = () => {
    bytes += Buffer.byteLength(pending)
    if (bytes <= maxBytes) hash.update(pending)
    pending = ''
  }
  const writeString = (value: string) => {
    if (value.length <= stringUnits) { emit(JSON.stringify(value)); return }
    for (const chunk of capsuleJsonStringChunks(value)) {
      if (bytes > maxBytes) break
      emit(chunk)
    }
  }
  const write = (item: unknown) => {
    if (bytes > maxBytes) return
    if (typeof item === 'string') writeString(item)
    else if (Array.isArray(item)) {
      emit('[')
      const stored = storedArrays.get(item)
      const projected = projectedArrays.get(item)
      if (stored) {
        let first = true
        for (const encoded of stored()) {
          if (bytes > maxBytes) break
          if (!first) emit(',')
          emit(encoded)
          first = false
        }
      } else if (projected) {
        let first = true
        for (const value of projected()) {
          if (bytes > maxBytes) break
          if (!first) emit(',')
          write(value)
          first = false
        }
      } else {
        for (let index = 0; index < item.length && bytes <= maxBytes; index++) {
          if (index) emit(',')
          write(item[index])
        }
      }
      emit(']')
    } else if (item && typeof item === 'object') {
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) {
        emit(capsuleJson(item)); return
      }
      const fields = Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      emit('{')
      let first = true
      for (const key of Object.keys(fields)) {
        if (bytes > maxBytes) break
        const value = fields[key]
        if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue
        if (!first) emit(',')
        writeString(key); emit(':'); write(value)
        first = false
      }
      emit('}')
    } else emit(JSON.stringify(item) ?? 'null')
  }
  write(value)
  flush()
  return bytes <= maxBytes ? hash.digest('hex') : null
}
