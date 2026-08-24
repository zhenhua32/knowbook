import { DATABASE_SYSTEM_FIELD_IDS } from '@shared/database-workspace'
import type {
  DatabaseEntity,
  DatabaseField,
  DatabaseRecord,
  DatabaseSource,
  DocumentCatalogEntry,
  DocumentDatabase,
  DocumentDatabaseColumn
} from '@shared/contracts'

export interface DatabaseSystemFieldLabels {
  title: string
  path: string
  parent: string
  linkedDocument: string
  blockCount: string
  linkCount: string
  childCount: string
  createdAt: string
  updatedAt: string
}

export function adaptDatabaseSources(databases: DocumentDatabase[]): DatabaseSource[] {
  return [...databases]
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'document-catalog' ? -1 : 1
      }
      return left.name.localeCompare(right.name)
    })
    .map((database) => ({
      id: database.id,
      kind: database.kind,
      name: database.name,
      description: database.description,
      canDelete: database.kind === 'custom',
      canCreateDetachedRecord: database.kind === 'custom'
    }))
}

export function adaptCatalogFields(
  columns: DocumentDatabaseColumn[],
  labels: DatabaseSystemFieldLabels
): DatabaseField[] {
  const systemFields: DatabaseField[] = [
    createSystemField(DATABASE_SYSTEM_FIELD_IDS.title, labels.title, 'title', true, false, 0),
    createSystemField(DATABASE_SYSTEM_FIELD_IDS.path, labels.path, 'text', false, true, 1),
    createSystemField(DATABASE_SYSTEM_FIELD_IDS.parent, labels.parent, 'text', false, true, 2),
    createSystemField(DATABASE_SYSTEM_FIELD_IDS.blockCount, labels.blockCount, 'text', false, true, 3),
    createSystemField(DATABASE_SYSTEM_FIELD_IDS.linkCount, labels.linkCount, 'text', false, true, 4),
    createSystemField(DATABASE_SYSTEM_FIELD_IDS.childCount, labels.childCount, 'text', false, true, 5),
    createSystemField(DATABASE_SYSTEM_FIELD_IDS.updatedAt, labels.updatedAt, 'date', false, true, 6)
  ]

  return [...systemFields, ...adaptPropertyFields(columns, systemFields.length)]
}

export function adaptCustomFields(
  columns: DocumentDatabaseColumn[],
  labels: DatabaseSystemFieldLabels
): DatabaseField[] {
  const systemFields: DatabaseField[] = [
    createSystemField(DATABASE_SYSTEM_FIELD_IDS.title, labels.title, 'title', true, false, 0),
    createSystemField(DATABASE_SYSTEM_FIELD_IDS.document, labels.linkedDocument, 'text', true, true, 1),
    createSystemField(DATABASE_SYSTEM_FIELD_IDS.createdAt, labels.createdAt, 'date', false, true, 2),
    createSystemField(DATABASE_SYSTEM_FIELD_IDS.updatedAt, labels.updatedAt, 'date', false, true, 3)
  ]

  return [...systemFields, ...adaptPropertyFields(columns, systemFields.length)]
}

export function adaptCatalogRecords(
  databaseId: string,
  documents: DocumentCatalogEntry[]
): DatabaseRecord[] {
  return documents.map((document) => ({
    id: document.id,
    databaseId,
    title: document.title,
    documentId: document.id,
    createdAt: document.updatedAt,
    updatedAt: document.updatedAt,
    fieldValues: {
      ...document.fieldValues,
      [DATABASE_SYSTEM_FIELD_IDS.title]: document.title,
      [DATABASE_SYSTEM_FIELD_IDS.path]: document.path,
      [DATABASE_SYSTEM_FIELD_IDS.parent]: document.parentTitle ?? null,
      [DATABASE_SYSTEM_FIELD_IDS.blockCount]: document.blockCount,
      [DATABASE_SYSTEM_FIELD_IDS.linkCount]: document.linkCount,
      [DATABASE_SYSTEM_FIELD_IDS.childCount]: document.childCount,
      [DATABASE_SYSTEM_FIELD_IDS.updatedAt]: document.updatedAt
    }
  }))
}

export function adaptCustomRecords(
  databaseId: string,
  entities: DatabaseEntity[],
  documents: DocumentCatalogEntry[]
): DatabaseRecord[] {
  const documentById = new Map(documents.map((document) => [document.id, document]))

  return entities.map((entity) => {
    const document = entity.documentId ? documentById.get(entity.documentId) ?? null : null
    return {
      id: entity.id,
      databaseId,
      title: entity.title,
      documentId: entity.documentId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      fieldValues: {
        ...entity.fieldValues,
        [DATABASE_SYSTEM_FIELD_IDS.title]: entity.title,
        [DATABASE_SYSTEM_FIELD_IDS.document]: document?.path ?? null,
        [DATABASE_SYSTEM_FIELD_IDS.createdAt]: entity.createdAt,
        [DATABASE_SYSTEM_FIELD_IDS.updatedAt]: entity.updatedAt
      }
    }
  })
}

function adaptPropertyFields(columns: DocumentDatabaseColumn[], offset: number): DatabaseField[] {
  return [...columns]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    .map((column, index) => ({
      id: column.id,
      name: column.name,
      type: column.type,
      role: 'property',
      options: [...column.options],
      editable: true,
      hideable: true,
      deletable: true,
      sortOrder: offset + index
    }))
}

function createSystemField(
  id: string,
  name: string,
  type: DatabaseField['type'] | 'title',
  editable: boolean,
  hideable: boolean,
  sortOrder: number
): DatabaseField {
  return {
    id,
    name,
    type: type === 'title' ? 'text' : type,
    role: type === 'title' ? 'title' : 'system',
    options: [],
    editable,
    hideable,
    deletable: false,
    sortOrder
  }
}
