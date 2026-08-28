import type { PluginActiveOwner, PluginJsonValue } from '@shared/plugin-platform'
import type {
  PluginUiContributionValue,
  PluginUiDocumentContribution,
  PluginUiDocumentFrame,
  PluginUiSlot,
  PluginViewNode,
  PluginViewSpec
} from '@shared/plugin-ui'
import { validatePluginUiContribution } from '@shared/plugin-ui'
import type { PluginRevisionStore } from './revision-store'

const MAX_IFRAME_HTML_BYTES = 1024 * 1024
export const PLUGIN_IFRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"
const IMAGE_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
})

export function materializePluginUiContribution(
  revisions: Pick<PluginRevisionStore, 'load'>,
  input: {
    owner: PluginActiveOwner
    slot: PluginUiSlot
    id: string
    order: number
    value: PluginJsonValue
  }
): PluginUiDocumentContribution {
  const validated = validatePluginUiContribution(input.slot, input.value)
  const package_ = revisions.load(input.owner.revisionId)
  if (validated.value.kind === 'iframe') {
    const frame = materializePluginIframePreparation(
      input.slot,
      input.id,
      validated.value,
      package_.assets
    )
    return {
      owner: structuredClone(input.owner),
      slot: input.slot,
      id: input.id,
      order: input.order,
      value: {
        kind: 'iframe',
        title: frame.title,
        height: frame.height,
        srcdoc: frame.srcdoc
      }
    }
  }
  return {
    owner: structuredClone(input.owner),
    slot: input.slot,
    id: input.id,
    order: input.order,
    value: {
      kind: 'view',
      view: materializeViewAssets(validated.value.view, package_.assets)
    }
  }
}

export function materializePluginIframePreparation(
  slot: PluginUiSlot,
  contributionId: string,
  value: Extract<PluginUiContributionValue, { kind: 'iframe' }>,
  assets: Readonly<Record<string, Uint8Array>>
): PluginUiDocumentFrame {
  const html = readIframeHtml(value.asset, assets)
  return {
    slot,
    contributionId,
    title: value.title,
    height: value.height ?? 320,
    srcdoc: createSandboxedPluginDocument(html)
  }
}

export function validatePluginUiAssets(
  value: PluginUiContributionValue,
  assets: Readonly<Record<string, Uint8Array>>
): void {
  if (value.kind === 'iframe') {
    readIframeHtml(value.asset, assets)
    return
  }
  materializeViewAssets(value.view, assets)
}

export function getDeclaredPluginUiActions(
  slot: PluginUiSlot,
  value: PluginJsonValue
): ReturnType<typeof validatePluginUiContribution>['actions'] {
  return validatePluginUiContribution(slot, value).actions
}

export function isIframePluginUiValue(value: PluginUiContributionValue): boolean {
  return value.kind === 'iframe'
}

function materializeViewAssets(
  view: PluginViewSpec,
  assets: Readonly<Record<string, Uint8Array>>
): PluginViewSpec {
  return { version: 1, root: materializeNode(view.root, assets) }
}

function materializeNode(
  node: PluginViewNode,
  assets: Readonly<Record<string, Uint8Array>>
): PluginViewNode {
  switch (node.type) {
    case 'stack':
    case 'row':
    case 'grid':
      return { ...node, children: node.children.map((child) => materializeNode(child, assets)) }
    case 'scroll':
      return { ...node, child: materializeNode(node.child, assets) }
    case 'list':
      return { ...node, items: node.items.map((child) => materializeNode(child, assets)) }
    case 'image': {
      const bytes = assets[node.asset]
      if (!bytes) throw new Error(`Plugin image asset "${node.asset}" is missing.`)
      const extension = node.asset.slice(node.asset.lastIndexOf('.')).toLowerCase()
      const mime = IMAGE_MIME[extension]
      if (!mime) throw new Error('Plugin ViewSpec images must be PNG, JPEG, GIF, or WebP.')
      return { ...node, src: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` }
    }
    default:
      return node
  }
}

function createSandboxedPluginDocument(untrustedHtml: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(PLUGIN_IFRAME_CSP)}">`
  const charset = '<meta charset="utf-8">'
  const bootstrap = `<script>${FRAME_BOOTSTRAP}</script>`
  // The policy is emitted before every untrusted byte. This also covers
  // malformed documents that place executable content before their own head.
  return `<!doctype html>${charset}${csp}${bootstrap}${untrustedHtml}`
}

const FRAME_BOOTSTRAP = `(()=>{let port=null;let connection=null;let startupError=null;const text=value=>String(value&&value.message||value||'Plugin frame failed.').slice(0,2000);const report=error=>{const message=text(error);startupError=startupError||message;if(port&&connection){port.postMessage({type:'knowbook:error',...connection,error:message});}};addEventListener('error',event=>report(event.error||event.message));addEventListener('unhandledrejection',event=>report(event.reason));addEventListener('message',event=>{if(event.source!==parent||!event.data||event.data.type!=='knowbook:init'||!event.ports[0]||port)return;port=event.ports[0];connection={owner:event.data.owner,contributionId:event.data.contributionId,slot:event.data.slot};port.start();port.postMessage(startupError?{type:'knowbook:error',...connection,error:startupError}:{type:'knowbook:ready',...connection});dispatchEvent(new CustomEvent('knowbook:connected',{detail:{...connection,port}}));});})();`

function readIframeHtml(asset: string, assets: Readonly<Record<string, Uint8Array>>): string {
  const bytes = assets[asset]
  if (!bytes) {
    throw new Error(`Plugin iframe asset "${asset}" is missing.`)
  }
  if (bytes.byteLength > MAX_IFRAME_HTML_BYTES) {
    throw new Error(`Plugin iframe asset exceeds ${MAX_IFRAME_HTML_BYTES} bytes.`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error('Plugin iframe asset must be valid UTF-8.', { cause: error })
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}
