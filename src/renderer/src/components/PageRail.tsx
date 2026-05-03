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
    brandEyebrow
  } = props

  return (
    <div className="rail-horizontal">
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
      <div className="current-page-mini" title={pageTitle}>
        <span className="current-page-text">{pageTitle}</span>
      </div>
    </div>
  )
}
