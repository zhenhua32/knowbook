import type { WebDavProtocol5DeletionPreview, WebDavProtocol5DeletionSide } from '../../shared/webdav-sync'
import { publicationInvalid } from './synced-publication-model'
import type { DeletionDecisionSource, SyncedExchangeDeletionPreview } from './synced-exchange-deletion-choice-model'

const MAX_SIDE_TEXT = 4000
const MAX_VIEW_TEXT = 96_000
type Row = DeletionDecisionSource['baseRecords'][number]

/** The only inputs are the original immutable preview and its authenticated source. */
export function projectDeletionPreview(preview: SyncedExchangeDeletionPreview, source: DeletionDecisionSource): WebDavProtocol5DeletionPreview {
  const map = (rows: Row[]) => new Map(rows.map(row => [row.key, row]))
  const base = map(source.baseRecords), local = map(source.localKnowledge.records), remote = map(source.remote.records)
  let remaining = MAX_VIEW_TEXT
  function side(hash: string | null, row?: Row): WebDavProtocol5DeletionSide {
    if (hash === null) return { kind: 'missing', hash }
    if (!row) return { kind: 'unavailable', hash }
    if (row.hash !== hash) return publicationInvalid('删除预览显示数据与原记录哈希不一致。')
    const record = row.record
    if (record.kind === 'deleted') return { kind: 'deleted', hash }
    if (record.kind === 'synced-group-deleted') return { kind: 'deleted', hash, deletedAt: record.deletedAt }
    if (record.kind !== 'document' && record.kind !== 'synced-group') return { kind: 'unavailable', hash }
    const limit = Math.min(MAX_SIDE_TEXT, remaining)
    const blocks = record.kind === 'document' ? record.content.blocks : record.blocks
    let text = record.kind === 'document' ? record.content.summary : ''
    let truncated = text.length > limit
    text = text.slice(0, limit)
    for (const block of blocks) {
      const separator = text ? '\n' : ''
      const room = limit - text.length
      if (separator.length + block.content.length > room) {
        text += (separator + block.content.slice(0, room)).slice(0, room)
        truncated = true
        break
      }
      text += separator + block.content
    }
    remaining -= text.length
    return { kind: 'live', hash, ...(record.kind === 'document' ? { title: record.content.title } : {}), text, truncated }
  }
  const complete = (value: WebDavProtocol5DeletionSide) => value.kind !== 'unavailable' && (value.kind !== 'live' || !value.truncated)
  return { previewId: preview.previewId, previewHash: preview.previewHash, components: preview.components.map(component => {
    const records = component.records.filter(row => row.baseHash !== row.localHash || row.localHash !== row.remoteHash
      || component.deletionKeys.includes(row.key)).map(row => {
      const l = local.get(row.key), r = remote.get(row.key)
      if ((l?.hash ?? null) !== row.localHash || (r?.hash ?? null) !== row.remoteHash) {
        return publicationInvalid('删除预览显示数据与本机或远端原记录不一致。')
      }
      // The planner also uses an unchanged side as the exact common object when its hash matches.
      const b = [base.get(row.key), l, r].find(candidate => candidate && candidate.hash === row.baseHash)
      return { key: row.key, base: side(row.baseHash, b), local: side(row.localHash, l), remote: side(row.remoteHash, r) }
    })
    const completeText = records.every(row => complete(row.base) && complete(row.local) && complete(row.remote))
    return { componentId: component.componentId, records, completeText, choices: completeText ? [...component.choices] : [],
      keepLiveReason: component.keepLiveReason, keepDeleteReason: component.keepDeleteReason }
  }) }
}
