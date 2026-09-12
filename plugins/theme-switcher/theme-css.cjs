/** @typedef {import('./themes.cjs').Theme} Theme */

/**
 * Map the app's public tokens and its older surface variables to one palette.
 * Repeat this mapping on lazy page roots: those pages define local dark tokens
 * that would otherwise shadow values inherited from documentElement.
 */
const hostTokens = `
  --kb-bg: var(--ts-background);
  --kb-canvas: var(--ts-surface);
  --kb-sidebar: var(--ts-sidebar);
  --kb-sidebar-raised: var(--ts-sidebar-raised);
  --kb-sidebar-text: var(--ts-sidebar-text);
  --kb-sidebar-muted: var(--ts-sidebar-muted);
  --kb-text: var(--ts-text);
  --kb-text-soft: var(--ts-text-soft);
  --kb-text-muted: var(--ts-text-muted);
  --kb-line: var(--ts-line);
  --kb-line-strong: var(--ts-line-strong);
  --kb-accent: var(--ts-accent);
  --kb-accent-strong: var(--ts-accent-strong);
  --kb-accent-soft: var(--ts-accent-soft);
  --kb-danger: var(--ts-danger);
  --kb-success: var(--ts-success);
  --kb-shadow-panel: var(--ts-shadow-panel);
  --surface: var(--ts-surface);
  --muted-surface: var(--ts-surface-raised);
  --border: var(--ts-line);
  --text: var(--ts-text);
  --accent: var(--ts-accent);
  --danger: var(--ts-danger);
`

/** @param {string} hex */
function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

/**
 * Self-contained CSS; no @imports, font downloads, layout or host-theme writes.
 * A repeated plugin attribute gives overrides precedence over lazy host CSS,
 * without !important and without touching other plugins' private components.
 * Removing the attribute or disposing the injected stylesheet restores the host.
 * @param {Theme[]} themes
 * @returns {string}
 */
