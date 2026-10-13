import { parseFragment, type DefaultTreeAdapterTypes as Html } from 'parse5'

export type ImageCrop = { x: number; y: number; width: number; height: number }
export type ImagePresentation = {
  src: string
  alt: string
  title?: string
  caption: string
  width?: number
  height?: number
  align: 'left' | 'center' | 'right'
  crop?: ImageCrop
}
export const FULL_IMAGE_CROP: Readonly<ImageCrop> = Object.freeze({ x: 0, y: 0, width: 1, height: 1 })
export const IMAGE_ALIGN_ATTRIBUTE = 'data-knowbook-align'
export const IMAGE_CROP_ATTRIBUTE = 'data-knowbook-crop'
export const MAX_IMAGE_DISPLAY_SIZE = 10000

/** Keep this model independent of MarkdownEngine: its safe HTML rules use it. */
export function normalizeMediaSource(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const source = value.trim()
  // The same URL boundary as safe Markdown HTML, without executing or fetching.
  if (!source || /[\u0000-\u001f\u007f\\]/.test(source) || source.startsWith('//')) return null
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(source)?.[1].toLowerCase()
  if (!scheme) return source
  if (!['http', 'https', 'file'].includes(scheme)) return null
  try { return new URL(source).toString() } catch { return null }
}

export function normalizeImageCrop(value: unknown): ImageCrop | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const { x, y, width, height } = input
  if (![x, y, width, height].every(number => typeof number === 'number' && Number.isFinite(number))) return null
  const crop = { x: x as number, y: y as number, width: width as number, height: height as number }
  return crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
    && Number.isFinite(100 / crop.width) && Number.isFinite(100 / crop.height)
    && crop.x <= 1 && crop.y <= 1 && crop.width <= 1 && crop.height <= 1
    && crop.x + crop.width <= 1 + Number.EPSILON && crop.y + crop.height <= 1 + Number.EPSILON ? crop : null
}

function validDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_IMAGE_DISPLAY_SIZE
}
function text(value: unknown): value is string { return typeof value === 'string' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) }

export function normalizeImagePresentation(value: unknown): ImagePresentation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>, src = normalizeMediaSource(input.src)
  const alt = input.alt ?? '', caption = input.caption ?? '', align = input.align ?? 'left'
  if (!src || !text(alt) || !text(caption) || typeof align !== 'string' || !['left', 'center', 'right'].includes(align)) return null
  if (input.title !== undefined && !text(input.title)) return null
  if (input.width !== undefined && !validDimension(input.width) || input.height !== undefined && !validDimension(input.height)) return null
  const crop = input.crop === undefined ? undefined : normalizeImageCrop(input.crop)
  if (crop === null) return null
  return { src, alt, caption, align: align as ImagePresentation['align'],
    ...(input.title !== undefined ? { title: input.title as string } : {}),
    ...(input.width !== undefined ? { width: input.width as number } : {}),
    ...(input.height !== undefined ? { height: input.height as number } : {}),
    ...(crop ? { crop } : {}) }
}

export function parseImageCropAttribute(value: string): ImageCrop | null {
  const values = value.split(',')
  if (values.length !== 4 || values.some(part => !part.trim())) return null
  const [x, y, width, height] = values.map(Number)
  return normalizeImageCrop({ x, y, width, height })
}

