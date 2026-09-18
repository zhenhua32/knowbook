export function isTaskBlockType(type: string): boolean {
  return type === 'todo' || type === 'numbered-todo'
}

export function isOrderedListBlockType(type: string): boolean {
  return type === 'numbered-list' || type === 'numbered-todo'
}

export function isListBlockType(type: string): boolean {
  return isTaskBlockType(type) || type === 'bulleted-list' || type === 'numbered-list'
}
