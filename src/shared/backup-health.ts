export const BACKUP_HEALTH_CHANNEL = 'knowbook:backup-health'
export const GET_BACKUP_HEALTH_CHANNEL = 'knowbook:get-backup-health'

export interface BackupHealth {
  revision: number
  error: string | null
}
