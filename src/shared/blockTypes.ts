export function isTaskBlockType(type: string): boolean {
  return type === 'todo' || type === 'numbered-todo'
}

export function isOrderedListBlockType(type: string): boolean {
  return type === 'numbered-list' || type === 'numbered-todo'
}

export function isListBlockType(type: string): boolean {
  return isTaskBlockType(type) || type === 'bulleted-list' || type === 'numbered-list'
}

/** Native owners preserve a forest of independently editable mixed blocks. */
export function isContainerBlockType(type: string): boolean {
  return type === 'callout' || type === 'toggle'
}

export function canBlockOwnChildren(type: string): boolean {
  return isListBlockType(type) || isContainerBlockType(type)
}

export function canBlockHaveParent(type: string): boolean {
  return type !== 'frontmatter'
}

/** List semantics stay unchanged; mixed children belong only to native containers. */
export function canBlockNestUnder(parentType: string, childType: string): boolean {
  return isContainerBlockType(parentType) ? canBlockHaveParent(childType)
    : isListBlockType(parentType) && isListBlockType(childType)
}
