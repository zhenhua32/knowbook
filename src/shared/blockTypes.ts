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

export function isColumnsBlockType(type: string): boolean {
  return type === 'columns'
}

export function isColumnBlockType(type: string): boolean {
  return type === 'column'
}

/** Structures have explicit Markdown shells; only callout/toggle have titles. */
export function isNativeStructureBlockType(type: string): boolean {
  return isContainerBlockType(type) || isColumnsBlockType(type) || isColumnBlockType(type)
}

export function canBlockOwnChildren(type: string): boolean {
  return isListBlockType(type) || isNativeStructureBlockType(type)
}

export function canBlockHaveParent(type: string): boolean {
  return type !== 'frontmatter'
}

/** Layout groups own columns; their columns and titled containers own mixed blocks. */
export function canBlockNestUnder(parentType: string, childType: string): boolean {
  return isColumnsBlockType(parentType) ? isColumnBlockType(childType)
    : isContainerBlockType(parentType) || isColumnBlockType(parentType)
      ? canBlockHaveParent(childType) && !isColumnBlockType(childType)
    : isListBlockType(parentType) && isListBlockType(childType)
}
