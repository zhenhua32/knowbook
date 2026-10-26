import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreNavigationRewriteInputs3, readRootRestoreNavigationRewriteInputs3 } from '../src/main/database/restore-knowledge-navigation3-read'
import { deriveRootRestoreNavigationRewriteInputs3 } from '../src/main/database/restore-knowledge-navigation3-model'
import { RestoreGraph3Conflict, type Graph3Inputs } from '../src/main/database/restore-knowledge-graph3-data'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { tamperContent3VerificationOriginals } from './helpers/content3-fixture'
import { withNavigation3Fixture } from './helpers/navigation3-fixture'

type Value = Awaited<ReturnType<typeof prepareRootRestoreNavigationRewriteInputs3>>['value']
type Scope = Value['scopes'][number]
function scopeFor(value: Value, id: string, field: Scope['field']) {
  const entries = value.scopes.filter(scope => scope.document.id === id && scope.field === field)
  assert.equal(entries.length, 1)
  return entries[0]
}
function destination(scope: Scope, blockId: string, raw: string) {
  const entries = scope.destinations.filter(item => item.location.blockId === blockId && item.key.raw === raw)
  assert.equal(entries.length, 1, 'The oracle addresses the exact original block/range, never only an equal URL')
  return entries[0]
}

test('actual complete originals capture ordinary navigation by exact scope range birth route and expanded heading occurrence', t =>
  withNavigation3Fixture(async f => {
    const n = f.navigation, identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const prepared = await prepareRootRestoreNavigationRewriteInputs3(identity.plan), value = prepared.value
    const body = scopeFor(value, n.hostId, 'body'), summary = scopeFor(value, n.hostId, 'summary')
    await t.test('all source body and summary scopes bind real physical births while current same-path occupants remain separate', () => {
      const originals = f.sourcePacket.source.physical.documents
      assert.equal(value.scopes.length, originals.length * 2)
      assert.equal(value.headingNamespaces.length, originals.length)
      for (const scope of value.scopes) {
        const original = originals.find(document => document.documentId === scope.document.id)
        assert.ok(original)
        const allocation = identity.value.assignments.filter(item => item.kind === 'document' && item.physical
          && item.sourceId === original.documentId && item.birth === original.createdAt)
        assert.equal(allocation.length, 1)
        assert.equal(scope.document.birth, original.createdAt)
        assert.equal(scope.document.assignmentKey, allocation[0].key)
        assert.equal(scope.document.targetId, allocation[0].targetId)
        assert.equal(scope.path, original.path)
        assert.equal(scope.title, original.title)
      }
      const currentAtOriginalPath = f.currentPacket.source.physical.documents.filter(document => document.path === 'Navigation Target')
      assert.deepEqual(currentAtOriginalPath.map(document => document.documentId), [n.foreignId])
      const direct = body.destinations.find(item => item.location.blockId === n.directId && item.grammar.syntax !== 'html')!
      assert.equal(direct.target.kind, 'heading')
      if (direct.target.kind === 'heading') assert.equal(direct.target.document.id, n.targetId)
      assert.equal(value.sourceMaterialHash, f.sourcePacket.materialHash)
      assert.equal(value.currentMaterialHash, f.currentPacket.materialHash)
      assert.equal(value.identityAllocationHash, identity.value.allocationHash)
    })
    await t.test('cross-block references use their first actual definition and the summary never inherits the body definition environment', () => {
      const use = body.blocks.find(item => item.location.blockId === n.bodyUseId)!
      const first = body.blocks.find(item => item.location.blockId === n.definitionId)!
      const inactive = body.blocks.find(item => item.location.blockId === n.inactiveDefinitionId)!
      assert.equal(body.definitions.filter(item => item.kind === 'reference').length, 2)
      assert.ok(body.definitions.some(item => item.blockId === first.occurrenceKey))
      assert.ok(body.definitions.some(item => item.blockId === inactive.occurrenceKey))
      const effective = body.effectiveDefinitions.find(item => item.definition.blockId === first.occurrenceKey)
      assert.ok(effective)
      assert.equal(body.effectiveDefinitions.some(item => item.definition.blockId === inactive.occurrenceKey), false)
      assert.deepEqual(body.uses.find(item => item.blockId === use.occurrenceKey)!.definitions, [effective.key])
      const activeDestination = destination(body, n.definitionId, '/Navigation%20Target.md#live-heading')
      assert.equal(activeDestination.key.from, n.definition.indexOf('/Navigation%20Target.md#live-heading'))
      assert.equal(activeDestination.target.kind, 'heading')
      if (activeDestination.target.kind === 'heading') assert.equal(activeDestination.target.document.id, n.targetId)
      assert.equal(destination(body, n.inactiveDefinitionId, '/Never%20Active.md#wrong').target.kind, 'unresolved')
      assert.equal(body.destinations.some(item => item.location.blockId === n.bodyUseId), false, 'Reference uses do not invent a second physical destination')
      assert.deepEqual(summary.definitions, [])
      assert.deepEqual(summary.effectiveDefinitions, [])
      assert.equal(summary.destinations.length, 1)
      const direct = summary.destinations[0]
      assert.equal(direct.location.table, 'documents')
      assert.equal(direct.location.column, 'summary')
      assert.equal(direct.location.blockId, null)
      assert.equal(direct.key.from, n.summary.indexOf('/Navigation%20Target.md#live-heading'))
      assert.equal(n.summary.slice(direct.key.from, direct.key.to), direct.key.raw)
    })
    await t.test('same-URL Markdown and HTML destinations retain separate exact UTF16 CRLF coordinates and opaque code remains literal', () => {
      const block = body.blocks.find(item => item.location.blockId === n.directId)!
      assert.equal(block.block.content, n.direct)
      const links = body.destinations.filter(item => item.location.blockId === n.directId).sort((a, b) => a.key.from - b.key.from)
      assert.equal(links.length, 2)
      const expected = [...n.direct.matchAll(/\/Navigation%20Target\.md#live-heading/g)].map(match => match.index)
      assert.deepEqual(links.map(item => item.key.from), expected)
      assert.notEqual(links[0].key.from, links[1].key.from)
      assert.equal(links[1].grammar.syntax, 'html')
      for (const link of links) {
        assert.equal(link.key.syntax, 'markdown')
        assert.equal(n.direct.slice(link.key.from, link.key.to), '/Navigation%20Target.md#live-heading')
        assert.equal(link.key.raw, n.direct.slice(link.key.from, link.key.to))
        assert.equal(link.target.kind, 'heading')
        if (link.target.kind === 'heading') assert.equal(link.target.document.id, n.targetId)
      }
      assert.equal(body.destinations.some(item => item.location.blockId === n.opaqueCodeId), false)
      assert.equal(body.blocks.find(item => item.location.blockId === n.opaqueCodeId)!.block.content, '[opaque](/Navigation%20Target.md)')
    })
    await t.test('one canonical heading appearing twice has two instance-qualified heading identities and external canonical links stay opaque', () => {
      const namespace = value.headingNamespaces.find(item => item.document.id === n.repeatedHostId)!
      const headings = namespace.headings.filter(item => item.location?.blockId === n.repeatedCanonicalHeadingId)
      assert.deepEqual(headings.map(item => item.slug), ['echo', 'echo-1'])
      assert.deepEqual(headings.map(item => item.location!.instanceId), n.repeatedInstanceIds)
      assert.notEqual(headings[0].key, headings[1].key)
      assert.equal(headings[0].location!.blockIdentity!.assignmentKey, headings[1].location!.blockIdentity!.assignmentKey)
      assert.notEqual(headings[0].location!.instanceIdentity!.assignmentKey, headings[1].location!.instanceIdentity!.assignmentKey)
      for (const [index, slug] of ['echo', 'echo-1'].entries()) {
        const link = destination(body, n.contextualId, '/Navigation%20Repeated.md#' + slug)
        assert.equal(link.target.kind, 'heading')
        if (link.target.kind === 'heading') {
          assert.equal(link.target.document.id, n.repeatedHostId)
          assert.equal(link.target.headingKey, headings[index].key)
          assert.equal(link.target.location!.instanceId, n.repeatedInstanceIds[index])
        }
      }
      const repeated = scopeFor(value, n.repeatedHostId, 'body')
      const external = repeated.destinations.filter(item => item.location.blockId === n.repeatedCanonicalExternalId)
      assert.equal(external.length, 2)
      assert.deepEqual(external.map(item => item.location.instanceId), n.repeatedInstanceIds)
      for (const link of external) assert.equal(link.target.kind, 'opaque')
    })
    await t.test('only an exact old route may reach a moved physical block and a bare global UUID cannot bypass its declared document', () => {
      const route = destination(body, n.contextualId, '/Navigation%20Old.md#^' + n.routeBlockId)
      assert.equal(route.target.kind, 'block')
      if (route.target.kind === 'block') {
        assert.equal(route.target.document.id, n.routeCurrentOwnerId)
        assert.equal(route.target.block.id, n.routeBlockId)
        assert.equal(route.target.route!.path, n.routeFromPath)
        assert.equal(route.target.route!.blockId, n.routeBlockId)
        assert.equal(route.target.block.ownerId, n.routeCurrentOwnerId)
      }
      const wrongOwner = destination(body, n.contextualId, '/Navigation%20Target.md#^' + n.foreignBlockId)
      assert.equal(wrongOwner.target.kind, 'unresolved')
      if (wrongOwner.target.kind === 'unresolved') {
        assert.equal(wrongOwner.target.reason, 'missing-block')
        assert.equal(wrongOwner.target.preserveUnresolved, true)
      }
      const exactInAmbiguousPath = destination(body, n.contextualId, '/Navigation%20Duplicate.md#^' + n.ambiguousBodyA)
      assert.equal(exactInAmbiguousPath.target.kind, 'block')
      if (exactInAmbiguousPath.target.kind === 'block') {
        assert.equal(exactInAmbiguousPath.target.document.id, n.ambiguousDocumentIds[0])
        assert.equal(exactInAmbiguousPath.target.block.id, n.ambiguousBodyA)
      }
      const exactBare = destination(body, n.contextualId, n.directId)
      assert.equal(exactBare.target.kind, 'block')
      if (exactBare.target.kind === 'block') {
        assert.equal(exactBare.target.document.id, n.hostId)
        assert.equal(exactBare.target.block.id, n.directId)
        assert.equal(exactBare.target.route, null)
      }
      assert.equal(destination(body, n.contextualId, '^' + n.directId).target.kind, 'unresolved', 'A bare wiki token does not strip caret to invent a local ID')
      const bareRoute = destination(body, n.contextualId, '^' + n.bareWikiMovedId)
      assert.equal(bareRoute.target.kind, 'block')
      if (bareRoute.target.kind === 'block') {
        assert.equal(bareRoute.target.block.id, n.bareWikiMovedId)
        assert.equal(bareRoute.target.document.id, n.targetId)
        assert.equal(bareRoute.target.route!.path, 'Navigation Host')
      }
      const markdownUuid = destination(body, n.contextualId, '/Navigation%20Target.md#' + n.uuidHeadingText)
      assert.equal(markdownUuid.target.kind, 'heading')
      if (markdownUuid.target.kind === 'heading') assert.equal(markdownUuid.target.location!.blockId, n.uuidHeadingId)
      const wikiUuid = destination(body, n.contextualId, 'Navigation Target#' + n.uuidHeadingText)
      assert.equal(wikiUuid.target.kind, 'unresolved')
      if (wikiUuid.target.kind === 'unresolved') assert.equal(wikiUuid.target.reason, 'missing-block')
    })
    await t.test('path and title ambiguities retain every candidate while ASCII fallback never folds non-ASCII identities', () => {
      for (const raw of ['/Navigation%20Duplicate.md', '/Navigation%20Duplicate.md#navigation-twin', 'navigation duplicate', 'Navigation Twin']) {
        const link = destination(body, n.contextualId, raw)
        assert.equal(link.target.kind, 'unresolved')
        if (link.target.kind === 'unresolved') {
          assert.ok(['ambiguous-path', 'ambiguous-title'].includes(link.target.reason))
          assert.deepEqual(link.target.candidates.map(item => item.id).sort(), [...n.ambiguousDocumentIds].sort())
          assert.equal(link.target.preserveUnresolved, true)
        }
      }
      const markdownCase = destination(body, n.contextualId, '/navigation%20duplicate.md')
      assert.equal(markdownCase.target.kind, 'unresolved')
      if (markdownCase.target.kind === 'unresolved') assert.equal(markdownCase.target.reason, 'missing-document')
      const own = scopeFor(value, n.ambiguousDocumentIds[0], 'body')
      assert.equal(destination(own, n.ambiguousBodyA, '/Navigation%20Duplicate.md').target.kind, 'unresolved')
      const bare = destination(own, n.ambiguousBodyA, '#navigation-twin')
      assert.equal(bare.target.kind, 'heading')
      if (bare.target.kind === 'heading') assert.equal(bare.target.document.id, n.ambiguousDocumentIds[0])
      const unicode = destination(body, n.contextualId, 'ÄPFEL')
      assert.equal(unicode.target.kind, 'document')
      if (unicode.target.kind === 'document') assert.equal(unicode.target.document.id, n.unicodeUpperId)
    })
    await t.test('old canonical targets remain captured hints and templates stay deferred without becoming live source scopes', () => {
      const host = scopeFor(value, f.source.hostId, 'body')
      const captured = host.destinations.find(item => item.target.kind === 'captured-binding' && item.target.binding.target.kind === 'heading'
        && item.target.binding.target.documentId === f.source.targetId)
      assert.ok(captured)
      assert.equal(captured.target.kind, 'captured-binding')
      if (captured.target.kind === 'captured-binding') {
        assert.equal(captured.target.hintsOnly, true)
        assert.equal(captured.target.binding.target.kind, 'heading')
        if (captured.target.binding.target.kind === 'heading') assert.equal(captured.target.binding.target.state, 'live')
      }
      assert.equal(value.templateNavigationCaptured, false)
      assert.equal(value.scopes.some(scope => scope.document.id === n.templateId), false)
      assert.equal(value.scopes.some(scope => scope.destinations.some(item => item.url.includes('Template%20Late') || item.url.includes('{{title}}'))), false)
      assert.equal(f.source.store.listDocumentTemplates().find(item => item.id === n.templateId)!.blocks[0].content, n.templateContent)
      assert.equal(n.templateBlockId, f.source.hostBodyId, 'A template may spell a physical ID without gaining that owner')
      for (const flag of ['finalLayoutApplied', 'referenceRewriteComplete', 'semanticValidationComplete', 'acceptedCoverage', 'effective', 'permit'] as const)
        assert.equal(value[flag], false)
    })
    await t.test('existing finite budgets reject occurrence multiplication before materializing or parsing its expanded forest', () => {
      // Deliberate pure-model rejection fixtures. Only the needed original
      // source/allocation is copied; this DTO cannot mint a Main owner. Repeated
      // placeholder IDs are intentionally invalid later: budget rejection must
      // happen before that graph traversal, without allocating the product.
      const rejection = (code: string, change: (data: Graph3Inputs) => void) => {
        const data = structuredClone({ inputs: { source: f.sourcePacket }, value: identity.value }) as Graph3Inputs
        change(data)
        assert.throws(() => deriveRootRestoreNavigationRewriteInputs3(data), (error: unknown) => {
          assert.ok(error instanceof RestoreGraph3Conflict)
          assert.equal(error.code, code)
          return true
        })
      }
      rejection('navigation-expanded-host-block-budget', data => {
        const physical = data.inputs.source.source.physical
        const host = physical.documents.find(document => document.documentId === n.repeatedHostId)!
        const group = physical.groups.find(group => group.groupId === n.repeatedGroupId)!.snapshot!
        const placeholder = host.blocks.find(block => block.type === 'synced-block')!
        assert.ok(group.blocks.length > 1)
        host.blocks = Array.from({ length: Math.floor(100_000 / group.blocks.length) + 1 }, () => placeholder)
      })
      rejection('complete-navigation-input-budget', data => {
        const physical = data.inputs.source.source.physical
        const host = physical.documents.find(document => document.documentId === n.repeatedHostId)!
        const group = physical.groups.find(group => group.groupId === n.repeatedGroupId)!.snapshot!
        const placeholder = host.blocks.find(block => block.type === 'synced-block')!
        group.blocks[0].content = 'x'.repeat(1024 * 1024)
        host.blocks = Array.from({ length: 129 }, () => placeholder)
      })
    })
    await t.test('private navigation owners reject copied handles and callouts and hot reads reauthenticate real immutable inputs', async () => {
      let getters = 0
      const fake = Object.defineProperty({}, 'kind', { get() { getters++; throw new Error('caller getter') } })
      await assert.rejects(prepareRootRestoreNavigationRewriteInputs3(fake as never))
      await assert.rejects(readRootRestoreNavigationRewriteInputs3(fake as never))
      await assert.rejects(prepareRootRestoreNavigationRewriteInputs3({ ...identity.plan }))
      await assert.rejects(readRootRestoreNavigationRewriteInputs3({ ...prepared.source }))
      assert.equal(getters, 0)
      assert.equal(Object.isFrozen(value.scopes[0].destinations), true)
      assert.deepEqual(await readRootRestoreNavigationRewriteInputs3(prepared.source), value)
      const manifestPath = join(identity.directory, 'manifest.json'), manifest = await readFile(manifestPath)
      await writeFile(manifestPath, '{}\n')
      await assert.rejects(readRootRestoreNavigationRewriteInputs3(prepared.source))
      await writeFile(manifestPath, manifest)
      await tamperContent3VerificationOriginals(f.receiver.userDataRoot)
      await assert.rejects(readRootRestoreNavigationRewriteInputs3(prepared.source))
    })
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }))
