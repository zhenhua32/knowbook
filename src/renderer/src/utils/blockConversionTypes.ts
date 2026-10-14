/** The same block conversions are exposed by single and multiple block controls. */
export const BLOCK_CONVERSION_TYPES = [
  'paragraph', 'heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6',
  'todo', 'numbered-todo', 'code', 'math', 'quote', 'bulleted-list', 'numbered-list', 'table', 'divider', 'callout', 'toggle'
] as const

export function blockConversionLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(BLOCK_CONVERSION_TYPES.map(type => [type, labels[type] ?? type]))
}
