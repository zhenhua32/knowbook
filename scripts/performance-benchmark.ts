import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { serialize } from 'node:v8'
import { KnowbookStore } from '../src/main/database/store.ts'
import { writeBackupSnapshot } from '../src/main/backup/exporter.ts'
import { encodeDocumentCatalogEntry, encodeDocumentIndexEntry } from '../src/shared/document-catalog-payload.ts'

interface BenchmarkOptions {
  documentCount: number
  blockCount: number
  includeBackupIo: boolean
}

interface BenchmarkMetric {
  name: string
  iterations: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
}

interface BenchmarkStatement {
  run(...params: unknown[]): unknown
  all(...params: unknown[]): Array<Record<string, unknown>>
}

interface BenchmarkDatabase {
  prepare(sql: string): BenchmarkStatement
  transaction<T extends (...args: never[]) => unknown>(callback: T): T
}

interface HomeProjectionInternals {
  getDefaultDocumentDatabaseId(): string
  getHomeDocumentCatalogRows(): unknown[]
  buildDocumentCatalog(columns: unknown[], databaseId: string, rows: unknown[]): unknown[]
  buildDocumentTree(rows: unknown[]): unknown[]
}

const LARGE_DOCUMENT_ID = 'performance-large-document'

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`)
  }
  return parsed
}

function readArgument(name: string): string | undefined {
  const prefix = `${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

function parseOptions(): BenchmarkOptions {
  return {
    documentCount: parsePositiveInteger(
      readArgument('--documents') ?? process.env.KNOWBOOK_BENCHMARK_DOCUMENTS,
      10_000
    ),
    blockCount: parsePositiveInteger(
      readArgument('--blocks') ?? process.env.KNOWBOOK_BENCHMARK_BLOCKS,
      1_000
    ),
    includeBackupIo: process.argv.includes('--include-backup-io')
      || process.env.KNOWBOOK_BENCHMARK_BACKUP_IO === '1'
  }
}

function percentile(sortedValues: number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)
  return sortedValues[index]
}

async function measure(
  name: string,
  iterations: number,
  callback: (iteration: number) => unknown | Promise<unknown>,
  warmupIterations = 1
): Promise<BenchmarkMetric> {
  for (let index = 0; index < warmupIterations; index += 1) {
    await callback(-index - 1)
  }

  const durations: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    await callback(index)
    durations.push(performance.now() - startedAt)
  }

  const sorted = [...durations].sort((left, right) => left - right)
  return {
    name,
    iterations,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1]
  }
}

function seedBenchmarkData(
  store: KnowbookStore,
  options: BenchmarkOptions
): { elapsedMs: number; totalDocuments: number; totalBlocks: number } {
  const database = (store as unknown as { db: BenchmarkDatabase }).db
  const insertDocument = database.prepare(`
    INSERT INTO documents (
      id, title, slug, parent_id, path, summary, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, '', ?, ?, ?)
  `)
  const insertBlock = database.prepare(`
    INSERT INTO blocks (
      id, document_id, parent_block_id, sort_order, type, content, checked,
      depth, tags_json, language, highlight, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, 'paragraph', ?, 0, 0, '[]', NULL, NULL, ?, ?)
  `)
  const timestamp = new Date('2026-01-01T00:00:00.000Z').toISOString()
  const startedAt = performance.now()

  database.transaction(() => {
    for (let index = 0; index < options.documentCount; index += 1) {
      const suffix = index.toString().padStart(5, '0')
      const documentId = `performance-document-${suffix}`
      const hasNeedle = index % 97 === 0
      const title = hasNeedle ? `Needle benchmark note ${suffix}` : `Benchmark note ${suffix}`
      const slug = `benchmark-note-${suffix}`
      insertDocument.run(documentId, title, slug, title, index + 10, timestamp, timestamp)
      insertBlock.run(
        `performance-block-${suffix}`,
        documentId,
        0,
        hasNeedle
          ? `Searchable corpus needle-performance-token record ${suffix}`
          : `Searchable common corpus record ${suffix}`,
        timestamp,
        timestamp
      )
    }

    insertDocument.run(
      LARGE_DOCUMENT_ID,
      'Large benchmark document',
      'large-benchmark-document',
      'Large benchmark document',
      options.documentCount + 20,
      timestamp,
      timestamp
    )
    for (let index = 0; index < options.blockCount; index += 1) {
      const suffix = index.toString().padStart(5, '0')
      insertBlock.run(
        `performance-large-block-${suffix}`,
        LARGE_DOCUMENT_ID,
        index,
        `Large document block ${suffix} with stable benchmark content`,
        timestamp,
        timestamp
      )
    }
  })()

  return {
    elapsedMs: performance.now() - startedAt,
    totalDocuments: options.documentCount + 4,
    totalBlocks: options.documentCount + options.blockCount + 3
  }
}

