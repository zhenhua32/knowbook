import { ContentMatch, Fragment, Mark, MarkType, Node as PMNode, NodeType, Schema, Slice } from 'prosemirror-model'
import { AddMarkStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep, type Step } from 'prosemirror-transform'

/** A closed copy of an inspected built-in Step, not serialized command authority.
 * This module neither reads nor creates Rich link/atom intent witnesses. */
export interface ClosedRichObservedStep { readonly kind: 'add-mark' | 'remove-mark' | 'replace' | 'replace-around' }
type Supported = AddMarkStep | RemoveMarkStep | ReplaceStep | ReplaceAroundStep
// These exported runtime constructors are @internal (and intentionally absent
// from the installed .d.ts). Their installed source layout is checked below.
// They create owned payload values; they confer no link/atom intent authority.
const OwnedMark = Mark as unknown as { new(type: Mark['type'], attrs: Readonly<Record<string, unknown>>): Mark }
const OwnedFragment = Fragment as unknown as { new(content: readonly PMNode[]): Fragment }
const OwnedNode = PMNode as unknown as { new(type: PMNode['type'], attrs: Readonly<Record<string, unknown>>, content: Fragment, marks: readonly Mark[]): PMNode }
type Payload = { step: Supported; schema: Schema; current: () => boolean }
const payloads = new WeakMap<ClosedRichObservedStep, Payload>()
const constructors = [AddMarkStep, RemoveMarkStep, ReplaceStep, ReplaceAroundStep] as const
const methods = constructors.map(constructor => ({ constructor, apply: constructor.prototype.apply,
  getMap: constructor.prototype.getMap, invert: constructor.prototype.invert }))
const schemaReceipts = new WeakMap<Schema, () => boolean>()

function unsafe(): never { throw new RangeError('富文本 step 不是可封闭复制的内置布局。') }
function fields(value: object, names: readonly string[]): PropertyDescriptorMap {
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) unsafe()
  for (const name of names) if (!descriptors[name] || !('value' in descriptors[name])) unsafe()
  return descriptors
}
function typeInSchema(type: NodeType | MarkType, schema: Schema, kind: 'node' | 'mark'): void {
  if (Object.getPrototypeOf(type) !== (kind === 'node' ? NodeType.prototype : MarkType.prototype)) unsafe()
  const name = Object.getOwnPropertyDescriptor(type, 'name'), owner = Object.getOwnPropertyDescriptor(type, 'schema')
  if (!name || !('value' in name) || typeof name.value !== 'string' || !owner || !('value' in owner) || owner.value !== schema) unsafe()
  const entry = Object.getOwnPropertyDescriptor(kind === 'node' ? schema.nodes : schema.marks, name.value)
  if (!entry || !('value' in entry) || entry.value !== type) unsafe()
}
function registryEntries<T>(registry: Record<string, T>): Array<readonly [string, T]> {
  if (Object.getPrototypeOf(registry) !== null && Object.getPrototypeOf(registry) !== Object.prototype) unsafe()
  return Reflect.ownKeys(registry).map(key => {
    if (typeof key !== 'string') unsafe()
    const descriptor = Object.getOwnPropertyDescriptor(registry, key)!
    if (!('value' in descriptor)) unsafe()
    return [key, descriptor.value as T] as const
  })
}
/** Schema/types remain real shared identities. Record their semantic metadata
 * without freezing it, so a later mutation rejects rather than altering a
 * closed payload. Only PM's documented computation caches may evolve. */
