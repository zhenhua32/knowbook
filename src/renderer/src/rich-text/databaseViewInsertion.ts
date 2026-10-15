import { NodeSelection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state'
import type { DocumentBlockDraft } from '@shared/contracts'
import { serializeDatabaseViewPayload, type DatabaseViewBlockPayloadV1 } from '@shared/databaseViewBlock'
import { validColumnStructure } from '@shared/columnStructure'
import { createDraftBlockId } from '../utils/draftTreeFragment'
import { validateBlockTreeStructure } from '../utils/draftTreeNormalization'
import { richBlockEntries, richBlockEntryAt, richDocToDraftBlocks } from './model'
import { deleteCrossColumnSelection } from './columnEditing'
import { richTextSchema } from './schema'

/** No mutation is applied until the user has picked a real source. Empty slash
 * hosts retain their public identity; inserted atoms never contain fake rows. */
export function planRichDatabaseViewInsertion(state: EditorState, payload: DatabaseViewBlockPayloadV1, removeSlash = false): Transaction | null {
  const content = serializeDatabaseViewPayload(payload)
  const current = richBlockEntryAt(state.doc, state.selection.from)?.node.attrs.block as DocumentBlockDraft | undefined
  if (!current) return null
  const selection = state.selection
  const entries = richBlockEntries(state.doc), index = entries.findIndex(({ node }) => node.attrs.block?.id === current.id)
  const hasChildren = index >= 0 && (entries[index + 1]?.node.attrs.block?.depth ?? 0) > current.depth
  const replaceHost = selection instanceof TextSelection && selection.$from.sameParent(selection.$to)
    && selection.$from.parent.type === richTextSchema.nodes.text_block && (current.type === 'paragraph' || removeSlash) && !hasChildren
    && (selection.$from.parent.content.size === 0 || removeSlash && /^\/[^\s]*$/.test(selection.$from.parent.textContent))
  if (removeSlash && !replaceHost) return null
  const { language: _language, listStart: _listStart, markdownFormat: _format, ...identity } = current
  const block: DocumentBlockDraft = replaceHost
    ? { ...identity, type: 'database-view', content, checked: false }
    : { id: createDraftBlockId(), type: 'database-view', content, checked: false,
      depth: current.depth, parentBlockId: current.parentBlockId ?? null }
  const atom = richTextSchema.nodes.database_view_block.create({ block })
  const tr = deleteCrossColumnSelection(state) ?? state.tr
  if (replaceHost) tr.replaceWith(selection.$from.before(), selection.$to.after(), atom)
  else tr.replaceSelectionWith(atom)
  const blocks = richDocToDraftBlocks(tr.doc)
  if (!validColumnStructure(blocks, { checkParentIds: true }) || !validateBlockTreeStructure(blocks).valid) return null
  const entry = richBlockEntries(tr.doc).find(({ node }) => node.attrs.block?.id === block.id)
  if (!entry) return null
  return tr.setSelection(NodeSelection.create(tr.doc, entry.pos))
}
