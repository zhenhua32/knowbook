export interface StrictJsonLimits { maxBytes: number; maxDepth: number }

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])

/** JSON.parse alone loses duplicate keys. Scan the original JSON before decoding
 * so configuration and restore manifests cannot silently select the last value. */
export function parseStrictJson(content: string, limits: StrictJsonLimits): unknown {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1
    || !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > 256) {
    throw new RangeError('无效的 JSON 资源限制。')
  }
  const fail = (): never => { throw new Error('JSON 数据无效、包含重复或不安全的键，或超出资源限制。') }
  if (typeof content !== 'string' || content.length > limits.maxBytes
    || new TextEncoder().encode(content).byteLength > limits.maxBytes) return fail()
  let position = 0
  const whitespace = () => { while (/[\t\n\r ]/.test(content[position] ?? '') && position < content.length) position++ }
  const string = (decode = false): string => {
    if (content[position] !== '"') return fail()
    const start = position++
    while (position < content.length) {
      const char = content[position++]
      if (char === '\\') { position++; continue }
      if (char === '"') {
        try { return decode ? JSON.parse(content.slice(start, position)) as string : '' }
        catch { return fail() }
      }
      if (char.charCodeAt(0) < 0x20) return fail()
    }
    return fail()
  }
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
  const value = (depth: number): void => {
    whitespace()
    const char = content[position]
    if (char === '{' || char === '[') {
      if (depth >= limits.maxDepth) return fail()
      const object = char === '{', close = object ? '}' : ']'
      const keys = new Set<string>()
      position++; whitespace()
      if (content[position] === close) { position++; return }
      for (;;) {
        if (object) {
          const key = string(true)
          if (keys.has(key) || unsafeKeys.has(key)) return fail()
          keys.add(key); whitespace()
          if (content[position++] !== ':') return fail()
        }
        value(depth + 1); whitespace()
        if (content[position] === close) { position++; return }
        if (content[position++] !== ',') return fail()
        whitespace()
      }
    }
    if (char === '"') { string(); return }
    for (const literal of ['true', 'false', 'null']) if (content.startsWith(literal, position)) {
      position += literal.length; return
    }
    number.lastIndex = position
    const match = number.exec(content)
    if (!match || !Number.isFinite(Number(match[0]))) return fail()
    position = number.lastIndex
  }
  value(0); whitespace()
  if (position !== content.length) return fail()
  try { return JSON.parse(content) as unknown }
  catch { return fail() }
}