function schemaReceipt(schema: Schema): () => boolean {
  const known = schemaReceipts.get(schema)
  if (known) { if (!known()) unsafe(); return known }
  if (Object.getPrototypeOf(schema) !== Schema.prototype) unsafe()
  fields(schema, ['spec', 'nodes', 'marks', 'linebreakReplacement', 'cached', 'nodeFromJSON', 'markFromJSON', 'topNodeType'])
  for (const [name, type] of registryEntries(schema.nodes)) {
    typeInSchema(type, schema, 'node')
    if (type.name !== name) unsafe()
    fields(type, ['name', 'schema', 'spec', 'groups', 'attrs', 'defaultAttrs', 'contentMatch', 'inlineContent', 'isBlock', 'isText', 'markSet'])
  }
  for (const [name, type] of registryEntries(schema.marks)) {
    typeInSchema(type, schema, 'mark')
    if (type.name !== name) unsafe()
    fields(type, ['name', 'rank', 'schema', 'spec', 'attrs', 'excluded', 'instance'])
  }
  const seen = new Set<object>(), checks: Array<() => boolean> = []
  const mutableCache = (value: object, key: PropertyKey) => value === schema && key === 'cached'
    || Object.getPrototypeOf(value) === ContentMatch.prototype && key === 'wrapCache'
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    if (value instanceof PMNode || value instanceof Fragment || value instanceof Slice) unsafe()
    seen.add(value)
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    // Do not retain old computation-cache values either: replacing a cache must
    // not leave an old document hidden behind this otherwise semantic receipt.
    const own = new Map(keys.filter(key => !mutableCache(value, key)).map(key => [key, Object.getOwnPropertyDescriptor(value, key)!]))
    checks.push(() => {
      const nextKeys = Reflect.ownKeys(value)
      if (Object.getPrototypeOf(value) !== prototype || nextKeys.length !== keys.length) return false
      return keys.every(key => {
        const after = Object.getOwnPropertyDescriptor(value, key)
        if (mutableCache(value, key)) return !!after && 'value' in after
        const before = own.get(key)!
        return !!after && before.configurable === after.configurable && before.enumerable === after.enumerable
          && ('value' in before ? 'value' in after && before.writable === after.writable && Object.is(before.value, after.value)
            : !('value' in after) && before.get === after.get && before.set === after.set)
      })
    })
    for (const key of keys) {
      if (mutableCache(value, key)) continue
      const descriptor = own.get(key)!
      // Accessors are compared by identity, never invoked during observation.
      if (!('value' in descriptor)) continue
      visit(descriptor.value)
    }
  }
  visit(schema)
  for (const prototype of [Schema.prototype, NodeType.prototype, MarkType.prototype, ContentMatch.prototype, Mark.prototype, PMNode.prototype, Fragment.prototype]) visit(prototype)
  seen.clear()
  const current = () => {
    try { return checks.every(check => check()) } catch { return false }
  }
  schemaReceipts.set(schema, current)
  return current
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) unsafe()
  return value
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') unsafe(); return value }
function data(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) unsafe(); return value }
  if (typeof value !== 'object' || ancestors.has(value)) unsafe()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) unsafe()
      const descriptors = Object.getOwnPropertyDescriptors(value)
      if (Reflect.ownKeys(descriptors).length !== value.length + 1) unsafe()
      const result: unknown[] = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !('value' in descriptor)) unsafe()
        result.push(data(descriptor.value, ancestors))
      }
      return Object.freeze(result)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) unsafe()
    const result = Object.create(prototype) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') unsafe()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!('value' in descriptor)) unsafe()
      Object.defineProperty(result, key, { value: data(descriptor.value, ancestors), enumerable: descriptor.enumerable,
        configurable: false, writable: false })
    }
    return Object.freeze(result)
  } finally { ancestors.delete(value) }
}
function attrs(value: unknown): Readonly<Record<string, unknown>> {
  const result = data(value)
  if (!result || typeof result !== 'object' || Array.isArray(result)) unsafe()
  return result as Readonly<Record<string, unknown>>
}
function mark(value: Mark, schema: Schema): Mark {
  if (Object.getPrototypeOf(value) !== Mark.prototype) unsafe()
  const own = fields(value, ['type', 'attrs'])
  typeInSchema(own.type.value as MarkType, schema, 'mark')
  const result = new OwnedMark(own.type.value as Mark['type'], attrs(own.attrs.value))
  if (!result.eq(value)) unsafe()
  return Object.freeze(result)
}
function marks(value: readonly Mark[], schema: Schema): readonly Mark[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) unsafe()
  const own = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(own).length !== value.length + 1) unsafe()
  return Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const descriptor = own[String(index)]; if (!descriptor || !('value' in descriptor)) unsafe()
    return mark(descriptor.value as Mark, schema)
  }))
}
function fragment(value: Fragment, ancestors: Set<PMNode>, schema: Schema): Fragment {
  if (Object.getPrototypeOf(value) !== Fragment.prototype) unsafe()
  const own = fields(value, ['content', 'size']), children = own.content.value as readonly PMNode[]
  if (!Array.isArray(children) || Object.getPrototypeOf(children) !== Array.prototype) unsafe()
  const descriptors = Object.getOwnPropertyDescriptors(children)
  if (Reflect.ownKeys(descriptors).length !== children.length + 1) unsafe()
  const cloned = Array.from({ length: children.length }, (_, index) => {
    const descriptor = descriptors[String(index)]; if (!descriptor || !('value' in descriptor)) unsafe()
    return node(descriptor.value as PMNode, ancestors, schema)
  })
  const result = new OwnedFragment(Object.freeze(cloned))
  if (result.size !== integer(own.size.value)) unsafe()
  return Object.freeze(result)
}
function node(value: PMNode, ancestors: Set<PMNode>, schema: Schema): PMNode {
  if (ancestors.has(value)) unsafe()
  ancestors.add(value)
  try {
    const text = Object.getOwnPropertyDescriptor(value, 'text'), isText = !!text
    const own = fields(value, isText ? ['type', 'attrs', 'marks', 'content', 'text'] : ['type', 'attrs', 'marks', 'content'])
    const type = own.type.value as PMNode['type']
    typeInSchema(type, schema, 'node')
    const expectedPrototype = isText ? Object.getPrototypeOf(type.schema.text('x')) : PMNode.prototype
    if (Object.getPrototypeOf(value) !== expectedPrototype) unsafe()
    const clonedAttrs = attrs(own.attrs.value), clonedMarks = marks(own.marks.value as readonly Mark[], schema)
    const content = fragment(own.content.value as Fragment, ancestors, schema)
    let result: PMNode
    if (isText) {
      if (typeof own.text.value !== 'string' || !own.text.value.length || content.size) unsafe()
      result = type.schema.text(own.text.value, clonedMarks)
      // Replace shared schema defaults only on this newly owned TextNode.
      // Never freeze or mutate Fragment.empty or schema-owned default attrs.
      if (Reflect.ownKeys(clonedAttrs).length) unsafe()
      Object.defineProperty(result, 'attrs', { value: clonedAttrs })
      Object.defineProperty(result, 'content', { value: content })
      Object.defineProperty(result, 'marks', { value: clonedMarks })
    } else result = new OwnedNode(type, clonedAttrs, content, clonedMarks)
    if (!result.eq(value)) unsafe()
    return Object.freeze(result)
  } finally { ancestors.delete(value) }
}
function slice(value: Slice, schema: Schema): Slice {
  if (Object.getPrototypeOf(value) !== Slice.prototype) unsafe()
  const own = fields(value, ['content', 'openStart', 'openEnd'])
  const result = new Slice(fragment(own.content.value as Fragment, new Set(), schema), integer(own.openStart.value), integer(own.openEnd.value))
  if (!result.eq(value)) unsafe()
  return Object.freeze(result)
}
function trusted(step: Step): boolean {
  const entry = methods.find(entry => Object.getPrototypeOf(step) === entry.constructor.prototype)
  return !!entry && entry.constructor.prototype.apply === entry.apply
    && entry.constructor.prototype.getMap === entry.getMap && entry.constructor.prototype.invert === entry.invert
}

