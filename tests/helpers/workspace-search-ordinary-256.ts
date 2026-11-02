import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  SaveWorkspaceSearchInput,
  SavedWorkspaceSearch,
  WorkspaceSearchFacets,
  WorkspaceSearchInput,
  WorkspaceSearchMatchMode,
  WorkspaceSearchPage,
  WorkspaceSearchResult,
  WorkspaceSearchScope,
  WorkspaceSearchSort
} from '@shared/workspace-search'

const SAVED_SEARCHES_KEY = 'search.saved.v1'
const MAX_SAVED_SEARCHES = 100
const MAX_QUERY_TERMS = 32

interface NormalizedSearch extends WorkspaceSearchInput {
  scope: WorkspaceSearchScope
  matchMode: WorkspaceSearchMatchMode
  sort: WorkspaceSearchSort
  page: number
  pageSize: number
}

interface SearchRow {
  document_id: string
  document_title: string
  document_path: string
  updated_at: string
  match_type: 'title' | 'block'
  block_id: string | null
  block_type: string | null
  content: string
  tags_json: string
}

type SqlParameters = Record<string, string | number>

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength || value.includes('\0')) throw new Error(`Invalid ${label}.`)
  return value.trim()
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : text(value, label, maxLength) || undefined
}

function choice<T extends string>(value: unknown, fallback: T, values: readonly T[], label: string): T {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`Invalid ${label}.`)
  return value as T
}

function pageNumber(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid ${label}.`)
  return Math.max(1, Math.min(maximum, value))
}

function naturalDay(value: unknown, label: string): string | undefined {
  const day = optionalText(value, label, 10)
  if (!day) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Invalid ${label}.`)
  const date = new Date(`${day}T00:00:00`)
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== Number(day.slice(0, 4))
    || date.getMonth() + 1 !== Number(day.slice(5, 7)) || date.getDate() !== Number(day.slice(8, 10))) {
    throw new Error(`Invalid ${label}.`)
  }
  return day
}

// Renderer and plugin payloads cross a process boundary. Validate again here,
// in the main-process repository, rather than trusting TypeScript callers.
export function normalizeWorkspaceSearchInput(value: unknown): NormalizedSearch {
  const input = record(value, 'search input')
  const query = text(input.query, 'search query', 2000)
  const normalized: NormalizedSearch = {
    query,
    scope: choice(input.scope, 'all', ['all', 'documents', 'blocks'], 'search scope'),
    matchMode: choice(input.matchMode, 'all', ['all', 'any', 'phrase'], 'search match mode'),
    sort: choice(input.sort, 'relevance', ['relevance', 'updated-desc', 'updated-asc'], 'search sort'),
    page: pageNumber(input.page, 1, 1_000_000, 'search page'),
    pageSize: pageNumber(input.pageSize, 25, 100, 'search page size')
  }
  const folderId = input.folderId === null ? undefined : optionalText(input.folderId, 'search folder', 200)
  const tag = optionalText(input.tag, 'search tag', 200)
  const blockType = optionalText(input.blockType, 'search block type', 100)
  const updatedFrom = naturalDay(input.updatedFrom, 'search start date')
  const updatedTo = naturalDay(input.updatedTo, 'search end date')
  if (updatedFrom && updatedTo && updatedFrom > updatedTo) throw new Error('Search start date must not follow end date.')
  if (folderId) normalized.folderId = folderId
  if (tag) normalized.tag = tag
  if (blockType) normalized.blockType = blockType
  if (updatedFrom) normalized.updatedFrom = updatedFrom
  if (updatedTo) normalized.updatedTo = updatedTo
  if (queryTerms(normalized).length > MAX_QUERY_TERMS) throw new Error(`Search supports up to ${MAX_QUERY_TERMS} terms.`)
  return normalized
}

