import { useMemo } from 'react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import latex from 'highlight.js/lib/languages/latex'
import lua from 'highlight.js/lib/languages/lua'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import perl from 'highlight.js/lib/languages/perl'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import r from 'highlight.js/lib/languages/r'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import vim from 'highlight.js/lib/languages/vim'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

type CodeBlockPreviewProps = {
  code: string
  label: string
  language: string | null
}

const LANGUAGE_DEFINITIONS = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dockerfile,
  go,
  java,
  javascript,
  json,
  kotlin,
  latex,
  lua,
  makefile,
  markdown,
  perl,
  php,
  python,
  r,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  vim,
  xml,
  yaml
}

for (const [language, definition] of Object.entries(LANGUAGE_DEFINITIONS)) {
  hljs.registerLanguage(language, definition)
}

const HLJS_SUPPORTED_LANGUAGES = new Set(Object.keys(LANGUAGE_DEFINITIONS))

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
    html: 'xml',
    htm: 'xml',
    yml: 'yaml',
    md: 'markdown'
  }
  const resolved = alias[normalized] ?? normalized
  return HLJS_SUPPORTED_LANGUAGES.has(resolved) ? resolved : null
}

export function CodeBlockPreview({ code, label, language }: CodeBlockPreviewProps) {
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
    <div aria-label={label} className="block-code-wrapper" role="region">
      <span className="block-code-language">{highlighted.language ?? language ?? 'text'}</span>
      <pre className="block-code-hljs">
        <code
          className={highlighted.language ? `hljs language-${highlighted.language}` : 'hljs'}
          dangerouslySetInnerHTML={{ __html: highlighted.value }}
        />
      </pre>
    </div>
  )
}
