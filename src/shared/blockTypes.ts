export function isTaskBlockType(type: string): boolean {
  return type === 'todo' || type === 'numbered-todo'
}

export function isOrderedListBlockType(type: string): boolean {
  return type === 'numbered-list' || type === 'numbered-todo'
}
