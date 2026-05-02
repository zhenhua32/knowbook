const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  cs: 'csharp',
  'c#': 'csharp',
  rb: 'ruby',
  yml: 'yaml',
  md: 'markdown',
  html: 'html',
  htm: 'html'
}

export function normalizeCodeLanguage(language?: string | null): string | null {
  const normalized = language?.trim().toLowerCase()
  if (!normalized) {
    return null
  }

  return LANGUAGE_ALIASES[normalized] ?? normalized
}

function scoreLanguage(scores: Map<string, number>, language: string, weight: number) {
  scores.set(language, (scores.get(language) ?? 0) + weight)
}

export function detectCodeLanguage(content: string, preferredLanguage?: string | null): string | null {
  const explicitLanguage = normalizeCodeLanguage(preferredLanguage)
  if (explicitLanguage) {
    return explicitLanguage
  }

  const sample = content.trim()
  if (!sample) {
    return null
  }

  if (sample.startsWith('{') || sample.startsWith('[')) {
    try {
      JSON.parse(sample)
      return 'json'
    } catch {
      // Fall through to heuristic scoring.
    }
  }

  const scores = new Map<string, number>()

  if (/<!DOCTYPE html>|<html\b|<body\b|<div\b|<span\b|<script\b|<style\b|<\/\w+>/i.test(sample)) {
    scoreLanguage(scores, 'html', 5)
  }

  if (/^\s*[.#]?[-_a-zA-Z][-_a-zA-Z0-9\s,:>+~.[\]()#]*\s*\{[\s\S]*:[\s\S]*;?/m.test(sample)) {
    scoreLanguage(scores, 'css', 4)
  }

  if (/\bSELECT\b[\s\S]*\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\b[\s\S]*\bSET\b|\bDELETE\s+FROM\b/i.test(sample)) {
    scoreLanguage(scores, 'sql', 5)
  }

  if (/^#!.*\b(bash|sh|zsh)\b|\becho\b|\bfi\b|\bgrep\b|\bnpm\s+run\b|\byarn\b|\bpnpm\b|\$\{/m.test(sample)) {
    scoreLanguage(scores, 'bash', 4)
  }

  if (
    /\bdef\s+\w+\s*\(|\bself\b|\belif\b|__name__|print\(/.test(sample)
    || /(^|\n)\s*from\s+[A-Za-z_][\w.]*\s+import\s+.+$/m.test(sample)
    || /(^|\n)\s*import\s+[A-Za-z_][\w.]*(\s*,\s*[A-Za-z_][\w.]*)*\s*$/m.test(sample)
  ) {
    scoreLanguage(scores, 'python', 5)
  }

  if (/\binterface\s+\w+\b|\btype\s+\w+\s*=|\bimplements\b|\breadonly\b|\bunknown\b|\bas\s+const\b|:\s*(?:string|number|boolean|unknown|any|never|void|object|Record<[^>]+>|Array<[^>]+>|[A-Z][A-Za-z0-9_<>, [\]|?]+)(?=\s*[=;)])/m.test(sample)) {
    scoreLanguage(scores, 'typescript', 5)
  }

  if (/\bconst\b|\blet\b|\bfunction\b|=>|console\.log\(|document\.|window\.|export\s+default\b|import\s+.+\s+from\b/.test(sample)) {
    scoreLanguage(scores, 'javascript', 4)
  }

  if (/\bpackage\s+[a-z0-9_.]+\s*;|System\.out\.print|import\s+java\.|\bpublic\s+static\s+void\s+main\s*\(/.test(sample)) {
    scoreLanguage(scores, 'java', 5)
  }

  if (/\busing\s+System\b|\bnamespace\s+\w+|Console\.Write(Line)?\(|\bpublic\s+(class|record|interface)\b/.test(sample)) {
    scoreLanguage(scores, 'csharp', 5)
  }

  if (/\bpackage\s+main\b|\bfunc\s+\w+\s*\(|fmt\.Print|:=/.test(sample)) {
    scoreLanguage(scores, 'go', 5)
  }

  if (/\bfn\s+\w+\s*\(|\blet\s+mut\b|println!\(|use\s+\w+(::\w+)+/.test(sample)) {
    scoreLanguage(scores, 'rust', 5)
  }

  if (/^\s*---\s*$[\s\S]*?:\s*.+/m.test(sample) || /:\s*[>|]-?\s*$/m.test(sample)) {
    scoreLanguage(scores, 'yaml', 4)
  }

  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1])
  return ranked[0]?.[1] && ranked[0][1] >= 4 ? ranked[0][0] : null
}