function attr(node: Html.Element, name: string): string | undefined { return node.attrs.find(attribute => attribute.name === name)?.value }
function isElement(node: Html.ChildNode): node is Html.Element { return 'tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml' }
function attributeText(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;') }
function captionText(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;') }

export function imagePresentationFromElement(node: Html.Element): ImagePresentation | null {
  if (node.tagName !== 'img' || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null
  const dimension = (name: string) => { const value = attr(node, name); return value === undefined ? undefined : /^\d+$/.test(value) ? Number(value) : NaN }
  return normalizeImagePresentation({ src: attr(node, 'src'), alt: attr(node, 'alt') ?? '', caption: '', align: 'left',
    title: attr(node, 'title'), width: dimension('width'), height: dimension('height') })
}

/** Read one figure only. Extra elements remain source, rather than losing text. */
export function parseImageFigure(source: string): ImagePresentation | null {
  if (source.includes('\u0000')) return null // HTML5 replaces NUL before attributes can be validated.
  const nodes = parseFragment(source, { sourceCodeLocationInfo: true }).childNodes.filter(node => !('value' in node && !node.value.trim()) && node.nodeName !== '#comment')
  if (nodes.length !== 1 || !isElement(nodes[0]) || nodes[0].tagName !== 'figure') return null
  const figure = nodes[0], location = figure.sourceCodeLocation
  if (!location?.endTag) return null
  const children = figure.childNodes.filter(node => !('value' in node && !node.value.trim()) && node.nodeName !== '#comment')
  if (children.some(node => !isElement(node) || !['img', 'figcaption'].includes(node.tagName))) return null
  const images = children.filter((node): node is Html.Element => isElement(node) && node.tagName === 'img')
  const captions = children.filter((node): node is Html.Element => isElement(node) && node.tagName === 'figcaption')
  if (images.length !== 1 || captions.length > 1 || captions.some(node => !node.sourceCodeLocation?.endTag
    || node.childNodes.some(child => child.nodeName !== '#text' && child.nodeName !== '#comment'))) return null
  const image = imagePresentationFromElement(images[0])
  if (!image) return null
  const rawCrop = attr(figure, IMAGE_CROP_ATTRIBUTE), crop = rawCrop === undefined ? undefined : parseImageCropAttribute(rawCrop)
  if (crop === null) return null
  return normalizeImagePresentation({ ...image, align: attr(figure, IMAGE_ALIGN_ATTRIBUTE) ?? 'left', crop,
    caption: captions[0]?.childNodes.map(node => 'value' in node ? node.value : '').join('') ?? '' })
}

/** Only validated presentation values become markup; arbitrary attrs disappear. */
export function serializeImageFigure(presentation: ImagePresentation): string {
  const image = normalizeImagePresentation(presentation)
  if (!image) throw new Error('Invalid image presentation.')
  const crop = image.crop ? ` ${IMAGE_CROP_ATTRIBUTE}="${[image.crop.x, image.crop.y, image.crop.width, image.crop.height].join(',')}"` : ''
  const size = (['width', 'height'] as const).map(name => image[name] === undefined ? '' : ` ${name}="${image[name]}"`).join('')
  return `<figure ${IMAGE_ALIGN_ATTRIBUTE}="${image.align}"${crop}><img src="${attributeText(image.src)}" alt="${attributeText(image.alt)}"${size}${image.title === undefined ? '' : ` title="${attributeText(image.title)}"`}><figcaption>${captionText(image.caption)}</figcaption></figure>`
}

export type ImageCropLayout = {
  width: number
  height: number
  aspectRatio: number
  frameStyle: { width: string; maxWidth: '100%'; aspectRatio: string; position: 'relative'; overflow: 'hidden'; marginLeft: 'auto' | '0'; marginRight: 'auto' | '0' }
  imageStyle: { position: 'absolute'; left: string; top: string; width: string; height: string; maxWidth: 'none'; maxHeight: 'none'; display: 'block' }
}

/** Crop the viewport, never the asset. Intrinsic dimensions keep its aspect. */
export function computeImageCropLayout(presentation: ImagePresentation, naturalWidth: number, naturalHeight: number): ImageCropLayout | null {
  const image = normalizeImagePresentation(presentation)
  if (!image || !Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) return null
  const crop = image.crop ?? FULL_IMAGE_CROP
  const aspectRatio = naturalWidth * crop.width / (naturalHeight * crop.height)
  const width = image.width ?? (image.height ? image.height * aspectRatio : naturalWidth * crop.width)
  const height = width / aspectRatio
  if (![width, height, aspectRatio].every(value => Number.isFinite(value) && value > 0)) return null
  const percent = (value: number) => `${Math.abs(value) < 1e-12 ? 0 : value}%`
  return { width, height, aspectRatio,
    frameStyle: { width: `${width}px`, maxWidth: '100%', aspectRatio: String(aspectRatio), position: 'relative', overflow: 'hidden',
      marginLeft: image.align === 'left' ? '0' : 'auto', marginRight: image.align === 'right' ? '0' : 'auto' },
    imageStyle: { position: 'absolute', left: percent(-100 * crop.x / crop.width), top: percent(-100 * crop.y / crop.height),
      width: percent(100 / crop.width), height: percent(100 / crop.height), maxWidth: 'none', maxHeight: 'none', display: 'block' } }
}
