import type { ReactNode } from 'react'

type RailPageItem = {
  id: string
  label: string
  description: string
}

type PageRailProps = {
  brandEyebrow: string
  activePage: string
  pageItems: RailPageItem[]
  onSelectPage: (pageId: string) => void
  pageTitle: string
  pageDescription: string
  navLabel: string
  currentPageLabel: string
  currentPageHint: string
  isCollapsed?: boolean
  onToggleCollapse?: () => void
  collapseTitle?: string
  expandTitle?: string
}

export function PageRail(props: PageRailProps) {
  const {
    activePage,
    pageItems,
    onSelectPage,
    pageTitle,
    brandEyebrow,
    navLabel,
    isCollapsed = false,
    onToggleCollapse,
    collapseTitle,
    expandTitle
  } = props

  const toggleTitle = isCollapsed ? expandTitle : collapseTitle

  return (
    <div className="rail-horizontal">
      <div className="brand-mini" title={brandEyebrow}>
        <span className="brand-mark-mini">KB</span>
        <span className="brand-mini-copy">
          <strong>KnowBook</strong>
          <small>{pageTitle}</small>
        </span>
        {onToggleCollapse ? (
          <button
            aria-label={toggleTitle}
            className="nav-icon-btn rail-toggle-btn"
            onClick={onToggleCollapse}
            title={toggleTitle}
            type="button"
          >
            <PanelToggleIcon collapsed={isCollapsed} />
          </button>
        ) : null}
      </div>
      <nav aria-label={navLabel} className="page-nav-horizontal">
        {pageItems.map((item) => (
          <button
            className={`nav-icon-btn ${activePage === item.id ? 'active' : ''}`}
            key={item.id}
            onClick={() => onSelectPage(item.id)}
            title={item.label}
            type="button"
          >
            <span className="nav-icon"><PageIcon pageId={item.id} /></span>
            <span className="nav-item-label">{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

function PageIcon({ pageId }: { pageId: string }) {
  const icons: Record<string, ReactNode> = {
    documents: (
      <>
        <path d="M5 4.5h4l1.5 1.8H19v10.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2Z" />
        <path d="M3.5 8.5h15" />
      </>
    ),
    dashboard: (
      <>
        <rect height="6" rx="1.5" width="6" x="3" y="3" />
        <rect height="9" rx="1.5" width="6" x="13" y="3" />
        <rect height="9" rx="1.5" width="6" x="3" y="12" />
        <rect height="6" rx="1.5" width="6" x="13" y="15" />
      </>
    ),
    database: (
      <>
        <ellipse cx="11" cy="5" rx="7.5" ry="3" />
        <path d="M3.5 5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5" />
        <path d="M3.5 11v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
      </>
    ),
    ai: (
      <>
        <path d="m11 3 1.2 3.8L16 8l-3.8 1.2L11 13l-1.2-3.8L6 8l3.8-1.2L11 3Z" />
        <path d="m17.5 13 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" />
        <path d="m5 14 .6 1.8 1.9.7-1.9.6L5 19l-.6-1.9-1.9-.6 1.9-.7L5 14Z" />
      </>
    ),
    plugins: (
      <>
        <path d="M8 3v5H3" />
        <path d="M16 3v5h5" />
        <path d="M8 21v-5H3" />
        <path d="M16 21v-5h5" />
        <rect height="8" rx="2" width="8" x="8" y="8" />
      </>
    ),
    settings: (
      <>
        <circle cx="11" cy="11" r="3" />
        <path d="M18.4 13.8a1.5 1.5 0 0 0 .3 1.7l.1.1-2.2 2.2-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4V19h-3v-.2a1.5 1.5 0 0 0-.9-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1L6 15.6l.1-.1a1.5 1.5 0 0 0 .3-1.7A1.5 1.5 0 0 0 5 12.9H4v-3h1a1.5 1.5 0 0 0 1.4-.9 1.5 1.5 0 0 0-.3-1.7L6 7.2 8.2 5l.1.1a1.5 1.5 0 0 0 1.7.3 1.5 1.5 0 0 0 .9-1.4v-.2h3V4a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1 2.2 2.2-.1.1a1.5 1.5 0 0 0-.3 1.7 1.5 1.5 0 0 0 1.4.9h.2v3h-.2a1.5 1.5 0 0 0-1.4.9Z" />
      </>
    )
  }

  return (
    <svg aria-hidden="true" className="nav-icon-svg" viewBox="0 0 24 24">
      {icons[pageId] ?? <path d="M6 3h9l4 4v14H6z M15 3v5h4" />}
    </svg>
  )
}

function PanelToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg aria-hidden="true" className="nav-icon-svg" viewBox="0 0 24 24">
      <rect height="16" rx="2.5" width="18" x="3" y="4" />
      <path d="M9 4v16" />
      <path d={collapsed ? 'm13 9 3 3-3 3' : 'm16 9-3 3 3 3'} />
    </svg>
  )
}
