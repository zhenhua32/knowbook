import { columnStructureErrorCode, type ColumnStructureBlock, type ColumnStructureErrorCode } from './columnStructure'
export { COLUMN_WEIGHT_TOTAL, MAX_COLUMNS, isColumnWeight, validColumnStructure } from './columnStructure'
export type { ColumnStructureBlock } from './columnStructure'

// Tree planning needs the synchronous predicate; import/export and persistence
// additionally load the diagnostic text and assertion wrapper.
const messages: Record<ColumnStructureErrorCode, string> = {
  type: '分栏块类型必须使用规范名称。',
  depth: '分栏内容超出有效的六层块结构。',
  identity: '分栏块身份无效或重复。',
  missingIdentity: '分栏块缺少持久化身份。',
  parentRole: '分栏块的父角色或层级无效。',
  columnOwner: '列必须直接位于分栏组内。',
  missingParent: '分栏块声明的父身份不存在。',
  parentIdentity: '分栏块的归属不属于当前子树。',
  structuralContent: '分栏结构块不能包含正文或列表／代码属性。',
  format: '分栏结构格式无效。',
  groupFormat: '分栏组包含无效格式属性。',
  weight: '列比例必须是 1 至 10000 的整数。',
  count: '每个分栏组必须包含 1 至 6 列。',
  total: '同一分栏组的列比例总和必须为 10000。',
}

export function columnStructureError(blocks: readonly ColumnStructureBlock[], options?: { checkParentIds?: boolean }): string | null {
  const code = columnStructureErrorCode(blocks, options)
  return code === null ? null : messages[code]
}

export function assertColumnStructure(blocks: readonly ColumnStructureBlock[], options?: { checkParentIds?: boolean }): void {
  const error = columnStructureError(blocks, options)
  if (error) throw new Error(error)
}
