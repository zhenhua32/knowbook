import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { parseMixedWorkingLocators5 } from './restore-knowledge-mixed-origin-bundle-model'
import { parseQualifiedWorkingLocators5 } from './restore-knowledge-qualified-original-model'
import { parseWorkingOriginals5 } from './restore-knowledge-capsule5-working-model'
import type { TransportWorkingIndex5, TransportWorkingTexts5 } from './restore-knowledge-capsule5-transport-model'
import { originBundleInvalid as bad } from './restore-knowledge-origin-bundle-model'

/** Copy bootstrap only. The caller uses a fixed catalog or exact frame and
 * then runs the ordinary full inventory/tree and genuine SQL readers. */
export async function readTransportWorkingTexts5(descriptorText: string, reader: 'prepared-mixed-v2' | 'qualified-originals-v1',
  readIndex: (index: TransportWorkingIndex5) => Promise<string>, expectedDescriptorHash?: string): Promise<TransportWorkingTexts5> {
  const header = reader === 'prepared-mixed-v2' ? parseMixedWorkingLocators5(descriptorText)
    : parseQualifiedWorkingLocators5(descriptorText, expectedDescriptorHash)
  if (expectedDescriptorHash !== undefined && header.descriptorHash !== expectedDescriptorHash) return bad('working5复制header原hash变化')
  const texts: { source?: string; current?: string } = {}
  // Finite source/current only; no path lookup fallback, root-hash deduplication,
  // caller source lists, or legacy profile/spool probe.
  for (const index of header.indexes) {
    const text = await readIndex(index), manifest = parseWorkingOriginals5(text, index.pointer)
    if (text !== capsuleJson(manifest) + '\n') return bad('working5复制索引原字节不闭合')
    texts[index.side] = text
  }
  return freezeCapsuleValue(texts)
}
