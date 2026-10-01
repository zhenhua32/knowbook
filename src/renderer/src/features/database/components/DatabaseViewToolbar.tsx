import { useRef } from 'react'
import type {
  DatabaseField,
  DatabaseFilterOperator,
  DatabaseFilterRule,
  DatabaseSavedViewLayoutMode,
  DatabaseViewConfigV1
} from '@shared/contracts'
import type { DatabaseWorkspaceText } from '../databaseText'
import { LayoutIcon } from './DatabaseViewTabs'

export function DatabaseViewToolbar({
  config,
  dirty,
  fields,
  recordCount,
  text,
  onChange,
  onOpenFields,
  onReset,
  onSave,
  onSaveAs
}: {
  config: DatabaseViewConfigV1
  dirty: boolean
  fields: DatabaseField[]
  recordCount: number
  text: DatabaseWorkspaceText
  onChange: (updater: (current: DatabaseViewConfigV1) => DatabaseViewConfigV1) => void
  onOpenFields: () => void
  onReset: () => void
  onSave: () => void
  onSaveAs: () => void
}) {
  const searchInputRef = useRef<HTMLInputElement>(null)
  const filterRules = config.filters.rules.filter((rule): rule is DatabaseFilterRule => !('rules' in rule))
  const groupableFields = fields.filter((field) => field.role !== 'title' && field.id !== '__created_at__' && field.id !== '__updated_at__')

  return (
    <div className="dbw-toolbar">
      <label className="dbw-search-field dbw-main-search">
        <span aria-hidden="true">⌕</span>
        <input
          aria-label={text.search}
          ref={searchInputRef}
          onChange={(event) => onChange((current) => ({ ...current, query: event.target.value }))}
          placeholder={text.search}
          value={config.query}
        />
        {config.query ? (
          <button aria-label={text.clearSearch} onClick={() => {
            onChange((current) => ({ ...current, query: '' }))
            searchInputRef.current?.focus()
          }} type="button">×</button>
        ) : null}
      </label>

      <details className="dbw-toolbar-menu">
        <summary className={filterRules.length > 0 ? 'is-active' : ''}>
          <span aria-hidden="true">◇</span>{text.filter}{filterRules.length > 0 ? <b>{filterRules.length}</b> : null}
        </summary>
        <div className="dbw-popover dbw-config-popover dbw-filter-popover">
          <div className="dbw-popover-heading">
            <strong>{text.filter}</strong>
            {filterRules.length > 0 ? (
              <button onClick={() => onChange((current) => ({ ...current, filters: { operator: 'and', rules: [] } }))} type="button">{text.clearFilters}</button>
            ) : null}
          </div>
          {filterRules.map((rule, index) => (
            <FilterRuleRow
              fields={fields}
              index={index}
              key={rule.id}
              onChange={(nextRule) => onChange((current) => ({
                ...current,
                filters: {
                  ...current.filters,
                  rules: current.filters.rules.map((candidate) => !('rules' in candidate) && candidate.id === rule.id ? nextRule : candidate)
                }
              }))}
              onDelete={() => onChange((current) => ({
                ...current,
                filters: {
                  ...current.filters,
                  rules: current.filters.rules.filter((candidate) => 'rules' in candidate || candidate.id !== rule.id)
                }
              }))}
              rule={rule}
              text={text}
            />
          ))}
          <button
            className="dbw-add-config-row"
            disabled={fields.length === 0}
            onClick={() => {
              const field = fields[0]
              if (!field) return
              onChange((current) => ({
                ...current,
                filters: {
                  ...current.filters,
                  rules: [...current.filters.rules, createFilterRule(field, `filter-${Date.now()}-${current.filters.rules.length}`)]
                }
              }))
            }}
            type="button"
          >＋ {text.addFilter}</button>
        </div>
      </details>

      <details className="dbw-toolbar-menu">
        <summary className={config.sorts.length > 0 ? 'is-active' : ''}><span aria-hidden="true">⇅</span>{text.sort}</summary>
        <div className="dbw-popover dbw-config-popover">
          <strong>{text.sort}</strong>
          {config.sorts.map((sort, index) => (
            <div className="dbw-config-row" key={`${sort.fieldId}-${index}`}>
              <select
                aria-label={text.sort}
                onChange={(event) => onChange((current) => ({
                  ...current,
                  sorts: current.sorts.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, fieldId: event.target.value } : candidate)
                }))}
                value={sort.fieldId}
              >
                {fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
              </select>
              <select
                aria-label={text.ascending}
                onChange={(event) => onChange((current) => ({
                  ...current,
                  sorts: current.sorts.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, direction: event.target.value === 'asc' ? 'asc' : 'desc' } : candidate)
                }))}
                value={sort.direction}
              >
                <option value="asc">{text.ascending}</option>
                <option value="desc">{text.descending}</option>
              </select>
              <button aria-label={text.delete} onClick={() => onChange((current) => ({ ...current, sorts: current.sorts.filter((_, candidateIndex) => candidateIndex !== index) }))} type="button">×</button>
            </div>
          ))}
          <button
            className="dbw-add-config-row"
            disabled={fields.length === 0}
            onClick={() => {
              const field = fields[0]
              if (field) onChange((current) => ({ ...current, sorts: [...current.sorts, { fieldId: field.id, direction: 'asc' }] }))
            }}
            type="button"
          >＋ {text.sort}</button>
        </div>
      </details>

      <label className="dbw-toolbar-select">
        <span aria-hidden="true">≡</span>
        <span>{text.group}</span>
        <select onChange={(event) => onChange((current) => ({ ...current, groupBy: { fieldId: event.target.value || null } }))} value={config.groupBy.fieldId ?? ''}>
          <option value="">{text.noGrouping}</option>
          {groupableFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
        </select>
      </label>

      <button className="dbw-toolbar-button" onClick={onOpenFields} type="button">
        <span aria-hidden="true">☷</span>{text.fields}<b>{config.visibleFieldIds.length}</b>
      </button>

      <div aria-label={text.layout} className="dbw-layout-switcher" role="group">
        {(['table', 'board', 'cards'] as DatabaseSavedViewLayoutMode[]).map((layout) => (
          <button
            aria-label={layout === 'table' ? text.table : layout === 'board' ? text.board : text.cards}
            aria-pressed={config.layout === layout}
            key={layout}
            onClick={() => onChange((current) => ({ ...current, layout }))}
            type="button"
          ><LayoutIcon layout={layout} /></button>
        ))}
      </div>

      <span className="dbw-record-count">{text.records(recordCount)}</span>
      <div className="dbw-save-actions">
        {dirty ? <button className="dbw-quiet-button" onClick={onReset} type="button">{text.resetView}</button> : null}
        <button className="dbw-save-button" disabled={!dirty} onClick={onSave} type="button">{dirty ? text.saveChanges : text.saved}</button>
        <button aria-label={text.saveAsView} className="dbw-save-as-button" onClick={onSaveAs} type="button">⌄</button>
      </div>
    </div>
  )
}

