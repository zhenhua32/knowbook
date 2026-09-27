import { copyFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import electron from 'electron'
import { AttachmentStore } from './attachments'
import type { AttachmentInput } from '@shared/attachments'

export function registerAttachmentHandlers(ipcMain: Pick<Electron.IpcMain, 'handle'>, assets: AttachmentStore): void {
  const { app, BrowserWindow, dialog, shell } = electron
  ipcMain.handle('knowbook:import-attachments', (_event, files: AttachmentInput[]) => assets.import(files))
  ipcMain.handle('knowbook:get-attachment', (_event, url: string) => assets.get(url))
  ipcMain.handle('knowbook:reveal-attachment', (_event, url: string) => { shell.showItemInFolder(assets.resolve(url)) })
  ipcMain.handle('knowbook:save-attachment', async (event, url: string): Promise<string | null> => {
    const source = assets.resolve(url), target = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = { title: '另存附件 / Save attachment', defaultPath: join(app.getPath('downloads'), basename(source)), properties: ['showOverwriteConfirmation'] }
    const result = target ? await dialog.showSaveDialog(target, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const destination = resolve(result.filePath)
    if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Attachment destination cannot be a symbolic link.')
    const canonical = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
    const root = canonical(realpathSync(assets.root))
    const parent = canonical(realpathSync(dirname(destination)))
    if (parent === root || parent.startsWith(root + sep)) throw new Error('Choose a location outside the managed attachment directory.')
    await copyFile(assets.resolve(url), destination)
    return destination
  })
}