function buildThemeCss(themes) {
  const palettes = themes.map((theme) => {
    if (!/^[a-z][a-z0-9-]*$/.test(theme.id) || !['light', 'dark'].includes(theme.mode)) {
      throw new Error('Invalid theme definition')
    }
    const declarations = Object.entries(theme.colors).map(([name, value]) => {
      if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid theme color: ${name}`)
      const token = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      return `--ts-${token}: ${value};`
    })
    const onAccent = luminance(theme.colors.accent) > 0.179 ? '#101827' : '#ffffff'
    return `:root[data-knowbook-theme-switcher='${theme.id}'] {
      ${declarations.join('\n      ')}
      --ts-on-accent: ${onAccent};
      --ts-color-scheme: ${theme.mode};
      --ts-shadow-panel: 0 10px 30px rgba(0, 0, 0, ${theme.mode === 'dark' ? '0.16' : '0.055'});
    }`
  }).join('\n')

  const root = 'html:root[data-knowbook-theme-switcher][data-knowbook-theme-switcher]'
  /** @param {string} selectors @param {string} declarations */
  const rule = (selectors, declarations) => `${root} :is(${selectors}) { ${declarations} }`
  const surface = 'background: var(--ts-surface); color: var(--ts-text); border-color: var(--ts-line);'
  const raised = 'background: var(--ts-surface-raised); color: var(--ts-text); border-color: var(--ts-line);'
  const selected = 'background: var(--ts-accent-soft); color: var(--ts-text); border-color: var(--ts-accent);'

  return `${palettes}
${root}, ${root} .content { ${hostTokens} }
${root} {
  color-scheme: var(--ts-color-scheme);
  background: var(--ts-background);
  color: var(--ts-text);
  accent-color: var(--ts-accent);
}
${rule('body, .shell, .content, .content.page-plugins, .content.page-database, .content.management-page',
    'background: var(--ts-background); color: var(--ts-text);')}
${rule('.content.page-documents, .workspace-grid, .preview-panel', surface)}
${rule(`.panel, .hero, .stat-card, .plugin-item, .plugin-dashboard-card,
  .management-page-header, .settings-group, .settings-card, .document-summary-card,
  .document-row, .database-panel, .database-entity-card, .database-schema-chip,
  .assistant-transcript, .assistant-message-assistant, .assistant-approval,
  .block-rich-media-image-card, .plugin-view, .plugin-sandbox,
  .toc-panel, .relation-panel, .document-header-shell,
  .document-header-action-menu, .block-context-menu, .document-tree-context-menu,
  .global-search-modal, .floating-slash-command-panel, .block-tags-filter-panel,
  .block-rich-media-link, .dbw-shell, .plugin-overview-card,
  .plugin-inventory-panel .plugin-item, .plugin-lifecycle-card,
  .system-plugin-request, .plugin-customizer, .plugin-technical-details > details`, surface)}
${rule(`.panel, .hero, .stat-card, .management-page-header, .settings-group,
  .settings-card, .document-summary-card, .plugin-dashboard-card`, 'box-shadow: var(--ts-shadow-panel);')}
${rule(`.document-aux-sidebar, .event-feed-item, .ai-context-card, .relation-chip,
  .empty-preview, .block-media-source-toggle, .assistant-tool-event,
  .assistant-lifecycle-event, .assistant-revision-preview pre, .inline-code,
  .block-math, .block-math-preview, .slash-command-search,
  .plugin-customizer-context span`, raised)}
${rule('.plugin-page-hero, .panel-accent, .assistant-message-user', selected)}
${rule(`input, textarea, select, .editor-input, .editor-textarea, .editor-select,
  .compact-select, .table-search, .secondary-button, .document-header-icon-button,
  .plugin-search, .plugin-customizer-close`, surface)}
${rule('.block-inline-textarea, .global-search-input, .plugin-search input, .block-tags-input',
    'background: transparent; color: var(--ts-text);')}
${rule('.block-rich-media-source-input.expanded', raised)}
${rule('.block-inline-textarea.type-quote', 'border-color: var(--ts-accent); color: var(--ts-text-soft);')}
${rule(`.secondary-button:hover:not(:disabled), .document-header-icon-button:hover,
  .context-menu-item:hover, .global-search-result:hover, .slash-command-item:hover, .toc-item:hover,
  .block-editor-row:hover, .block-rich-media-link:hover, .block-media-source-toggle:hover,
  .plugin-inventory-panel .plugin-item:hover`, raised)}
${rule(`.document-header-icon-button.active, .block-editor-row-selected,
  .block-editor-row-selected:hover, .context-menu-item-active, .slash-command-item-active,
  .database-entity-card-selected, .page-nav-item-active,
  .plugin-inventory-panel .plugin-item.selected,
  .plugin-filter-tabs button.active, .plugin-filter-tabs button:hover`, selected)}
${rule('.primary-button, .document-header-save-button, .dbw-primary-button, .dbw-save-button, .plugin-inspector-ai',
    'background: var(--ts-accent); border-color: var(--ts-accent); color: var(--ts-on-accent);')}
${rule('.primary-button:hover:not(:disabled), .document-header-save-button:hover, .dbw-save-button:hover:not(:disabled)',
    'background: var(--ts-accent-strong); border-color: var(--ts-accent-strong); color: var(--ts-on-accent);')}
${rule('.danger-button, .dbw-danger-quiet-button, .plugin-inspector-error, .plugin-inventory-item > .plugin-error, .plugin-technical-error',
    'background: color-mix(in srgb, var(--ts-danger) 12%, var(--ts-surface)); border-color: color-mix(in srgb, var(--ts-danger) 35%, var(--ts-line)); color: var(--ts-danger);')}
${rule(`.document-header-title, .block-inline-textarea.type-heading-1,
  .block-inline-textarea.type-heading-2, .context-menu-item, .global-search-doc-title,
  .document-tree-context-title, .slash-command-item, .slash-command-label,
  .block-media-source-toggle-copy strong, .block-rich-media-link-copy strong,
  .plugin-page-heading h3, .plugin-overview-card strong, .plugin-inventory-head h4,
  .plugin-card-title-row > strong, .plugin-inspector h4, .plugin-detail-grid strong,
  .plugin-lifecycle-head strong`, 'color: var(--ts-text);')}
${rule(`.eyebrow, .panel-label, .stat-label, .pill, .mini-hint, .empty-text,
  .tree-path, .page-nav-item span, .plugin-item-meta, .document-updated,
  .editor-label, .toggle-row, .global-search-doc-path, .context-menu-label,
  .plugin-page-heading p, .plugin-inventory-head p, .plugin-card-copy > p,
  .plugin-inspector-description, .plugin-customizer-intro, .document-tree-context-hint,
  .slash-command-query, .slash-command-description, .slash-command-empty,
  .plugin-card-meta, .plugin-inspector-title small, .plugin-inspector-head code, .plugin-overview-card small,
  .plugin-lifecycle-card li span, .plugin-lifecycle-card li code`, 'color: var(--ts-text-muted);')}
${rule('.global-search-snippet, .document-summary-preview, .settings-card-description, .settings-release-notes', 'color: var(--ts-text-soft);')}
${rule('.inline-link, .inline-link-block, .plugin-text-action, .plugin-ai-action, .slash-command-id, .slash-command-search-icon', 'color: var(--ts-accent);')}
${rule('.context-menu-item-danger', 'color: var(--ts-danger);')}
${rule(`.document-header-shell, .global-search-header, .context-menu-section,
  .document-aux-sidebar-content > * + *, .plugin-detail-grid, .plugin-detail-grid > div,
  .plugin-filter-tabs, .plugin-revision-list, .plugin-runtime-log-list,
  .plugin-revision-list > div, .plugin-runtime-log-list > div`, 'border-color: var(--ts-line);')}
${rule('.plugin-permission-list code, .plugin-view-badge, .block-media-source-toggle-icon, .block-tag-badge, .global-search-match-badge, .plugin-avatar, .plugin-ai-badge',
    'background: var(--ts-accent-soft); border-color: var(--ts-line); color: var(--ts-accent-strong);')}
${rule('.content.page-plugins .plugin-status-running',
    'background: color-mix(in srgb, var(--ts-success) 13%, var(--ts-surface)); color: var(--ts-success);')}
${rule('.content.page-plugins .plugin-status-loading', 'background: var(--ts-accent-soft); color: var(--ts-accent);')}
${rule('.content.page-plugins .plugin-status-disabled, .content.page-plugins .plugin-status-stopped',
    'background: var(--ts-surface-raised); color: var(--ts-text-muted);')}
${rule('.content.page-plugins .plugin-status-error, .plugin-runtime-log-list > .level-error > span',
    'background: color-mix(in srgb, var(--ts-danger) 13%, var(--ts-surface)); color: var(--ts-danger);')}
${rule('.plugin-switch > span', 'background: var(--ts-line-strong);')}
${rule('.plugin-switch input:checked + span', 'background: var(--ts-accent);')}

/* Sidebar keeps its own contrast system, including controls and selected rows. */
${rule('.sidebar', 'background: var(--ts-sidebar); color: var(--ts-sidebar-text); border-color: var(--ts-sidebar-raised);')}
${rule('.sidebar .brand-mini-copy strong, .sidebar .sidebar-section-heading', 'color: var(--ts-sidebar-text);')}
${rule(`.sidebar .nav-icon-btn, .sidebar .icon-btn, .sidebar .sidebar-create-button,
  .sidebar .tree-button, .sidebar .sidebar-search-button, .sidebar .root-drop-zone, .sidebar .root-drop-zone-compact,
  .sidebar .pinned-doc-item-compact, .sidebar .sidebar-section-count,
  .sidebar .sidebar-subsection-label, .sidebar .tree-button > small,
  .sidebar .sidebar-search-button kbd`, 'color: var(--ts-sidebar-muted);')}
${rule('.sidebar .sidebar-search-button, .sidebar .root-drop-zone, .sidebar .root-drop-zone-compact',
    'background: var(--ts-sidebar-raised); border-color: var(--ts-sidebar-raised);')}
${rule(`.sidebar .nav-icon-btn:hover, .sidebar .nav-icon-btn.active,
  .sidebar .icon-btn:hover:not(:disabled), .sidebar .tree-button:hover,
  .sidebar .tree-button-active, .sidebar .pinned-doc-item-active,
  .sidebar .sidebar-search-button:hover, .sidebar .sidebar-create-button:hover,
  .sidebar .root-drop-zone-active`,
    'background: var(--ts-sidebar-raised); color: var(--ts-sidebar-text); border-color: var(--ts-sidebar-muted);')}
${rule('.sidebar .rail-horizontal, .sidebar .tree-children', 'border-color: var(--ts-sidebar-raised);')}
${rule('.brand-mark-mini, .dbw-database-mark', 'background: var(--ts-accent); color: var(--ts-on-accent);')}

/* Database pages define a separate token set and sticky table surfaces. */
${root} .page-database .dbw-shell {
  --dbw-bg: var(--ts-surface); --dbw-canvas: var(--ts-background);
  --dbw-line: var(--ts-line); --dbw-line-strong: var(--ts-line-strong);
  --dbw-text: var(--ts-text); --dbw-text-soft: var(--ts-text-soft);
  --dbw-muted: var(--ts-text-muted); --dbw-soft: var(--ts-surface-raised);
  --dbw-accent: var(--ts-accent); --dbw-accent-soft: var(--ts-accent-soft);
  --dbw-danger: var(--ts-danger);
}
${rule(`.page-database .dbw-header, .page-database .dbw-popover,
  .page-database .dbw-search-field, .page-database .dbw-view-tabs,
  .page-database .dbw-toolbar, .page-database .dbw-table-scroll,
  .page-database .dbw-record-card, .page-database .dbw-board-card,
  .page-database .dbw-drawer, .page-database .dbw-dialog,
  .page-database .dbw-add-field-button, .page-database .dbw-shell input,
  .page-database .dbw-shell select, .page-database .dbw-shell textarea`, surface)}
${rule('.page-database .dbw-canvas', 'background: var(--ts-background);')}
${rule(`.page-database .dbw-quiet-button, .page-database .dbw-open-document-button,
  .page-database .dbw-icon-button, .page-database .dbw-layout-switcher,
  .page-database .dbw-board-column`, raised)}
${rule(`.page-database .dbw-view-tab, .page-database .dbw-new-view-menu > summary,
  .page-database .dbw-toolbar-menu > summary, .page-database .dbw-toolbar-button,
  .page-database .dbw-toolbar-select, .page-database .dbw-toolbar-select select,
  .page-database .dbw-record-title strong, .page-database .dbw-card-body dd`, 'color: var(--ts-text);')}
${rule('.page-database .dbw-table .dbw-title-column', surface)}
${rule('.page-database .dbw-table th, .page-database .dbw-table th.dbw-title-column',
    'background: var(--ts-surface-raised); color: var(--ts-text-muted);')}
${rule('.page-database .dbw-table th, .page-database .dbw-table td', 'border-color: var(--ts-line);')}
${rule('.page-database .dbw-table tbody tr:hover td, .page-database .dbw-table tbody tr:hover .dbw-title-column', raised)}
${rule('.page-database .dbw-table tbody tr.is-selected td, .page-database .dbw-table tbody tr.is-selected .dbw-title-column, .page-database .dbw-layout-switcher button[aria-pressed="true"]', selected)}
${rule('.page-database .dbw-search-field input, .page-database .dbw-toolbar-select select, .page-database .dbw-table .catalog-cell-input', 'background: transparent;')}
${rule('.page-database .dbw-save-button:disabled', 'background: var(--ts-surface-raised); color: var(--ts-text-muted);')}
${rule('.page-database .dbw-danger-quiet-button',
    'background: color-mix(in srgb, var(--ts-danger) 12%, var(--ts-surface)); border-color: var(--ts-danger); color: var(--ts-danger);')}

${root} :is(button, input, textarea, select, summary):focus-visible {
  outline-color: var(--ts-accent);
}
${root} :is(.editor-input, .editor-textarea, .editor-select):focus {
  border-color: var(--ts-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ts-accent) 18%, transparent);
}
${root} ::placeholder { color: var(--ts-text-muted); }
${root} ::selection { background: var(--ts-accent-soft); color: var(--ts-text); }
${root} * { scrollbar-color: var(--ts-line-strong) transparent; }
${root} ::-webkit-scrollbar-thumb { background: var(--ts-line-strong); }
`
}

module.exports = { buildThemeCss }
