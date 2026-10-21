import assert from 'node:assert/strict'
import test from 'node:test'
import { validateQualifiedKnowledgePayload2 } from '../src/main/database/restore-knowledge-qualified-payload-model'
import { qualifiedStructureFixture, changeProjection } from './helpers/qualified-knowledge-structure-fixture'

// PREPARED ONLY. Small synthetic negatives exercise each shared cell entry.
// Rejection assertions do not claim measured BigInt timing/heap guarantees;
// the <=20-before-regex/BigInt order is independently auditable source syntax.
test('qualified INT64 original value cells reject 21 and 4096 character decimals without giant fixtures', () => {
  for (const value of ['9'.repeat(21), '-' + '9'.repeat(20), '9'.repeat(4096)]) {
    const raw = changeProjection(qualifiedStructureFixture(), p => ({ ...p, originals: p.originals.map(table => ({ ...table,
      rows: table.rows.map(row => ({ ...row, cells: row.cells.map((cell, index) => index === 1 ? ['integer', value] as const : cell) }))
    })) }))
    assert.throws(() => validateQualifiedKnowledgePayload2(raw), /INT64/)
  }
})

test('qualified INT64 original row keys use the same preparse bound as value cells', () => {
  const raw = changeProjection(qualifiedStructureFixture(), p => ({ ...p, originals: p.originals.map(table => ({ ...table,
    rows: table.rows.map(row => ({ ...row, key: [['integer', '9'.repeat(21)] as const] }))
  })) }))
  assert.throws(() => validateQualifiedKnowledgePayload2(raw), /INT64/)
})

test('qualified INT64 mandatory-material row reference keys cannot bypass the shared preparse bound', () => {
  const raw = changeProjection(qualifiedStructureFixture(), p => ({ ...p, denials: p.denials.map(item => ({ ...item,
    mandatoryMaterial: [{ ...item.source, key: [['integer', '-' + '9'.repeat(20)] as const] }]
  })) }))
  assert.throws(() => validateQualifiedKnowledgePayload2(raw), /INT64/)
})

test('qualified INT64 exact signed endpoints and canonical spelling remain unchanged inside the 20 character bound', () => {
  for (const value of ['0', '-1', '9223372036854775807', '-9223372036854775808']) {
    const raw = changeProjection(qualifiedStructureFixture(), p => ({ ...p, originals: p.originals.map(table => ({ ...table,
      rows: table.rows.map(row => ({ ...row, cells: row.cells.map((cell, index) => index === 1 ? ['integer', value] as const : cell) }))
    })) }))
    assert.equal(validateQualifiedKnowledgePayload2(raw).projection.originals[0].rows[0].cells[1][1], value)
  }
  for (const value of ['9223372036854775808', '-9223372036854775809', '+1', '-0', '00', '01']) {
    const raw = changeProjection(qualifiedStructureFixture(), p => ({ ...p, originals: p.originals.map(table => ({ ...table,
      rows: table.rows.map(row => ({ ...row, cells: row.cells.map((cell, index) => index === 1 ? ['integer', value] as const : cell) }))
    })) }))
    assert.throws(() => validateQualifiedKnowledgePayload2(raw), /INT64/)
  }
})
