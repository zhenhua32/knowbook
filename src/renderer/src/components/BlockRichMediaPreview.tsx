import { memo } from 'react'
import { extractBlockRichMedia, toBlockRichMediaPreviewUrl } from '../utils/blockRichMedia'

type BlockRichMediaPreviewProps = {
  content: string
  ui: {
    blockPreviewImagesLabel: string
    blockPreviewLinksLabel: string
    openExternalLink: string
  }
}

export const BlockRichMediaPreview = memo(function BlockRichMediaPreview({ content, ui }: BlockRichMediaPreviewProps) {
  const richMedia = extractBlockRichMedia(content)

  if (richMedia.images.length === 0 && richMedia.links.length === 0) {
    return null
  }

  const openUrl = (url: string) => {
    void window.knowbook.openExternalUrl(url).catch((error) => {
      console.warn('Failed to open external preview URL.', error)
    })
  }

  return (
    <div className="block-rich-media-preview">
      {richMedia.images.length > 0 ? (
        <div className="block-rich-media-group">
          <p className="block-rich-media-label">{ui.blockPreviewImagesLabel}</p>
          <div className="block-rich-media-images">
            {richMedia.images.map((image) => (
              <button
                className="block-rich-media-image-card"
                key={image.url}
                onClick={() => openUrl(image.url)}
                tabIndex={-1}
                type="button"
              >
                <img
                  alt={image.alt || ui.blockPreviewImagesLabel}
                  className="block-rich-media-image"
                  decoding="async"
                  loading="lazy"
                  src={toBlockRichMediaPreviewUrl(image.url)}
                />
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
                tabIndex={-1}
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
})