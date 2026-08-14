import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'

type LanguageModule = { default: LanguageFn }

const LANGUAGE_LOADERS = {
  bash: () => import('highlight.js/lib/languages/bash') as Promise<LanguageModule>,
  c: () => import('highlight.js/lib/languages/c') as Promise<LanguageModule>,
  cpp: () => import('highlight.js/lib/languages/cpp') as Promise<LanguageModule>,
  csharp: () => import('highlight.js/lib/languages/csharp') as Promise<LanguageModule>,
  css: () => import('highlight.js/lib/languages/css') as Promise<LanguageModule>,
  dockerfile: () => import('highlight.js/lib/languages/dockerfile') as Promise<LanguageModule>,
  go: () => import('highlight.js/lib/languages/go') as Promise<LanguageModule>,
  java: () => import('highlight.js/lib/languages/java') as Promise<LanguageModule>,
  javascript: () => import('highlight.js/lib/languages/javascript') as Promise<LanguageModule>,
  json: () => import('highlight.js/lib/languages/json') as Promise<LanguageModule>,
  kotlin: () => import('highlight.js/lib/languages/kotlin') as Promise<LanguageModule>,
  latex: () => import('highlight.js/lib/languages/latex') as Promise<LanguageModule>,
  lua: () => import('highlight.js/lib/languages/lua') as Promise<LanguageModule>,
  makefile: () => import('highlight.js/lib/languages/makefile') as Promise<LanguageModule>,
  markdown: () => import('highlight.js/lib/languages/markdown') as Promise<LanguageModule>,
  perl: () => import('highlight.js/lib/languages/perl') as Promise<LanguageModule>,
  php: () => import('highlight.js/lib/languages/php') as Promise<LanguageModule>,
  python: () => import('highlight.js/lib/languages/python') as Promise<LanguageModule>,
  r: () => import('highlight.js/lib/languages/r') as Promise<LanguageModule>,
  ruby: () => import('highlight.js/lib/languages/ruby') as Promise<LanguageModule>,
  rust: () => import('highlight.js/lib/languages/rust') as Promise<LanguageModule>,
  scss: () => import('highlight.js/lib/languages/scss') as Promise<LanguageModule>,
  sql: () => import('highlight.js/lib/languages/sql') as Promise<LanguageModule>,
  swift: () => import('highlight.js/lib/languages/swift') as Promise<LanguageModule>,
  typescript: () => import('highlight.js/lib/languages/typescript') as Promise<LanguageModule>,
  vim: () => import('highlight.js/lib/languages/vim') as Promise<LanguageModule>,
  xml: () => import('highlight.js/lib/languages/xml') as Promise<LanguageModule>,
  yaml: () => import('highlight.js/lib/languages/yaml') as Promise<LanguageModule>
} as const

export type SupportedCodeLanguage = keyof typeof LANGUAGE_LOADERS

const LANGUAGE_ALIASES: Record<string, SupportedCodeLanguage> = {
  shell: 'bash',
  sh: 'bash',
  zsh: 'bash',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  html: 'xml',
  htm: 'xml',
  yml: 'yaml',
  md: 'markdown'
}

const pendingLanguageLoads = new Map<SupportedCodeLanguage, Promise<SupportedCodeLanguage>>()

export function resolveCodeHighlightLanguage(language: string | null): SupportedCodeLanguage | null {
  const normalized = language?.trim().toLowerCase()
  if (!normalized) {
    return null
  }

  const resolved = LANGUAGE_ALIASES[normalized] ?? normalized
  return resolved in LANGUAGE_LOADERS ? resolved as SupportedCodeLanguage : null
}

export function isCodeHighlightLanguageLoaded(language: SupportedCodeLanguage): boolean {
  return Boolean(hljs.getLanguage(language))
}

export function loadCodeHighlightLanguage(
  language: string | null
): Promise<SupportedCodeLanguage | null> {
  const resolved = resolveCodeHighlightLanguage(language)
  if (!resolved) {
    return Promise.resolve(null)
  }
  if (isCodeHighlightLanguageLoaded(resolved)) {
    return Promise.resolve(resolved)
  }

  const pending = pendingLanguageLoads.get(resolved)
  if (pending) {
    return pending
  }

  const load = LANGUAGE_LOADERS[resolved]().then((module) => {
    if (!isCodeHighlightLanguageLoaded(resolved)) {
      hljs.registerLanguage(resolved, module.default)
    }
    return resolved
  }).finally(() => {
    pendingLanguageLoads.delete(resolved)
  })
  pendingLanguageLoads.set(resolved, load)
  return load
}

export type CodeHighlightResult = {
  value: string
  language?: string
}

function escapeCodeHtml(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function highlightCode(
  code: string,
  language: SupportedCodeLanguage | null
): CodeHighlightResult {
  if (!code) {
    return { value: '' }
  }
  if (!language || !isCodeHighlightLanguageLoaded(language)) {
    return { value: escapeCodeHtml(code) }
  }

  try {
    return hljs.highlight(code, { language })
  } catch {
    return { value: escapeCodeHtml(code) }
  }
}
