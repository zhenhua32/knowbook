import type { readActualNoPriorOriginalInput } from './restore-knowledge-mixed-required-dag-read'
import type { CoverageRootReference } from './restore-knowledge-coverage-model'
import type { RequiredSqlDagNode, RequiredDagOrigin } from './restore-knowledge-required-dag-model'
import type { OriginalFrameCopy } from './restore-knowledge-original-frame-files'
import type { ReferenceContextDirectory } from './restore-knowledge-reference-context-model'

type NoPriorInput = Awaited<ReturnType<typeof readActualNoPriorOriginalInput>>
export type OriginalSourceInput = Pick<NoPriorInput, 'binding' | 'knowledge' | 'originalSqlBytes' | 'managedOriginalBytes'> & { readonly origin: RequiredDagOrigin }
/** Actual original input data, never an accepted semantic Root3. Each parent
 * reference is relative to this original node, not the receiving profile. */
export interface CompleteOriginalRootData {
  readonly scope: 'complete-original-input-closure'; readonly originalInputsComplete: true
  readonly semanticValidationComplete: false
  readonly root: CoverageRootReference; readonly node: RequiredSqlDagNode
  readonly inputs: readonly OriginalSourceInput[]
  readonly parents: readonly { readonly reference: CoverageRootReference; readonly original: CompleteOriginalRootData }[]
  readonly materialHash: string
  readonly originalSqlBytes: number; readonly managedOriginalBytes: number
  readonly nodes: number; readonly capsules: number; readonly depth: number; readonly nodeBytes: number
  readonly acceptedCoverage: false; readonly effective: false; readonly permit: false
}
export interface CompleteOriginalPackage {
  readonly reader: 'prepared-mixed-v2' | 'qualified-originals-v1'
  readonly directory: string; readonly descriptorHash: string; readonly descriptorText: string
  readonly original: CompleteOriginalRootData
  /** Includes this package's actual descriptor.json at frame []. */
  readonly files: readonly OriginalFrameCopy[]; readonly directories: readonly ReferenceContextDirectory[]
}
