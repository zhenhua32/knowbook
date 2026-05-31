import { useEffect, useRef } from 'react'
import { extractBlockRichMedia, toBlockRichMediaPreviewUrl } from '../utils/blockRichMedia'
import { forwardWheelToClosestContentScroller } from '../utils/scrollWheel'

type BlockRichMediaPreviewProps = {
  content: string
  ui: {
    blockPreviewImagesLabel: string
    blockPreviewLinksLabel: string
    openExternalLink: string
  }
}

export function BlockRichMediaPreview({ content, ui }: BlockRichMediaPreviewProps) {
  const previewRef = useRef<HTMLDivElement | null>(null)
  const richMedia = extractBlockRichMedia(content)

  if (richMedia.images.length === 0 && richMedia.links.length === 0) {
    return null
  }

  const openUrl = (url: string) => {
    void window.knowbook.openExternalUrl(url).catch((error) => {
      console.warn('Failed to open external preview URL.', error)
    })
  }

  useEffect(() => {
    const element = previewRef.current
    if (!element) {
      return
    }

    const handleWheel = (event: WheelEvent) => {
      if (forwardWheelToClosestContentScroller(element, event.deltaX, event.deltaY)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    element.addEventListener('wheel', handleWheel, { passive: false, capture: true })

    return () => {
      element.removeEventListener('wheel', handleWheel, { capture: true })
    }
  }, [])

  return (
    <div className="block-rich-media-preview" ref={previewRef}>
      {richMedia.images.length > 0 ? (
        <div className="block-rich-media-group">
          <p className="block-rich-media-label">{ui.blockPreviewImagesLabel}</p>
          <div className="block-rich-media-images">
            {richMedia.images.map((image) => (
              <button
                className="block-rich-media-image-card"
                key={image.url}
                onClick={() => openUrl(image.url)}
                type="button"
              >
                <img alt={image.alt || ui.blockPreviewImagesLabel} className="block-rich-media-image" src={toBlockRichMediaPreviewUrl(image.url)} />
                <span className="block-rich-media-caption">{image.alt || image.url}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {richMedia.links.length > 0 ? (
        <div className="block-rich-media-group">
          <p className="block-rich-media-label">{ui.blockPreviewLinksLabel}</p>
          <div className="block-rich-media-links">
            {richMedia.links.map((link) => (
              <button
                className="block-rich-media-link"
                key={link.url}
                onClick={() => openUrl(link.url)}
                title={link.url}
                type="button"
              >
                <span>{link.label}</span>
                <span className="block-rich-media-link-url">{ui.openExternalLink}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}