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

export function PageRail(props: PageRailProps) {
  const {
    brandEyebrow,
    activePage,
    pageItems,
    onSelectPage,
    pageTitle,
    pageDescription,
    navLabel,
    currentPageLabel,
    currentPageHint
  } = props

  return (
    <aside className="rail">
      <div className="brand">
        <span className="brand-mark">KB</span>
        <div>
          <p className="eyebrow">{brandEyebrow}</p>
          <h1>KnowBook</h1>
        </div>
      </div>

      <div className="panel">
        <p className="panel-label">{navLabel}</p>
        <div className="page-nav-list">
          {pageItems.map((item) => (
            <button
              className={`page-nav-item${activePage === item.id ? ' page-nav-item-active' : ''}`}
              key={item.id}
              onClick={() => onSelectPage(item.id)}
              type="button"
            >
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="panel panel-accent">
        <p className="panel-label">{currentPageLabel}</p>
        <h2>{pageTitle}</h2>
        <p>{pageDescription}</p>
        <p className="mini-hint">{currentPageHint}</p>
      </div>
    </aside>
  )
}
