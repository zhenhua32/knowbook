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

const pageIcons: Record<string, string> = {
  documents: '📂',
  dashboard: '📊',
  database: '🗄️',
  graph: '🕸️',
  ai: '🤖',
  plugins: '🔌',
  settings: '⚙️'
}

export function PageRail(props: PageRailProps) {
  const {
    activePage,
    pageItems,
    onSelectPage,
    pageTitle,
    brandEyebrow,
    isCollapsed = false,
    onToggleCollapse,
    collapseTitle,
    expandTitle
  } = props

  const toggleTitle = isCollapsed ? expandTitle : collapseTitle

  return (
    <div className="rail-horizontal" title={pageTitle}>
      <div className="brand-mini" title={brandEyebrow}>
        <span className="brand-mark-mini">KB</span>
      </div>
      <div className="page-nav-horizontal">
        {pageItems.map((item) => (
          <button
            className={`nav-icon-btn ${activePage === item.id ? 'active' : ''}`}
            key={item.id}
            onClick={() => onSelectPage(item.id)}
            title={item.label}
            type="button"
          >
            <span className="nav-icon">{pageIcons[item.id] || '📄'}</span>
          </button>
        ))}
      </div>
      {onToggleCollapse ? (
        <button
          aria-label={toggleTitle}
          className="nav-icon-btn rail-toggle-btn"
          onClick={onToggleCollapse}
          title={toggleTitle}
          type="button"
        >
          <span className="nav-icon">{isCollapsed ? '»' : '«'}</span>
        </button>
      ) : null}
    </div>
  )
}
