import { useEffect, useMemo, useState } from 'react'
import type { DocumentCatalogEntry, DocumentDatabaseColumn, HomeData } from '@shared/contracts'
import {
  UI_LANGUAGE_SETTING_KEY,
  detectPreferredUiLanguage,
  getUiText,
  isUiLanguage,
  setActiveUiLanguage,
  type UiLanguage
} from '../i18n'

const emptyState: HomeData = {
  summary: {
    databasePath: '',
    backupRoot: '',
    documents: 0,
    blocks: 0,
    links: 0,
    lastBackupAt: null
  },
  recentDocuments: [],
  recentEvents: [],
  documentCatalog: [],
  databaseColumns: [],
  aiConfig: {
     enabled: false,
     baseUrl: '',
     model: '',
     autoSummaryOnSave: false,
     relatedNotesEnabled: true,
     hasApiKey: false
   },
  documentTree: [],
  graph: {
    nodes: [],
    edges: []
  },
  initialDocumentId: null,
  plugins: [],
  pluginDashboardCards: [],
  pluginDocumentActions: [],
  pluginHost: {
    roots: [],
    writableRoot: null
  }
}

export type PageId = 'dashboard' | 'documents' | 'database' | 'graph' | 'ai' | 'plugins' | 'settings'

export const PAGE_ORDER: PageId[] = ['documents', 'dashboard', 'database', 'graph', 'ai', 'plugins', 'settings']

type PageItem = {
  id: PageId
  label: string
  description: string
}

export function useAppShellState() {
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(detectPreferredUiLanguage())
  const [uiLanguageHydrated, setUiLanguageHydrated] = useState(false)
  const [homeData, setHomeData] = useState<HomeData>(emptyState)
  const [catalogColumns, setCatalogColumns] = useState<DocumentDatabaseColumn[]>([])
  const [catalogDocuments, setCatalogDocuments] = useState<DocumentCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [activePage, setActivePage] = useState<PageId>('documents')
  const [backupMessage, setBackupMessage] = useState<string | null>(null)

  setActiveUiLanguage(uiLanguage)
  const ui = getUiText(uiLanguage)
  const isZh = uiLanguage === 'zh-CN'

  useEffect(() => {
    let mounted = true

    const refreshHomeData = async () => {
      const data = await window.knowbook.getHomeData()
      if (!mounted) {
        return
      }

      setHomeData(data)
      setLoading(false)
    }

    void refreshHomeData().catch((error) => {
      console.warn('Failed to load home data.', error)
    })

    window.knowbook.getSetting(UI_LANGUAGE_SETTING_KEY).then((value) => {
      if (!mounted) {
        return
      }

      if (isUiLanguage(value)) {
        setUiLanguage(value)
      }
      setUiLanguageHydrated(true)
    })

    const unsubscribe = window.knowbook.onWorkspaceMutated(() => {
      void refreshHomeData().catch((error) => {
        console.warn('Failed to refresh workspace after external mutation.', error)
      })
    })

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    setCatalogColumns(homeData.databaseColumns)
    setCatalogDocuments(homeData.documentCatalog)
  }, [homeData.databaseColumns, homeData.documentCatalog])

  useEffect(() => {
    if (!uiLanguageHydrated) {
      return
    }

    void window.knowbook.saveSetting(UI_LANGUAGE_SETTING_KEY, uiLanguage)
  }, [uiLanguage, uiLanguageHydrated])

  useEffect(() => {
    document.documentElement.lang = uiLanguage
  }, [uiLanguage])

  useEffect(() => {
    if (!backupMessage) {
      return
    }

    const timer = setTimeout(() => setBackupMessage(null), 3000)
    return () => clearTimeout(timer)
  }, [backupMessage])

  const pageItems = useMemo<PageItem[]>(() => [
    {
      id: 'documents',
      label: isZh ? '文档' : 'Documents',
      description: isZh ? '目录树 + 编辑器' : 'Tree + editor'
    },
    {
      id: 'dashboard',
      label: isZh ? '总览' : 'Dashboard',
      description: isZh ? '工作区状态与统计' : 'Workspace summary'
    },
    {
      id: 'database',
      label: isZh ? '数据库' : 'Database',
      description: isZh ? '表格与看板视图' : 'Table + board views'
    },
    {
      id: 'graph',
      label: isZh ? '图谱' : 'Graph',
      description: isZh ? '知识关系拓扑' : 'Knowledge topology'
    },
    {
      id: 'ai',
      label: isZh ? 'AI 助手' : 'AI Assistant',
      description: isZh ? '问答与检索增强' : 'Q&A and semantic retrieval'
    },
    {
      id: 'plugins',
      label: isZh ? '插件中心' : 'Plugins',
      description: isZh ? '插件安装与管理' : 'Plugin management'
    },
    {
      id: 'settings',
      label: isZh ? '配置中心' : 'Settings',
      description: isZh ? '语言、AI、备份' : 'Language, AI, backup'
    }
  ], [isZh])

  const activePageItem = useMemo(
    () => pageItems.find((item) => item.id === activePage),
    [activePage, pageItems]
  )

  return {
    activePage,
    backupMessage,
    catalogColumns,
    catalogDocuments,
    homeData,
    isZh,
    loading,
    pageDescription: activePageItem?.description ?? '',
    pageItems,
    pageTitle: activePageItem?.label ?? '',
    setActivePage,
    setBackupMessage,
    setCatalogColumns,
    setCatalogDocuments,
    setHomeData,
    setUiLanguage,
    ui,
    uiLanguage
  }
}