/** No custom/subclass layouts, getters, caller-owned attrs, Slice or Step refs
 * survive capture. Unsupported input is quarantined by the owning session. */
export function captureRichObservedStep(step: Step, actualSchema: Schema): ClosedRichObservedStep | null {
  try {
    if (!trusted(step)) return null
    const current = schemaReceipt(actualSchema)
    let copy: Supported, kind: ClosedRichObservedStep['kind']
    if (Object.getPrototypeOf(step) === AddMarkStep.prototype || Object.getPrototypeOf(step) === RemoveMarkStep.prototype) {
      const own = fields(step, ['from', 'to', 'mark']), from = integer(own.from.value), to = integer(own.to.value)
      if (to < from) unsafe()
      const added = Object.getPrototypeOf(step) === AddMarkStep.prototype
      copy = added ? new AddMarkStep(from, to, mark(own.mark.value as Mark, actualSchema)) : new RemoveMarkStep(from, to, mark(own.mark.value as Mark, actualSchema))
      kind = added ? 'add-mark' : 'remove-mark'
    } else if (Object.getPrototypeOf(step) === ReplaceStep.prototype) {
      const own = fields(step, ['from', 'to', 'slice', 'structure']), from = integer(own.from.value), to = integer(own.to.value)
      if (to < from) unsafe()
      copy = new ReplaceStep(from, to, slice(own.slice.value as Slice, actualSchema), boolean(own.structure.value)); kind = 'replace'
    } else {
      const own = fields(step, ['from', 'to', 'gapFrom', 'gapTo', 'slice', 'insert', 'structure'])
      const from = integer(own.from.value), to = integer(own.to.value), gapFrom = integer(own.gapFrom.value), gapTo = integer(own.gapTo.value)
      if (from > gapFrom || gapFrom > gapTo || gapTo > to) unsafe()
      const copiedSlice = slice(own.slice.value as Slice, actualSchema), insert = integer(own.insert.value)
      if (insert > copiedSlice.size) unsafe()
      copy = new ReplaceAroundStep(from, to, gapFrom, gapTo, copiedSlice, insert, boolean(own.structure.value)); kind = 'replace-around'
    }
    Object.freeze(copy)
    if (!current()) return null
    const result = Object.freeze({ kind }); payloads.set(result, { step: copy, schema: actualSchema, current }); return result
  } catch { return null }
}

/** Owned leaf witness, never a historical document root. It is used only after
 * the Rich module has verified the real private atom-intent registration. */
export function copyRichObservedLeaf(value: PMNode, actualSchema: Schema): PMNode | null {
  try { return value.isLeaf ? node(value, new Set(), actualSchema) : null } catch { return null }
}

export function isRichObservedStepCurrent(value: ClosedRichObservedStep, schema: Schema): boolean {
  const payload = payloads.get(value)
  return !!payload && payload.schema === schema && trusted(payload.step) && payload.current()
}

/** Returning a closed Step cannot grant private intent: only richProvenance's
 * session WeakMaps hold that authority. No Step.fromJSON/Transaction is used. */
export function replayRichObservedStep(value: ClosedRichObservedStep, before: PMNode): { step: Step; after: PMNode } | null {
  const payload = payloads.get(value)
  if (!payload || !isRichObservedStepCurrent(value, before.type.schema)) return null
  try {
    typeInSchema(before.type, payload.schema, 'node')
    const applied = payload.step.apply(before)
    return applied.doc && payload.current() ? { step: payload.step, after: applied.doc } : null
  } catch { return null }
}
