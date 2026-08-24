import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DatabaseField, DatabaseRecord } from '../src/shared/contracts.ts'
import { DatabaseTableView } from '../src/renderer/src/features/database/components/DatabaseTableView.tsx'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText.ts'

const fields: DatabaseField[] = [
  { id: '__title', name: '标题', type: 'text', options: [], sortOrder: 0, role: 'title', editable: false, hideable: false, deletable: false },
  { id: 'status', name: '状态', type: 'select', options: ['待办', '完成'], sortOrder: 1, role: 'property', editable: true, hideable: true, deletable: true }
]

const records: DatabaseRecord[] = Array.from({ length: 2_000 }, (_, index) => ({
  id: `record-${index}`,
  databaseId: 'projects',
  title: `项目记录 ${index}`,
  documentId: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  fieldValues: { status: index % 2 === 0 ? '待办' : '完成' }
}))

test('database table renders only the initial viewport for 2,000 records', () => {
  const startedAt = performance.now()
  const markup = renderToStaticMarkup(
    <DatabaseTableView
      columnWidths={{}}
      documents={[]}
      fields={fields}
      onColumnWidthChange={() => undefined}
      onOpenDocument={() => undefined}
      onOpenRecord={() => undefined}
      onSelect={() => undefined}
      onUpdateDocument={async () => undefined}
      onUpdateValue={async () => undefined}
      records={records}
      selectedIds={new Set()}
      sourceKind="custom"
      text={getDatabaseWorkspaceText('zh-CN')}
    />
  )
  const elapsedMs = performance.now() - startedAt
  const renderedRows = markup.match(/<tr/g)?.length ?? 0

  assert.ok(renderedRows < 40, `expected a virtualized viewport, rendered ${renderedRows} rows`)
  assert.ok(elapsedMs < 1_500, `expected initial render under 1.5s, took ${elapsedMs.toFixed(1)}ms`)
  assert.match(markup, /项目记录 0/)
  assert.doesNotMatch(markup, /项目记录 1999/)
})
