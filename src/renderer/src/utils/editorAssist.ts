export type EditorLinkContext = {
  query: string
  start: number
}

export type EditorSlashCommandContext = {
  query: string
  start: number
}

export type SlashCommandRemoval = {
  content: string
  cursorPosition: number
}

export function getOpenLinkContext(
  content: string,
  cursorPosition: number
): EditorLinkContext | null {
  const safeCursor = clampCursorPosition(content, cursorPosition)
  const beforeCursor = content.slice(0, safeCursor)
  const start = beforeCursor.lastIndexOf('[[')

  if (start === -1) {
    return null
  }

  const openSegment = beforeCursor.slice(start + 2)
  if (openSegment.includes(']]') || openSegment.includes('\n')) {
    return null
  }

  return {
    query: openSegment.trim(),
    start
  }
}

export function getSlashCommandContext(
  content: string,
  cursorPosition: number
): EditorSlashCommandContext | null {
  const safeCursor = clampCursorPosition(content, cursorPosition)
  const beforeCursor = content.slice(0, safeCursor)
  const lineStart = beforeCursor.lastIndexOf('\n') + 1
  const lineBeforeCursor = beforeCursor.slice(lineStart)
  const trimmedStart = lineBeforeCursor.trimStart()

  if (!trimmedStart.startsWith('/')) {
    return null
  }

  const query = trimmedStart.slice(1)
  if (/\s/.test(query)) {
    return null
  }

  return {
    query,
    start: lineStart + lineBeforeCursor.indexOf('/')
  }
}

export function removeSlashCommand(
  content: string,
  start: number,
  cursorPosition: number
): SlashCommandRemoval {
  const safeCursor = clampCursorPosition(content, cursorPosition)
  const safeStart = Math.max(0, Math.min(start, safeCursor))
  const nextContent = `${content.slice(0, safeStart)}${content.slice(safeCursor)}`
  const normalizedContent = nextContent.trim() === '' ? '' : nextContent

  return {
    content: normalizedContent,
    cursorPosition: Math.min(safeStart, normalizedContent.length)
  }
}

function clampCursorPosition(content: string, cursorPosition: number): number {
  return Number.isFinite(cursorPosition)
    ? Math.max(0, Math.min(Math.trunc(cursorPosition), content.length))
    : content.length
}
