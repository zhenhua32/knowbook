import type { BackupHealth } from '../../shared/backup-health'

/** Retain startup failures for late subscribers and only announce changes. */
export class BackupHealthTracker {
  private state: BackupHealth = { revision: 0, error: null }
  constructor(private readonly publish: (state: BackupHealth) => void) {}
  getSnapshot(): BackupHealth { return { ...this.state } }
  report(error: string | null): void {
    if (error === this.state.error) return
    this.state = { revision: this.state.revision + 1, error }
    this.publish(this.getSnapshot())
  }
}
