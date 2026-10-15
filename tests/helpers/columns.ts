import type { DocumentBlockDraft } from '../../src/shared/contracts'

export function columnForest(prefix = ''): DocumentBlockDraft[] {
  const block = (id: string, type: string, depth: number, parent: string | null, content = '',
    extra: Partial<DocumentBlockDraft> = {}): DocumentBlockDraft => ({
      id: prefix + id, type, depth, parentBlockId: parent === null ? null : prefix + parent,
      content, checked: false, tags: [], ...extra
    })
  return [
    block('group', 'columns', 0, null, '', { tags: ['layout'], highlight: 'blue' }),
    block('left', 'column', 1, 'group', '', { markdownFormat: { columnWeight: 5000 } }),
    block('title', 'heading-2', 2, 'left', 'Heading'),
    block('toggle', 'toggle', 2, 'left', 'Details', { markdownFormat: { toggleDefaultOpen: false } }),
    block('code', 'code', 3, 'toggle', 'const value = 1', { language: 'ts', markdownFormat: { codeInfo: 'ts' } }),
    block('right', 'column', 1, 'group', '', { markdownFormat: { columnWeight: 5000 } }),
    block('task', 'numbered-todo', 2, 'right', 'Original task', {
      checked: true, listStart: 4, markdownFormat: { listMarker: ')', listLoose: true }
    }),
    block('child', 'todo', 3, 'task', 'Nested task', { tags: ['nested'], highlight: 'yellow' }),
    block('outside', 'paragraph', 0, null, 'Outside')
  ]
}

export function columnWeights(blocks: readonly DocumentBlockDraft[]): number[] {
  return blocks.filter(block => block.type === 'column').map(block => block.markdownFormat!.columnWeight!)
}
