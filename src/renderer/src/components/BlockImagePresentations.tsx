import { lazy, Suspense, useMemo } from 'react'
import { planMarkdownImageDisplays, replaceMarkdownImageOccurrence, type MarkdownImageOccurrence } from '@shared/markdownMediaOccurrences'
import type { ImagePresentation } from '@shared/markdownMedia'
import type { MarkdownEnvironment } from '@shared/markdownEngine'
import { toBlockRichMediaPreviewUrl } from '../utils/blockRichMedia'

const ImagePresentationEditor = lazy(() => import('./ImagePresentationEditor').then(module => ({ default: module.ImagePresentationEditor })))

export type BlockImagePresentationsProps = {
  content: string
  isZh: boolean
  references?: MarkdownEnvironment['references']
  occurrences?: MarkdownImageOccurrence[]
  onCommit?: (occurrence: MarkdownImageOccurrence, next: ImagePresentation, nextContent: string) => void
  onBegin?: () => void
}

/** Occurrences deliberately keep their source ranges and original block text.
 * The host validates that snapshot before replacing one image, even when two
 * occurrences resolve to the same asset URL.
 */
export function BlockImagePresentations({ content, isZh, references, occurrences, onCommit, onBegin }: BlockImagePresentationsProps) {
  const displays = useMemo(() => occurrences ? occurrences.map(occurrence => ({ presentation: occurrence.presentation, occurrence }))
    : planMarkdownImageDisplays(content, references), [content, references, occurrences])
  if (!displays.length) return null
  return <figure className="block-image-presentations" data-block-image-presentations
    aria-label={isZh ? `${displays.length} 张图片` : `${displays.length} image${displays.length === 1 ? '' : 's'}`}
    style={{ margin: '8px 0', minWidth: 0 }}>
    {displays.map(({ presentation, occurrence }, index) => <Suspense key={index} fallback={<span data-image-loading>
      <img alt={presentation.alt} src={toBlockRichMediaPreviewUrl(presentation.src)}
        width={presentation.width} height={presentation.height} style={{ maxWidth: '100%' }} />
      {presentation.caption && <span>{presentation.caption}</span>}
    </span>}>
      <ImagePresentationEditor value={presentation} isZh={isZh} editable={Boolean(onCommit && occurrence)}
        onBegin={onBegin} onCommit={onCommit && occurrence ? next => {
          const nextContent = replaceMarkdownImageOccurrence(content, occurrence, next, references)
          if (nextContent !== null) onCommit(occurrence, next, nextContent)
        } : undefined} />
    </Suspense>)}
  </figure>
}
