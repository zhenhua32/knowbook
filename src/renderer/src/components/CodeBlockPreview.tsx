import { useMemo } from 'react'
import hljs from 'highlight.js'

type CodeBlockPreviewProps = {
  code: string
  language: string | null
}

const HLJS_SUPPORTED_LANGUAGES = new Set(hljs.listLanguages())

function resolveLanguage(language: string | null): string | null {
  if (!language) return null
  const normalized = language.trim().toLowerCase()
  if (!normalized) return null
  // aliases
  const alias: Record<string, string> = {
    shell: 'bash',
    sh: 'bash',
    zsh: 'bash',
    ts: 'typescript',
    js: 'javascript',
    py: 'python',
    rb: 'ruby',
    cs: 'csharp',
    'c++': 'cpp',
    yml: 'yaml',
    md: 'markdown'
  }
  const resolved = alias[normalized] ?? normalized
  return HLJS_SUPPORTED_LANGUAGES.has(resolved) ? resolved : null
}

export function CodeBlockPreview({ code, language }: CodeBlockPreviewProps) {
  const resolved = useMemo(() => resolveLanguage(language), [language])

  const highlighted = useMemo(() => {
    if (!code) return { value: '', language: undefined as string | undefined }
    try {
      if (resolved) {
        return hljs.highlight(code, { language: resolved })
      }
      return hljs.highlightAuto(code)
    } catch {
      const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return { value: escaped, language: undefined as string | undefined }
    }
  }, [code, resolved])

  return (
    <pre className="block-code-hljs">
      <code
        className={highlighted.language ? `hljs language-${highlighted.language}` : 'hljs'}
        dangerouslySetInnerHTML={{ __html: highlighted.value }}
      />
    </pre>
  )
}
