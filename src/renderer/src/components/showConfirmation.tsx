import { createRoot } from 'react-dom/client'
import { ConfirmationDialog, type ConfirmationOptions } from './ConfirmationDialog'
import './confirmation-dialog.css'

// A separate root keeps recovery confirmations available even if the app root failed.
export function showConfirmation(options: ConfirmationOptions, returnFocus: HTMLElement | null): Promise<boolean> {
  return new Promise((resolve) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let finished = false
    const finish = (accepted: boolean) => {
      if (finished) return
      finished = true
      queueMicrotask(() => {
        root.unmount()
        container.remove()
        resolve(accepted)
      })
    }
    root.render(<ConfirmationDialog {...options} returnFocus={returnFocus} onCancel={() => finish(false)} onComplete={() => finish(true)} />)
  })
}
