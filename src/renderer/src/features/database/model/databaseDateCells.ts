/** Dates keep a separate draft namespace when a property changes type. */
export function dateDraftFieldId(id: string): string {
  return JSON.stringify(['date', id])
}

export function dateDraftKey(base: string): string {
  const [source, record, field] = JSON.parse(base) as string[]
  return JSON.stringify([source, record, dateDraftFieldId(field)])
}
