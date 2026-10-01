import { MarkdownContent } from './MarkdownContent'

export function AiAnswerContent({ content }: { content: string }) {
  return <div className="ai-answer-content"><MarkdownContent content={content} hideImages /></div>
}