function queryTerms(input: NormalizedSearch): string[] {
  if (!input.query) return []
  if (input.matchMode === 'phrase') return [input.query]
  const unique = new Map<string, string>()
  for (const term of input.query.split(/\s+/u)) unique.set(term.toLowerCase(), term)
  return [...unique.values()]
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function quotedFtsTerm(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function dayBoundary(day: string, followingDay = false): string {
  const date = new Date(`${day}T00:00:00`)
  if (followingDay) date.setDate(date.getDate() + 1)
  return date.toISOString()
}

function safeTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function snippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase()
  const offsets = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((offset) => offset >= 0)
  const start = Math.max(0, (offsets.length ? Math.min(...offsets) : 0) - 40)
  return (start > 0 ? '…' : '') + content.slice(start, start + 180) + (content.length > start + 180 ? '…' : '')
}

export class WorkspaceSearchRepository {
  constructor(private readonly db: Database.Database) {}

  search(rawInput: WorkspaceSearchInput): WorkspaceSearchPage {
    const input = normalizeWorkspaceSearchInput(rawInput)
    const terms = queryTerms(input)
    const longTerms = terms.filter((term) => [...term].length >= 3)
    const shortTerms = terms.filter((term) => [...term].length < 3)
    const parameters: SqlParameters = { query: input.query, prefix: `${escapeLike(input.query)}%` }
    const ctes: string[] = []
    const documentFilters: string[] = []
    if (input.folderId) {
      parameters.folderId = input.folderId
      ctes.push(`folder_documents(id) AS (
        SELECT id FROM documents WHERE id = :folderId
        UNION
        SELECT d.id FROM documents d JOIN folder_documents f ON d.parent_id = f.id
      )`)
      documentFilters.push('d.id IN (SELECT id FROM folder_documents)')
    }
    if (input.updatedFrom) {
      parameters.updatedFrom = dayBoundary(input.updatedFrom)
      documentFilters.push('d.updated_at >= :updatedFrom')
    }
    if (input.updatedTo) {
      parameters.updatedTo = dayBoundary(input.updatedTo, true)
      documentFilters.push('d.updated_at < :updatedTo')
    }

    const blockFilters = (alias: string): string[] => {
      const filters: string[] = []
      if (input.blockType) {
        parameters.blockType = input.blockType
        filters.push(`${alias}.type = :blockType`)
      }
      if (input.tag) {
        parameters.tag = input.tag
        filters.push(`EXISTS (SELECT 1 FROM json_each(${alias}.tags_json) tag WHERE tag.value = :tag)`)
      }
      return filters
    }

    const shortPredicate = (kind: 'document' | 'block'): string => {
      const columns = kind === 'document' ? ['d.title', 'd.path', 'd.summary'] : ['b.content']
      const predicates = shortTerms.map((term, index) => {
        const key = `${kind}Short${index}`
        parameters[key] = `%${escapeLike(term)}%`
        return `(${columns.map((column) => `${column} LIKE :${key} ESCAPE '\\'`).join(' OR ')})`
      })
      return predicates.join(input.matchMode === 'any' ? ' OR ' : ' AND ')
    }

    // Long literal terms use the existing trigram FTS index. A mixed "any"
    // query unions short-term LIKE candidates with the indexed hits, retaining
    // all candidates before SQL COUNT and pagination. MATERIALIZED keeps bm25
    // evaluation in the FTS MATCH context, including COUNT queries.
    const matches = (kind: 'document' | 'block'): { join: string; where: string; score: string } => {
      const short = shortPredicate(kind)
      if (!longTerms.length) return { join: '', where: short, score: '0' }
      const table = kind === 'document' ? 'document_search' : 'block_search'
      const idColumn = kind === 'document' ? 'document_id' : 'block_id'
      const alias = kind === 'document' ? 'd' : 'b'
      const key = `${kind}Match`
      parameters[key] = longTerms.map(quotedFtsTerm).join(input.matchMode === 'any' ? ' OR ' : ' AND ')
      const weights = kind === 'document' ? ', 0, 8, 1, 2' : ', 0, 0, 1'
      ctes.push(`${kind}_fts AS MATERIALIZED (
        SELECT ${idColumn} AS id, bm25(${table}${weights}) AS score
        FROM ${table} WHERE ${table} MATCH :${key}
      )`)
      let hits = `${kind}_fts`
      if (short && input.matchMode === 'any') {
        const from = kind === 'document' ? 'documents d' : 'blocks b'
        ctes.push(`${kind}_hits AS (
          SELECT id, MIN(score) AS score FROM (
            SELECT id, score FROM ${kind}_fts
            UNION ALL SELECT ${alias}.id, 0 AS score FROM ${from} WHERE ${short}
          ) GROUP BY id
        )`)
        hits = `${kind}_hits`
      }
      return {
        join: `JOIN ${hits} hit ON hit.id = ${alias}.id`,
        where: input.matchMode === 'any' ? '' : short,
        score: 'hit.score'
      }
    }

    const selects: string[] = []
    const hasBlockFilter = Boolean(input.tag || input.blockType)
    if (input.scope !== 'blocks') {
      const match = matches('document')
      const filters = [...documentFilters]
      const filteredBlocks = blockFilters('fb')
      if (filteredBlocks.length) {
        // A document must have ONE block satisfying both tag and type, rather
        // than satisfying the two conditions on unrelated blocks.
        filters.push(`EXISTS (SELECT 1 FROM blocks fb WHERE fb.document_id = d.id AND ${filteredBlocks.join(' AND ')})`)
      }
      if (match.where) filters.push(`(${match.where})`)
      selects.push(`SELECT d.id AS document_id, d.title AS document_title, d.path AS document_path,
        d.updated_at, 'title' AS match_type, NULL AS block_id, NULL AS block_type,
        d.summary AS content,
        (SELECT json_group_array(value) FROM (
          SELECT DISTINCT tag.value AS value FROM blocks tb, json_each(tb.tags_json) tag
          WHERE tb.document_id = d.id AND tag.type = 'text'
          ORDER BY value COLLATE NOCASE, value
        )) AS tags_json,
        ${hasBlockFilter ? '1' : `CASE WHEN d.title = :query COLLATE NOCASE THEN 0 WHEN d.title LIKE :prefix ESCAPE '\\' THEN 1 ELSE 2 END`} AS priority,
        ${match.score} AS score, -1 AS block_order
        FROM documents d ${match.join} ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}`)
    }
    if (input.scope !== 'documents') {
      const match = matches('block')
      const filters = [...documentFilters, ...blockFilters('b')]
      if (match.where) filters.push(`(${match.where})`)
      selects.push(`SELECT d.id AS document_id, d.title AS document_title, d.path AS document_path,
        d.updated_at, 'block' AS match_type, b.id AS block_id, b.type AS block_type,
        b.content, b.tags_json, ${hasBlockFilter ? '0' : '3'} AS priority,
        ${match.score} AS score, b.sort_order AS block_order
        FROM blocks b JOIN documents d ON d.id = b.document_id ${match.join}
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}`)
    }
    ctes.push(`results AS (${selects.join(' UNION ALL ')})`)
    const sql = `WITH RECURSIVE ${ctes.join(',\n')}`
    const order = input.sort === 'updated-desc' ? 'updated_at DESC'
      : input.sort === 'updated-asc' ? 'updated_at ASC' : 'priority ASC, score ASC, updated_at DESC'
    const total = (this.db.prepare(`${sql} SELECT COUNT(*) AS count FROM results`).get(parameters) as { count: number }).count
    // A delete or concurrent edit can make a previously valid page disappear.
    // Return the final remaining page so the UI never mistakes it for no hits.
    const page = Math.min(input.page, Math.max(1, Math.ceil(total / input.pageSize)))
    const rows = this.db.prepare(`${sql} SELECT * FROM results
      ORDER BY ${order}, document_path COLLATE NOCASE, document_path, document_id, block_order, block_id
      LIMIT :limit OFFSET :offset`).all({ ...parameters, limit: input.pageSize, offset: (page - 1) * input.pageSize }) as SearchRow[]
    const items: WorkspaceSearchResult[] = rows.map((row) => ({
      documentId: row.document_id,
      documentTitle: row.document_title,
      documentPath: row.document_path,
      matchType: row.match_type,
      snippet: snippet(row.content, terms),
      updatedAt: row.updated_at,
      tags: safeTags(row.tags_json),
      ...(row.block_id ? { blockId: row.block_id, blockType: row.block_type! } : {})
    }))
    return { items, total, page, pageSize: input.pageSize, queryTerms: terms }
  }

  facets(): WorkspaceSearchFacets {
    const tags = this.db.prepare(`SELECT DISTINCT tag.value AS value
      FROM blocks b JOIN documents d ON d.id = b.document_id, json_each(b.tags_json) tag
      WHERE tag.type = 'text' ORDER BY value COLLATE NOCASE, value`).all() as Array<{ value: string }>
    const types = this.db.prepare(`SELECT DISTINCT b.type AS value FROM blocks b
      JOIN documents d ON d.id = b.document_id ORDER BY value COLLATE NOCASE, value`).all() as Array<{ value: string }>
    return { tags: tags.map((row) => row.value), blockTypes: types.map((row) => row.value) }
  }

  listSaved(): SavedWorkspaceSearch[] {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SAVED_SEARCHES_KEY) as { value: string } | undefined
    if (!row) return []
    let parsed: unknown
    try { parsed = JSON.parse(row.value) } catch { return [] }
    if (!Array.isArray(parsed)) return []
    const saved: SavedWorkspaceSearch[] = []
    const seen = new Set<string>()
    for (const entry of parsed.slice(0, MAX_SAVED_SEARCHES)) {
      try {
        const item = record(entry, 'saved search')
        const id = text(item.id, 'saved search ID', 200)
        const name = text(item.name, 'saved search name', 80)
        if (!id || !name || seen.has(id)) continue
        const input = normalizeWorkspaceSearchInput(item.input)
        input.page = 1
        saved.push({ id, name, input })
        seen.add(id)
      } catch { /* A malformed preference must not prevent loading valid saved searches. */ }
    }
    return saved
  }

  save(rawInput: SaveWorkspaceSearchInput): SavedWorkspaceSearch {
    const value = record(rawInput, 'saved search input')
    const name = text(value.name, 'saved search name', 80)
    if (!name) throw new Error('Saved search name is required.')
    const input = normalizeWorkspaceSearchInput(value.input)
    input.page = 1
    const id = value.id === undefined ? randomUUID() : text(value.id, 'saved search ID', 200)
    if (!id) throw new Error('Saved search ID is required.')
    const saved = this.listSaved()
    const index = saved.findIndex((entry) => entry.id === id)
    if (value.id !== undefined && index < 0) throw new Error('Saved search not found.')
    if (index < 0 && saved.length >= MAX_SAVED_SEARCHES) throw new Error(`You can save up to ${MAX_SAVED_SEARCHES} searches.`)
    const result = { id, name, input }
    if (index < 0) saved.push(result)
    else saved[index] = result
    this.writeSaved(saved)
    return result
  }

  deleteSaved(rawId: string): void {
    const id = text(rawId, 'saved search ID', 200)
    if (!id) throw new Error('Saved search ID is required.')
    this.writeSaved(this.listSaved().filter((entry) => entry.id !== id))
  }

  private writeSaved(saved: SavedWorkspaceSearch[]): void {
    this.db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(SAVED_SEARCHES_KEY, JSON.stringify(saved), new Date().toISOString())
  }
}
