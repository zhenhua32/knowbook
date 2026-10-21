import { TextDecoder } from 'node:util'

export type RawRestoreSqlCell = readonly ['null'] | readonly ['integer', string]
  | readonly ['real-ieee754-le', string] | readonly ['text', string] | readonly ['blob', string]
function refused(message: string): never { throw new Error('恢复知识SQL原件无效：' + message) }

/** Exact original capsule-inventory cell codec, lifted without changing its
 * tags, integer precision, IEEE754 bytes, TEXT decoder/BOM or roundtrip rules. */
export function rawRestoreSqlCell(storage: unknown, value: unknown, textEncoding: string): RawRestoreSqlCell {
  if (storage === 'null' && value === null) return ['null']
  if (storage === 'integer' && typeof value === 'bigint') return ['integer', value.toString()]
  if (storage === 'real' && typeof value === 'number') {
    const bits = Buffer.allocUnsafe(8); bits.writeDoubleLE(value)
    return ['real-ieee754-le', bits.toString('hex')]
  }
  if ((storage === 'text' || storage === 'blob') && value instanceof Uint8Array) {
    const bytes = Buffer.from(value)
    if (storage === 'text') {
      const label = textEncoding.toLowerCase(), decoder = new TextDecoder(label, { fatal: true, ignoreBOM: true })
      let text: string
      try { text = decoder.decode(bytes) } catch { return refused('原SQL TEXT含非法编码字节') }
      const roundtrip = Buffer.from(text, textEncoding === 'UTF-8' ? 'utf8' : 'utf16le')
      if (textEncoding === 'UTF-16be') roundtrip.swap16()
      if (!roundtrip.equals(bytes)) return refused('原SQL TEXT不能无损回读')
    }
    return [storage, bytes.toString('base64')]
  }
  return refused('原SQL storage class与实际值不符')
}
