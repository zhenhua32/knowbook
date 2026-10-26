import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { capsuleBytesHash, capsuleJson } from '../../src/main/database/restore-knowledge-capsule-model'
import { prepareCapsule2AssetArchive } from '../../src/main/database/restore-knowledge-capsule2-asset-archive'
import { captureSealedCapsule2SourceFromArchive } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureActualFirstRequiredSqlDag } from '../../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import { referenceContextCatalogPath } from '../../src/main/database/restore-knowledge-qualified-original-model'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { withQualifiedNestedFixture } from './qualified-originals-minimal-fixture'
import { addOriginalReferenceSyntax, nextQualifiedBundle, type SourceProfile } from './qualified-originals-fixture'
import { allTables, randomUUID } from './synced-backup-v3-fixture'

export interface CompleteSqlReadObservation {
  databasePath: string; readonly: boolean; queryOnly: unknown; foreignKeys: unknown; inTransaction: boolean;
  totalChangesBefore: number; totalChangesAfter: number; completed: boolean
}
/** Observe the existing native transaction boundary. The actual Main callback
 * executes unchanged and supplies every returned value. No result DTO, source
 * selector, callback or bypass enters a production factory. */
export function observeCompleteSqlReads(t: TestContext) {
  const observations: CompleteSqlReadObservation[] = []
  const transaction = Database.prototype.transaction
  const observer = function (this: Database.Database, fn: (...args: unknown[]) => unknown) {
    if (!Function.prototype.toString.call(fn).includes('readRawCapsule2SourceKnowledgeOwned'))
      return Reflect.apply(transaction, this, [fn])
    const db = this
    return Reflect.apply(transaction, db, [function (this: unknown, ...args: unknown[]) {
      const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
      const observation = { databasePath: db.name, readonly: db.readonly, queryOnly: db.pragma('query_only', { simple: true }),
        foreignKeys: db.pragma('foreign_keys', { simple: true }), inTransaction: db.inTransaction,
        totalChangesBefore: changes(), totalChangesAfter: -1, completed: false }
      observations.push(observation)
      try {
        const value = Reflect.apply(fn, this, args)
        observation.completed = true
        return value
      } finally { observation.totalChangesAfter = changes() }
    }])
  }
  t.mock.method(Database.prototype, 'transaction', observer as typeof Database.prototype.transaction)
  return {
    observations,
    async measure<T>(run: () => Promise<T>) {
      const start = observations.length, value = await run()
      return { value, observations: observations.slice(start) }
    }
  }
}

async function completeSource(profile: SourceProfile) {
  const original = await captureAssetOriginal(profile), archive = await prepareCapsule2AssetArchive(original.original)
  const captured = await captureSealedCapsule2SourceFromArchive(archive), certified = await certifyCapsule2Source(captured.source)
  assert.equal(certified.status, 'certified-without-prior-coverage')
  return { original, handle: certified.source, packet: captured.value }
}
export async function withContent3JointReadFixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  return withQualifiedNestedFixture(async f => run(await setup(f)))
}
async function setup(f: Parameters<Parameters<typeof withQualifiedNestedFixture>[0]>[0]) {
  f.source.store.saveSetting('joint.read.phase', 'source')
  const left = await completeSource(f.source)
  f.source.store.saveSetting('joint.read.phase', 'current')
  const right = await completeSource(f.source)
  const dag = await captureActualFirstRequiredSqlDag({ profileRoot: f.source.userDataRoot,
    operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
  const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
  const mixed = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: f.receiver.userDataRoot,
    operationId: randomUUID(), sourceDirectory: exported.directory })
  addOriginalReferenceSyntax(f.source, f.value.originalRoot)
  const qualified = await nextQualifiedBundle(f.source, [{ bundle: f.handle, original: f.value.originalRoot }], right, undefined, true)
  assert.ok(qualified.knowledgePlan)
  const bound = qualified.value.inputs.find(input => input.origin.kind === 'bound-original-bundle')!
  assert.equal(bound.origin.kind, 'bound-original-bundle')
  const path = referenceContextCatalogPath(bound.binding, bound.origin.mountId)
  const contextFile = qualified.originalPackage.files.find(file => !file.frame.length && file.path === path)!
  assert.ok(contextFile)
  return { ...f, left, right, mixed, qualified, contextFile,
    expectedMixed: { originalPackage: mixed.originalPackage, source: left.packet, current: right.packet },
    expectedQualified: { originalPackage: qualified.originalPackage, source: qualified.sealed.actual.value, current: right.packet },
    beforeSource: allTables(f.source.db), beforeReceiver: allTables(f.receiver.db) }
}

