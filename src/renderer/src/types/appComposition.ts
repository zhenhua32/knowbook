import type { useAppFeatureDomains } from '../hooks/useAppFeatureDomains'
import type { useWorkspaceOperations } from '../hooks/useWorkspaceOperations'

export type AppFeatureDomainsState = ReturnType<typeof useAppFeatureDomains>
export type WorkspaceOperationsState = ReturnType<typeof useWorkspaceOperations>