import type { GlobalSearchResult } from './contracts'

export type WorkspaceSearchScope = 'all' | 'documents' | 'blocks'
export type WorkspaceSearchMatchMode = 'all' | 'any' | 'phrase'
export type WorkspaceSearchSort = 'relevance' | 'updated-desc' | 'updated-asc'

export interface WorkspaceSearchInput {
  query: string
  scope?: WorkspaceSearchScope
  matchMode?: WorkspaceSearchMatchMode
  folderId?: string | null
  tag?: string
  blockType?: string
  updatedFrom?: string
  updatedTo?: string
  sort?: WorkspaceSearchSort
  page?: number
  pageSize?: number
}

export interface WorkspaceSearchResult extends GlobalSearchResult {
  updatedAt: string
  tags: string[]
}

export interface WorkspaceSearchPage {
  items: WorkspaceSearchResult[]
  total: number
  page: number
  pageSize: number
  queryTerms: string[]
}

export interface WorkspaceSearchFacets {
  tags: string[]
  blockTypes: string[]
}

export interface SavedWorkspaceSearch {
  id: string
  name: string
  input: WorkspaceSearchInput
}

export interface SaveWorkspaceSearchInput {
  id?: string
  name: string
  input: WorkspaceSearchInput
}
