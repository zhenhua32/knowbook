import { createContext } from 'react'

export const MarkdownNavigationContext = createContext<((url: string) => void) | undefined>(undefined)