function FilterRuleRow({
  fields,
  index,
  onChange,
  onDelete,
  rule,
  text
}: {
  fields: DatabaseField[]
  index: number
  onChange: (rule: DatabaseFilterRule) => void
  onDelete: () => void
  rule: DatabaseFilterRule
  text: DatabaseWorkspaceText
}) {
  const field = fields.find((candidate) => candidate.id === rule.fieldId)
  const operators = getOperators(field, text)
  if (!operators.some(([operator]) => operator === rule.operator)) operators.push([rule.operator, getOperatorLabel(rule.operator, text)])
  const needsValue = filterNeedsValue(rule.operator)
  const valueLabel = `${text.value} ${index + 1}`

  return (
    <div aria-label={`${text.filter} ${index + 1}`} className={`dbw-filter-row${needsValue ? '' : ' dbw-filter-row-without-value'}`} role="group">
      <select aria-label={`${text.filterField} ${index + 1}`} onChange={(event) => {
        const nextField = fields.find(candidate => candidate.id === event.target.value)
        if (nextField) onChange(createFilterRule(nextField, rule.id))
      }} value={rule.fieldId}>
        {!field ? <option value={rule.fieldId}>{rule.fieldId}</option> : null}
        {fields.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select>
      <select aria-label={`${text.operator} ${index + 1}`} onChange={(event) => onChange(changeFilterOperator(rule, field, event.target.value as DatabaseFilterOperator))} value={rule.operator}>
        {operators.map(([operator, label]) => <option key={operator} value={operator}>{label}</option>)}
      </select>
      {needsValue ? <FilterRuleValue field={field} key={JSON.stringify([rule.id, rule.fieldId, rule.operator])} label={valueLabel} onChange={value => onChange({ ...rule, value })} rule={rule} text={text} /> : null}
      <button aria-label={text.delete} onClick={onDelete} type="button">×</button>
    </div>
  )
}

function FilterRuleValue({ field, label, onChange, rule, text }: {
  field: DatabaseField | undefined
  label: string
  onChange: (value: DatabaseFilterRule['value']) => void
  rule: DatabaseFilterRule
  text: DatabaseWorkspaceText
}) {
  // Clearing a numeric value is still the same numeric edit. Explicit value
  // kinds and a changed rule context select their own editor again.
  const numericMode = useRef(typeof rule.value === 'number')
  if (rule.value !== undefined) numericMode.current = typeof rule.value === 'number'
  if (rule.operator === 'between') {
    const validPair = Array.isArray(rule.value) && rule.value.length === 2
    const pair = validPair ? rule.value as [string, string] : ['', '']
    return <div aria-label={label} className="dbw-filter-value dbw-filter-range" role="group">
      {!validPair ? <span className="dbw-filter-value-error" role="alert">{text.invalidFilterValue}</span> : null}
      {pair.map((value, index) => <input aria-label={`${label} ${index === 0 ? text.rangeStart : text.rangeEnd}`} key={index}
        onChange={event => onChange(index === 0 ? [event.target.value, pair[1]] : [pair[0], event.target.value])}
        type={field?.type === 'date' && isDateInputValue(value) ? 'date' : 'text'} value={value} />)}
    </div>
  }

  if (rule.operator === 'contains-any' || rule.operator === 'contains-all' || Array.isArray(rule.value)) {
    const selected = Array.isArray(rule.value) ? rule.value : []
    const options = [...new Set([...(field?.options ?? []), ...selected])]
    return <div aria-label={label} className="dbw-filter-value dbw-filter-options" role="group">
      {!Array.isArray(rule.value) ? <span className="dbw-filter-value-error" role="alert">
        {text.invalidFilterValue}{typeof rule.value === 'string' && rule.value ? <span className="dbw-filter-legacy-value"> {rule.value}</span> : null}
      </span> : null}
      {options.map(option => <label key={option}><input checked={selected.includes(option)} onChange={event =>
        onChange(event.target.checked ? [...new Set([...selected, option])] : selected.filter(value => value !== option))} type="checkbox" /><span>{option}</span></label>)}
      {options.length === 0 ? <span>—</span> : null}
    </div>
  }

  if (typeof rule.value === 'boolean') {
    return <input aria-label={label} checked={rule.value} className="dbw-filter-value" onChange={event => onChange(event.target.checked)} type="checkbox" />
  }

  if (numericMode.current) {
    return <input aria-label={label} className="dbw-filter-value" onChange={event => {
      const value = event.target.value === '' ? undefined : Number(event.target.value)
      onChange(value !== undefined && Number.isFinite(value) ? value : undefined)
    }} step="any" type="number" value={rule.value === undefined ? '' : String(rule.value)} />
  }

  const value = typeof rule.value === 'string' ? rule.value : ''
  if (field?.type === 'select') {
    const options = [...new Set([...field.options, ...(value ? [value] : [])])]
    return <select aria-label={label} className="dbw-filter-value" onChange={event => onChange(event.target.value)} value={value}>
      <option value="">—</option>
      {options.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
  }

  return <input aria-label={label} className="dbw-filter-value" onChange={event => onChange(event.target.value)} placeholder={text.value}
    type={field?.type === 'date' && isDateInputValue(value) ? 'date' : 'text'} value={value} />
}

function filterNeedsValue(operator: DatabaseFilterOperator): boolean {
  return !['is-empty', 'is-not-empty', 'is-checked', 'is-not-checked'].includes(operator)
}

function createFilterRule(field: DatabaseField, id: string): DatabaseFilterRule {
  const operator = field.type === 'checkbox' ? 'is-checked'
    : field.type === 'multi-select' ? 'contains-any'
      : field.type === 'select' || field.type === 'date' ? 'equals' : 'contains'
  return changeFilterOperator({ id, fieldId: field.id, operator }, field, operator)
}

function changeFilterOperator(rule: DatabaseFilterRule, field: DatabaseField | undefined, operator: DatabaseFilterOperator): DatabaseFilterRule {
  const { value, ...rest } = rule
  if (!filterNeedsValue(operator)) return { ...rest, operator }
  const nextValue = operator === 'contains-any' || operator === 'contains-all'
    ? (Array.isArray(value) ? value : [])
    : operator === 'between'
      ? (Array.isArray(value) && value.length === 2 ? value : ['', ''])
      : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value : field?.type === 'checkbox' ? false : ''
  return { ...rest, operator, value: nextValue }
}

function isDateInputValue(value: string): boolean {
  if (!value) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function getOperatorLabel(operator: DatabaseFilterOperator, text: DatabaseWorkspaceText): string {
  const labels: Record<DatabaseFilterOperator, string> = {
    contains: text.contains, 'not-contains': text.notContains, equals: text.equals, 'not-equals': text.notEquals,
    'is-empty': text.isEmpty, 'is-not-empty': text.isNotEmpty, 'is-checked': text.checked, 'is-not-checked': text.unchecked,
    'contains-any': text.containsAny, 'contains-all': text.containsAll, before: text.before, after: text.after,
    between: text.between, 'greater-than': text.greaterThan, 'less-than': text.lessThan
  }
  return labels[operator] ?? operator
}

function getOperators(field: DatabaseField | undefined, text: DatabaseWorkspaceText): Array<[DatabaseFilterOperator, string]> {
  if (field?.type === 'checkbox') return [['is-checked', text.checked], ['is-not-checked', text.unchecked]]
  if (field?.type === 'date') return [['equals', text.equals], ['before', text.before], ['after', text.after], ['is-empty', text.isEmpty], ['is-not-empty', text.isNotEmpty]]
  if (field?.type === 'select') return [['equals', text.equals], ['not-equals', text.notEquals], ['is-empty', text.isEmpty], ['is-not-empty', text.isNotEmpty]]
  if (field?.type === 'multi-select') return [['contains-any', text.containsAny], ['contains-all', text.containsAll], ['is-empty', text.isEmpty], ['is-not-empty', text.isNotEmpty]]
  return [['contains', text.contains], ['not-contains', text.notContains], ['equals', text.equals], ['not-equals', text.notEquals], ['is-empty', text.isEmpty], ['is-not-empty', text.isNotEmpty]]
}