/** Local diagnostic support only: load the frozen pre-change implementation
 * as actual code, remapping only AST import targets. The caller must supply
 * archived source bytes; the ordinary regression test never needs Git history.
 * All genuine SQL owners remain in their real modules. Qualified legacy owners
 * can be cold-minted by this module from the same actual mount locator. */
export async function loadContent3JointReadBaseline(source: string) {
  const ts = (await import('typescript')).default
  const originalFile = resolve('src/main/database/restore-knowledge-qualified-originals.ts')
  function targets(text: string) {
    const ast = ts.createSourceFile(originalFile, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const ranges = new Map<number, { from: number; to: number; target: string }>()
    const add = (literal: import('typescript').StringLiteralLike) => {
      if (!literal.text.startsWith('.') && !literal.text.startsWith('file:')) return
      ranges.set(literal.getStart(ast), { from: literal.getStart(ast), to: literal.end, target: literal.text })
    }
    const visit = (node: import('typescript').Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) add(node.moduleSpecifier)
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0])
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) add(node.argument.literal)
      ts.forEachChild(node, visit)
    }
    visit(ast)
    return [...ranges.values()].sort((a, b) => a.from - b.from)
  }
  const imports = targets(source)
  let remapped = source
  for (const item of [...imports].reverse()) {
    const target = item.target.startsWith('file:') ? item.target : pathToFileURL(resolve(dirname(originalFile),
      item.target.endsWith('.ts') ? item.target : item.target + '.ts')).href
    remapped = remapped.slice(0, item.from) + JSON.stringify(target) + remapped.slice(item.to)
  }
  const normalize = (text: string) => {
    for (const item of targets(text).reverse()) text = text.slice(0, item.from) + '"__ONLY_IMPORT_TARGET__"' + text.slice(item.to)
    return text
  }
  assert.equal(normalize(source), normalize(remapped))
  const workspace = resolve('.')
  const chain = async (directory: string) => {
    const absolute = resolve(directory)
    let cursor = parse(absolute).root
    for (const part of relative(cursor, absolute).split(sep).filter(Boolean)) {
      cursor = join(cursor, part)
      const info = await lstat(cursor)
      assert.equal(info.isDirectory(), true)
      assert.equal(info.isSymbolicLink(), false, 'Diagnostic parent chains must contain no symlink or junction')
      assert.equal(await realpath(cursor), cursor)
    }
  }
  const makeDirectory = async (path: string) => {
    try { await mkdir(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await chain(path)
  }
  await chain(workspace)
  await makeDirectory(join(workspace, '.tmp'))
  const parent = join(workspace, '.tmp', 'content3-joint-read')
  await makeDirectory(parent)
  const directory = await mkdtemp(join(parent, 'baseline-'))
  await chain(directory)
  const path = join(directory, 'qualified-originals-before.ts')
  await writeFile(path, remapped, { flag: 'wx' })
  assert.equal(await readFile(path, 'utf8'), remapped)
  const dispose = async () => {
    assert.equal(dirname(directory), parent)
    await chain(directory)
    const file = await lstat(path)
    assert.equal(file.isFile(), true)
    assert.equal(file.isSymbolicLink(), false)
    assert.equal(file.nlink, 1)
    await unlink(path)
    await rmdir(directory) // Only this known file and its now-empty directory.
  }
  let module: typeof import('../../src/main/database/restore-knowledge-qualified-originals')
  try { module = await import(pathToFileURL(path).href) as typeof module }
  catch (error) { await dispose(); throw error }
  return { module, path, proof: { originalSha256: capsuleBytesHash(source), remappedSha256: capsuleBytesHash(remapped),
    changedImportTargets: imports.length, everyOtherSourceByteUnchanged: true }, dispose }
}
export const wholeContent3PairHash = (value: unknown) => capsuleBytesHash(capsuleJson(value))
