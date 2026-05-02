import { useEffect, useMemo, useState } from 'react'
import { codeToHtml } from 'shiki'

type CodeBlockPreviewProps = {
  code: string
  language: string | null
}

const SHIKI_THEME = 'github-dark-default'
const SHIKI_SUPPORTED_LANGUAGES = new Set([
  'plaintext',
  'text',
  'javascript',
  'typescript',
  'python',
  'bash',
  'shell',
  'sql',
  'html',
  'css',
  'json',
  'yaml',
  'markdown',
  'java',
  'csharp',
  'go',
  'rust',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'xml',
  'dockerfile',
  'makefile',
  'c',
  'cpp',
  'scss',
  'latex'
])

function escapeHtml(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function normalizeShikiLanguage(language: string | null) {
  if (!language) {
    return 'plaintext'
  }

  const normalized = language.trim().toLowerCase()
  if (!normalized) {
    return 'plaintext'
  }

  if (normalized === 'shell') {
    return 'bash'
  }

  return SHIKI_SUPPORTED_LANGUAGES.has(normalized) ? normalized : 'plaintext'
}

export function CodeBlockPreview({ code, language }: CodeBlockPreviewProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null)
  const [highlightError, setHighlightError] = useState<string | null>(null)
  const normalizedLanguage = useMemo(() => normalizeShikiLanguage(language), [language])

  useEffect(() => {
    let cancelled = false

    async function highlight() {
      try {
        const html = await codeToHtml(code || ' ', {
          lang: normalizedLanguage,
          theme: SHIKI_THEME
        })

        if (!cancelled) {
          setHighlightedHtml(html)
          setHighlightError(null)
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Failed to highlight code'
          setHighlightError(message)
          setHighlightedHtml(null)
        }
      }
    }

    void highlight()

    return () => {
      cancelled = true
    }
  }, [code, normalizedLanguage])

  if (!highlightedHtml) {
    return (
      <pre className="block-code block-code-fallback" data-highlight-error={highlightError ? 'true' : 'false'}>
        <code>{code}</code>
      </pre>
    )
  }

  const sanitizedHtml = highlightedHtml
    .replace('<pre class="shiki', '<pre class="shiki block-code-shiki')
    .replace('<code>', '<code class="block-code-shiki-inner">')

  return <div className="block-code-html" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
}
