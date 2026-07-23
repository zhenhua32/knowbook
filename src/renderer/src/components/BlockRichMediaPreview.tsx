import { memo, useState } from 'react'
import { extractBlockRichMedia, toBlockRichMediaPreviewUrl } from '../utils/blockRichMedia'

type BlockRichMediaPreviewProps = {
  content: string
  ui: {
    blockPreviewImagesLabel: string
    blockPreviewImageUnavailable: string
    blockPreviewOpenImage: string
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
              <RichMediaImageCard
                alt={image.alt}
                key={image.url}
                onOpen={() => openUrl(image.url)}
                previewUrl={toBlockRichMediaPreviewUrl(image.url)}
                ui={ui}
              />
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
                <span className="block-rich-media-link-icon">
                  <LinkIcon />
                </span>
                <span className="block-rich-media-link-copy">
                  <strong>{getLinkDisplayLabel(link.label, link.url)}</strong>
                  <small>{getLinkDisplayUrl(link.url)}</small>
                </span>
                <span className="block-rich-media-link-action" aria-hidden="true">
                  <ExternalIcon />
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
})

type RichMediaImageCardProps = {
  alt: string
  onOpen: () => void
  previewUrl: string
  ui: BlockRichMediaPreviewProps['ui']
}

function RichMediaImageCard({ alt, onOpen, previewUrl, ui }: RichMediaImageCardProps) {
  const [loadFailed, setLoadFailed] = useState(false)
  const caption = alt || ui.blockPreviewImagesLabel

  return (
    <button
      aria-label={`${ui.blockPreviewOpenImage}: ${caption}`}
      className={`block-rich-media-image-card${loadFailed ? ' block-rich-media-image-card-error' : ''}`}
      onClick={onOpen}
      type="button"
    >
      <span className="block-rich-media-image-frame">
        {loadFailed ? (
          <span className="block-rich-media-image-fallback">
            <ImageIcon />
            <strong>{ui.blockPreviewImageUnavailable}</strong>
            <small>{caption}</small>
          </span>
        ) : (
          <img
            alt={caption}
            className="block-rich-media-image"
            decoding="async"
            onError={() => setLoadFailed(true)}
            src={previewUrl}
          />
        )}
      </span>
      <span className="block-rich-media-caption">
        <span>{caption}</span>
        <span className="block-rich-media-caption-action">{ui.blockPreviewOpenImage}<ExternalIcon /></span>
      </span>
    </button>
  )
}

function getLinkDisplayLabel(label: string, url: string): string {
  if (label !== url) {
    return label
  }

  try {
    const parsed = new URL(url)
    return parsed.protocol === 'file:' ? decodeURIComponent(parsed.pathname.split('/').pop() || label) : parsed.hostname
  } catch {
    return label
  }
}

function getLinkDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      return decodeURIComponent(parsed.pathname)
    }
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

function LinkIcon() {
  return (
    <svg aria-hidden="true" className="block-rich-media-icon-svg" viewBox="0 0 20 20">
      <path d="M8.2 11.8 11.8 8.2M7 13l-1.2 1.2a3 3 0 0 1-4.2-4.2l2.8-2.8a3 3 0 0 1 4.2 0M13 7l1.2-1.2a3 3 0 1 1 4.2 4.2l-2.8 2.8a3 3 0 0 1-4.2 0" />
    </svg>
  )
}

function ExternalIcon() {
  return (
    <svg aria-hidden="true" className="block-rich-media-icon-svg" viewBox="0 0 20 20">
      <path d="M11 4h5v5M16 4l-7 7" />
      <path d="M14 11v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" />
    </svg>
  )
}

function ImageIcon() {
  return (
    <svg aria-hidden="true" className="block-rich-media-fallback-icon" viewBox="0 0 24 24">
      <rect height="16" rx="2.5" width="18" x="3" y="4" />
      <circle cx="9" cy="9" r="1.5" />
      <path d="m4 17 4.5-4.5 3.5 3 2.5-2.5 5 4.5" />
    </svg>
  )
}
