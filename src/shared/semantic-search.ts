interface SearchTerm {
  term: string
  weight: number
  compact: boolean
}

const CJK_CHARACTER_RE = /[\u3400-\u9fff]/u

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function buildCompactSearchText(value: string): string {
  return normalizeSearchText(value).replace(/[\s\p{P}\p{S}]+/gu, '')
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0
  }

  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function upsertTerm(terms: Map<string, SearchTerm>, term: string, weight: number, compact: boolean): void {
  if (!term) {
    return
  }

  const key = `${compact ? 'compact' : 'plain'}:${term}`
  const existing = terms.get(key)
  if (!existing || existing.weight < weight) {
    terms.set(key, { term, weight, compact })
  }
}

function buildSearchTerms(query: string): SearchTerm[] {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) {
    return []
  }

  const terms = new Map<string, SearchTerm>()
  normalizedQuery
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .forEach((word) => upsertTerm(terms, word, Math.min(word.length, 8), false))

  const compactQuery = buildCompactSearchText(normalizedQuery)
  if (compactQuery.length > 1 && CJK_CHARACTER_RE.test(compactQuery)) {
    upsertTerm(terms, compactQuery, Math.min(compactQuery.length * 1.25, 10), true)

    for (let index = 0; index < compactQuery.length - 1; index += 1) {
      upsertTerm(terms, compactQuery.slice(index, index + 2), 1.25, true)
    }
  }

  return [...terms.values()]
}

export function scoreKeywordSearchCandidate(query: string, text: string): number {
  const normalizedText = normalizeSearchText(text)
  if (!normalizedText) {
    return 0
  }

  const terms = buildSearchTerms(query)
  if (terms.length === 0) {
    return 0
  }

  const compactText = buildCompactSearchText(normalizedText)
  const totalWeight = terms.reduce((sum, term) => sum + term.weight, 0)
  let matchedWeight = 0
  let repetitionBonus = 0

  for (const term of terms) {
    const haystack = term.compact ? compactText : normalizedText
    const matches = countOccurrences(haystack, term.term)
    if (matches === 0) {
      continue
    }

    matchedWeight += term.weight
    repetitionBonus += Math.min(matches - 1, 2) * term.weight * 0.15
  }

  if (matchedWeight === 0 || totalWeight === 0) {
    return 0
  }

  return Number(Math.min((matchedWeight + repetitionBonus) / totalWeight, 1).toFixed(3))
}