function roundMetric(metric: BenchmarkMetric): Record<string, string | number> {
  return {
    metric: metric.name,
    runs: metric.iterations,
    median_ms: metric.medianMs.toFixed(2),
    p95_ms: metric.p95Ms.toFixed(2),
    min_ms: metric.minMs.toFixed(2),
    max_ms: metric.maxMs.toFixed(2)
  }
}

async function main(): Promise<void> {
  const options = parseOptions()
  const benchmarkRoot = mkdtempSync(join(tmpdir(), 'knowbook-performance-'))
  const store = new KnowbookStore(join(benchmarkRoot, 'knowbook.db'))
  const metrics: BenchmarkMetric[] = []

  try {
    const seeded = seedBenchmarkData(store, options)
    const largeDocument = store.getDocumentDetail(LARGE_DOCUMENT_ID)
    if (!largeDocument || largeDocument.blocks.length !== options.blockCount) {
      throw new Error('Benchmark data did not initialize correctly')
    }

    let retainedResultCount = 0
    const homeProjectionInternals = store as unknown as HomeProjectionInternals
    const benchmarkDatabase = (store as unknown as { db: BenchmarkDatabase }).db
    const defaultDatabaseId = homeProjectionInternals.getDefaultDocumentDatabaseId()
    const databaseColumns = store.getDocumentDatabaseColumns(defaultDatabaseId)
    const projectionRows = homeProjectionInternals.getHomeDocumentCatalogRows()
    const homeDataForSerialization = store.getHomeData(join(benchmarkRoot, 'backup'))
    const { documentTree: _documentTree, ...homeDataPayloadForSerialization } = homeDataForSerialization
    const startupHomeDataPayloadForSerialization = store.getHomeDataPayload(join(benchmarkRoot, 'backup'))
    const tupleHomeDataPayloadForSerialization = {
      ...homeDataPayloadForSerialization,
      documentCatalog: homeDataPayloadForSerialization.documentCatalog.map(encodeDocumentCatalogEntry)
    }
    const startupTupleHomeDataPayloadForSerialization = {
      ...startupHomeDataPayloadForSerialization,
      documentCatalog: startupHomeDataPayloadForSerialization.documentCatalog.map(encodeDocumentIndexEntry)
    }
    const firstCatalogPageForSerialization = store.getDocumentCatalogPage({
      databaseId: defaultDatabaseId,
      offset: 0,
      limit: 1_000
    })
    const firstCatalogPagePayloadForSerialization = {
      ...firstCatalogPageForSerialization,
      entries: firstCatalogPageForSerialization.entries.map(encodeDocumentCatalogEntry)
    }
    const correlatedCatalogQuery = benchmarkDatabase.prepare(`
      SELECT
        documents.id,
        documents.title,
        documents.path,
        documents.summary,
        documents.parent_id,
        parents.title AS parent_title,
        documents.updated_at,
        documents.sort_order,
        (SELECT COUNT(*) FROM blocks WHERE blocks.document_id = documents.id) AS block_count,
        (SELECT COUNT(*) FROM links WHERE links.source_document_id = documents.id) AS link_count,
        (SELECT COUNT(*) FROM documents AS children WHERE children.parent_id = documents.id) AS child_count
      FROM documents
      LEFT JOIN documents AS parents ON parents.id = documents.parent_id
      ORDER BY documents.path ASC
    `)
    const baseCatalogQuery = benchmarkDatabase.prepare(`
      SELECT
        documents.id,
        documents.title,
        documents.path,
        documents.summary,
        documents.parent_id,
        parents.title AS parent_title,
        documents.updated_at,
        documents.sort_order
      FROM documents
      LEFT JOIN documents AS parents ON parents.id = documents.parent_id
      ORDER BY documents.path ASC
    `)
    const blockCountsQuery = benchmarkDatabase.prepare(`
      SELECT document_id, COUNT(*) AS block_count
      FROM blocks
      GROUP BY document_id
    `)
    const linkCountsQuery = benchmarkDatabase.prepare(`
      SELECT source_document_id, COUNT(*) AS link_count
      FROM links
      GROUP BY source_document_id
    `)
    const childCountsQuery = benchmarkDatabase.prepare(`
      SELECT parent_id, COUNT(*) AS child_count
      FROM documents
      WHERE parent_id IS NOT NULL
      GROUP BY parent_id
    `)
    metrics.push(
      await measure('global search', 25, () => {
        retainedResultCount += store.searchDocuments('needle-performance-token').length
      }, 3)
    )
    metrics.push(
      await measure('document suggestions', 25, () => {
        retainedResultCount += store.getDocumentSuggestions('Needle bench').length
      }, 3)
    )
    metrics.push(
      await measure('related-note candidates', 15, () => {
        retainedResultCount += store.getSemanticSearchCandidates({
          query: 'needle-performance-token'
        }).length
      }, 2)
    )
    metrics.push(
      await measure('plugin workspace snapshot', 5, () => {
        retainedResultCount += store.getPluginWorkspaceDocuments().length
      }, 1)
    )
    metrics.push(
      await measure('home data projection', 7, () => {
        const homeData = store.getHomeData(join(benchmarkRoot, 'backup'))
        retainedResultCount += homeData.documentCatalog.length
      }, 1)
    )
    metrics.push(
      await measure('home IPC projection', 7, () => {
        retainedResultCount += store.getHomeDataPayload(join(benchmarkRoot, 'backup')).documentCatalog.length
      }, 1)
    )
    metrics.push(
      await measure('full document catalog projection', 7, () => {
        retainedResultCount += store.getDocumentCatalog(defaultDatabaseId).length
      }, 1)
    )
    metrics.push(
      await measure('1,000-row document catalog page', 15, () => {
        retainedResultCount += store.getDocumentCatalogPage({
          databaseId: defaultDatabaseId,
          offset: 0,
          limit: 1_000
        }).entries.length
      }, 2)
    )
    metrics.push(
      await measure('paged document catalog scan', 7, () => {
        let nextOffset: number | null = 0
        while (nextOffset !== null) {
          const page = store.getDocumentCatalogPage({
            databaseId: defaultDatabaseId,
            offset: nextOffset,
            limit: 1_000
          })
          retainedResultCount += page.entries.length
          nextOffset = page.nextOffset
        }
      }, 1)
    )
    metrics.push(
      await measure('startup document index SQL', 15, () => {
        retainedResultCount += store.getDocumentIndex().length
      }, 2)
    )
    metrics.push(
      await measure('home catalog SQL aggregation', 15, () => {
        retainedResultCount += homeProjectionInternals.getHomeDocumentCatalogRows().length
      }, 2)
    )
    metrics.push(
      await measure('home correlated SQL candidate', 15, () => {
        retainedResultCount += correlatedCatalogQuery.all().length
      }, 2)
    )
    metrics.push(
      await measure('home split SQL candidate', 15, () => {
        retainedResultCount += baseCatalogQuery.all().length
        retainedResultCount += blockCountsQuery.all().length
        retainedResultCount += linkCountsQuery.all().length
        retainedResultCount += childCountsQuery.all().length
      }, 2)
    )
    metrics.push(
      await measure('home catalog field assembly', 15, () => {
        retainedResultCount += homeProjectionInternals
          .buildDocumentCatalog(databaseColumns, defaultDatabaseId, projectionRows).length
      }, 2)
    )
    metrics.push(
      await measure('home tree assembly', 25, () => {
        retainedResultCount += homeProjectionInternals.buildDocumentTree(projectionRows).length
      }, 3)
    )
    metrics.push(
      await measure('home IPC payload serialization', 15, () => {
        retainedResultCount += serialize(homeDataForSerialization).byteLength
      }, 2)
    )
    metrics.push(
      await measure('compact home IPC serialization', 15, () => {
        retainedResultCount += serialize(homeDataPayloadForSerialization).byteLength
      }, 2)
    )
    metrics.push(
      await measure('tuple home IPC serialization', 15, () => {
        retainedResultCount += serialize(tupleHomeDataPayloadForSerialization).byteLength
      }, 2)
    )
    metrics.push(
      await measure('startup home IPC serialization', 15, () => {
        retainedResultCount += serialize(startupTupleHomeDataPayloadForSerialization).byteLength
      }, 2)
    )
    metrics.push(
      await measure('1,000-row catalog IPC serialization', 15, () => {
        retainedResultCount += serialize(firstCatalogPagePayloadForSerialization).byteLength
      }, 2)
    )
    metrics.push(
      await measure('load 1,000-block document', 20, () => {
        retainedResultCount += store.getDocumentDetail(LARGE_DOCUMENT_ID)?.blocks.length ?? 0
      }, 2)
    )

    let editableBlocks = largeDocument.blocks
    metrics.push(
      await measure('single-block save in large document', 15, (iteration) => {
        const targetIndex = Math.abs(iteration) % editableBlocks.length
        editableBlocks = editableBlocks.map((block, index) =>
          index === targetIndex
            ? { ...block, content: `${block.content.replace(/ \[revision \d+\]$/, '')} [revision ${iteration + 2}]` }
            : block
        )
        store.updateDocument(LARGE_DOCUMENT_ID, {
          title: largeDocument.title,
          summary: largeDocument.summary,
          blocks: editableBlocks,
        })
      }, 2)
    )
    metrics.push(
      await measure('unchanged large-document save', 15, () => {
        store.updateDocument(LARGE_DOCUMENT_ID, {
          title: largeDocument.title,
          summary: largeDocument.summary,
          blocks: editableBlocks,
        })
      }, 2)
    )
    metrics.push(
      await measure('backup export read', 5, () => {
        retainedResultCount += store.getExportDocuments().length
      }, 1)
    )
    metrics.push(
      await measure('backup revision check', 30, () => {
        retainedResultCount += store.getBackupRevision().length
      }, 2)
    )
    metrics.push(
      await measure('backup main-thread dispatch', 30, () => {
        const job = {
          databasePath: store.getDatabasePath(),
          backupRoot: join(benchmarkRoot, 'backup')
        }
        retainedResultCount += serialize(job).byteLength
      }, 2)
    )

    if (options.includeBackupIo) {
      metrics.push(
        await measure('full Markdown backup write', 1, () => {
          writeBackupSnapshot({
            documents: store.getExportDocuments(),
            standaloneDatabases: store.getExportStandaloneDatabases(),
            backupRoot: join(benchmarkRoot, 'backup')
          })
        }, 0)
      )
    }

    const searchPlan = benchmarkDatabase
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT document_id
        FROM block_search
        WHERE content LIKE ?
        LIMIT 500
      `)
      .all('%needle-performance-token%')

    const memory = process.memoryUsage()
    console.log('\nKnowBook performance benchmark')
    console.log(
      `Dataset: ${seeded.totalDocuments.toLocaleString()} documents, ${seeded.totalBlocks.toLocaleString()} blocks; seeded in ${seeded.elapsedMs.toFixed(2)} ms`
    )
    console.table(metrics.map(roundMetric))
    console.log(`Heap used: ${(memory.heapUsed / 1024 / 1024).toFixed(1)} MiB`)
    console.log(`Retained result checksum: ${retainedResultCount}`)
    console.log('FTS query plan:', searchPlan)
    if (!options.includeBackupIo) {
      console.log('Backup disk I/O skipped; run npm run benchmark:performance:backup to include it.')
    }
  } finally {
    store.destroy()
    rmSync(benchmarkRoot, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
