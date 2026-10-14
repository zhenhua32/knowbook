import { createElement, type ReactNode } from 'react'
import '../styles/inline-text-presentation.css'

export default function InlineTextPresentation({ tag, attributes, children }: { tag: 'u' | 'span'; attributes: Record<string, string | undefined>; children: ReactNode }) {
  return createElement(tag, attributes, children)
}
