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
  const filterRules = config.filters.rules.filter((rule): rule is DatabaseFilterRule => !('rules' in rule))
  const groupableFields = fields.filter((field) => field.role !== 'title' && field.id !== '__created_at__' && field.id !== '__updated_at__')

  return (
    <div className="dbw-toolbar">
      <label className="dbw-search-field dbw-main-search">
        <span aria-hidden="true">⌕</span>
        <input
          onChange={(event) => onChange((current) => ({ ...current, query: event.target.value }))}
          placeholder={text.search}
          value={config.query}
        />
        {config.query ? (
          <button aria-label={text.clearFilters} onClick={() => onChange((current) => ({ ...current, query: '' }))} type="button">×</button>
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
          {filterRules.map((rule) => (
            <FilterRuleRow
              fields={fields}
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
                  operator: 'and',
                  rules: [...current.filters.rules, {
                    id: `filter-${Date.now()}-${current.filters.rules.length}`,
                    fieldId: field.id,
                    operator: 'contains',
                    value: ''
                  }]
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
  onChange,
  onDelete,
  rule,
  text
}: {
  fields: DatabaseField[]
  onChange: (rule: DatabaseFilterRule) => void
  onDelete: () => void
  rule: DatabaseFilterRule
  text: DatabaseWorkspaceText
}) {
  const field = fields.find((candidate) => candidate.id === rule.fieldId) ?? fields[0]
  const operators = getOperators(field, text)
  const needsValue = !['is-empty', 'is-not-empty', 'is-checked', 'is-not-checked'].includes(rule.operator)

  return (
    <div className="dbw-filter-row">
      <select onChange={(event) => onChange({ ...rule, fieldId: event.target.value, operator: 'contains', value: '' })} value={rule.fieldId}>
        {fields.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select>
      <select onChange={(event) => onChange({ ...rule, operator: event.target.value as DatabaseFilterOperator })} value={rule.operator}>
        {operators.map(([operator, label]) => <option key={operator} value={operator}>{label}</option>)}
      </select>
      {needsValue ? (
        field?.type === 'select' ? (
          <select onChange={(event) => onChange({ ...rule, value: event.target.value })} value={typeof rule.value === 'string' ? rule.value : ''}>
            <option value="">—</option>
            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        ) : (
          <input onChange={(event) => onChange({ ...rule, value: event.target.value })} placeholder={text.value} value={typeof rule.value === 'string' ? rule.value : ''} />
        )
      ) : null}
      <button aria-label={text.delete} onClick={onDelete} type="button">×</button>
    </div>
  )
}

function getOperators(field: DatabaseField | undefined, text: DatabaseWorkspaceText): Array<[DatabaseFilterOperator, string]> {
  if (field?.type === 'checkbox') return [['is-checked', text.checked], ['is-not-checked', text.unchecked]]
  if (field?.type === 'date') return [['equals', text.equals], ['before', text.before], ['after', text.after], ['is-empty', text.isEmpty], ['is-not-empty', text.isNotEmpty]]
  if (field?.type === 'select') return [['equals', text.equals], ['not-equals', text.notEquals], ['is-empty', text.isEmpty], ['is-not-empty', text.isNotEmpty]]
  if (field?.type === 'multi-select') return [['contains-any', text.containsAny], ['contains-all', text.containsAll], ['is-empty', text.isEmpty], ['is-not-empty', text.isNotEmpty]]
  return [['contains', text.contains], ['not-contains', text.notContains], ['equals', text.equals], ['not-equals', text.notEquals], ['is-empty', text.isEmpty], ['is-not-empty', text.isNotEmpty]]
}
