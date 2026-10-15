import type { DocumentBlockDraft } from '@shared/contracts'
import type { UiLanguage } from '../i18n'

export type BlockSlashCommand = {
  id: string
  label: string
  description: string
  keywords: string[]
} & (
  | {
      kind: 'type'
      type: DocumentBlockDraft['type']
      templateContent?: string
      templateLanguage?: string
    }
  | {
      kind: 'action'
      action: 'insert-above' | 'insert-below' | 'insert-child' | 'move-up' | 'move-down' | 'indent' | 'outdent' | 'duplicate' | 'delete' | 'columns' | 'database'
    }
)


const cached = new Map<UiLanguage, BlockSlashCommand[]>()
const requests = new Map<UiLanguage, Promise<BlockSlashCommand[]>>()

/** The immutable catalog is shared; editor context and request ownership stay in the hook. */
export const slashCommandCatalog = {
  cached: (language: UiLanguage): BlockSlashCommand[] | undefined => cached.get(language),
  load(language: UiLanguage): Promise<BlockSlashCommand[]> {
    const ready = cached.get(language)
    if (ready) return Promise.resolve(ready)
    const existing = requests.get(language)
    if (existing) return existing
    const request = import('./blockSlashCommands').then(({ buildBlockSlashCommands }) => {
      const commands = buildBlockSlashCommands(language)
      cached.set(language, commands)
      return commands
    }).finally(() => { requests.delete(language) })
    requests.set(language, request)
    return request
  }
}
