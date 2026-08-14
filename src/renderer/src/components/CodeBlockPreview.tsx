import { useEffect, useMemo, useState } from 'react'
import {
  highlightCode,
  isCodeHighlightLanguageLoaded,
  loadCodeHighlightLanguage,
  resolveCodeHighlightLanguage,
  type SupportedCodeLanguage
} from '../utils/codeHighlighting'

type CodeBlockPreviewProps = {
  code: string
  label: string
  language: string | null
}

export function CodeBlockPreview({ code, label, language }: CodeBlockPreviewProps) {
  const resolved = useMemo(() => resolveCodeHighlightLanguage(language), [language])
  const [loadedLanguage, setLoadedLanguage] = useState<SupportedCodeLanguage | null>(() => (
    resolved && isCodeHighlightLanguageLoaded(resolved) ? resolved : null
  ))

  useEffect(() => {
    let active = true
    if (!resolved) {
      setLoadedLanguage(null)
      return () => {
        active = false
      }
    }

    setLoadedLanguage((current) => current === resolved ? current : null)
    void loadCodeHighlightLanguage(resolved).then((loaded) => {
      if (active) {
        setLoadedLanguage(loaded)
      }
    }).catch(() => {
      if (active) {
        setLoadedLanguage(null)
      }
    })

    return () => {
      active = false
    }
  }, [resolved])

  const highlighted = useMemo(() => {
    return highlightCode(code, loadedLanguage === resolved ? resolved : null)
  }, [code, loadedLanguage, resolved])

  return (
    <div aria-label={label} className="block-code-wrapper" role="region">
      <span className="block-code-language">{highlighted.language ?? resolved ?? language ?? 'text'}</span>
      <pre className="block-code-hljs">
        <code
          className={highlighted.language ? `hljs language-${highlighted.language}` : 'hljs'}
          dangerouslySetInnerHTML={{ __html: highlighted.value }}
        />
      </pre>
    </div>
  )
}
