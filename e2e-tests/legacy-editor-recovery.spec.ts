import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeElectronApp, hasBuiltElectronApp, launchElectronApp, uiText, type ElectronAppContext } from './helpers/electron'

const electron = createRequire(import.meta.url)('electron') as string
const seedScript = `
const { createHash, randomUUID } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const Database = require('better-sqlite3');
const [filename, payload] = process.argv.slice(1);
mkdirSync(dirname(filename), { recursive: true });
const db = new Database(filename);
db.exec('CREATE TABLE drafts (record_id TEXT PRIMARY KEY, workspace_scope TEXT NOT NULL, recovery_epoch TEXT NOT NULL, draft_session_id TEXT NOT NULL, generation INTEGER NOT NULL, kind TEXT NOT NULL, target_id BLOB NOT NULL, payload_hash TEXT NOT NULL, updated_at TEXT NOT NULL, payload BLOB, UNIQUE(workspace_scope, recovery_epoch, draft_session_id, kind, target_id)) STRICT; PRAGMA user_version = 1');
const add = db.prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const bytes = Buffer.from(payload, 'utf16le');
const hash = createHash('sha256').update(bytes).digest('hex');
const workspaceScope = randomUUID(), recoveryEpoch = randomUUID();
for (let row = 1; row <= 21; row++) {
  const id = '00000000-0000-0000-0000-' + String(row).padStart(12, '0');
  const target = row === 21 ? 'source:legacy pagination target' : 'source:legacy fixture ' + row;
  add.run(id, workspaceScope, recoveryEpoch, randomUUID(), 1, 'source', Buffer.from(target, 'utf16le'), hash, '2026-11-08T00:00:00.000Z', bytes);
}
db.close();`

type Globals = typeof globalThis & { __knowbookLegacyCopied: string[] }

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before recovery acceptance')

test('earlier draft journal stays intact and offers paged read-only preview and exact copy @electron', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'knowbook-e2e-legacy-draft-'))
  const filename = join(profile, 'storage', 'recovery', 'synced-drafts.sqlite')
  const source = 'Legacy draft body\r\n第二行 <draft>'
  const payload = JSON.stringify({ version: 1, sourceKind: 'canonical', working: { source, start: 1, end: 2, anchors: [] } })
  let context: ElectronAppContext | null = null
  try {
    execFileSync(electron, ['-e', seedScript, filename, payload], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000
    })
    const original = readFileSync(filename)
    context = await launchElectronApp({}, { userDataRoot: profile })
    const { app, page } = context
    // Capture the actual renderer clipboard request without using the desktop clipboard.
    await app.evaluate(({ ipcMain }) => {
      const copied: string[] = []
      ;(globalThis as Globals).__knowbookLegacyCopied = copied
      ipcMain.removeHandler('knowbook:write-clipboard-text')
      ipcMain.handle('knowbook:write-clipboard-text', (_event, text: string) => { copied.push(text) })
    })
    await page.getByRole('button', { name: /检查保留的编辑草稿|Review retained editor drafts/ }).click()
    const panel = page.getByRole('dialog', { name: uiText('Retained editor drafts', '保留的编辑草稿') })
    await expect(panel.getByRole('heading', { name: uiText('Drafts from an earlier version', '旧版本草稿') })).toBeVisible()
    const target = panel.getByRole('button', { name: /legacy pagination target/ })
    await expect(target).toHaveCount(0)
    await panel.getByRole('button', { name: uiText('More drafts from earlier versions', '更多旧版本草稿') }).click()
    await target.click()
    const preview = panel.getByRole('textbox', { name: uiText('Earlier draft preview, available to copy', '旧版本草稿预览，可复制') })
    await expect(preview).toHaveValue(source.replace('\r\n', '\n'))
    await expect(preview).not.toBeEditable()
    await expect(panel.getByRole('button', { name: uiText('Restore', '恢复') })).toHaveCount(0)
    await panel.getByRole('button', { name: uiText('Copy body', '复制正文') }).click()
    await panel.getByRole('button', { name: uiText('Copy full record', '复制完整记录') }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as Globals).__knowbookLegacyCopied)).toEqual([source, payload])
    expect(readFileSync(filename).equals(original)).toBe(true)
  } finally {
    if (context) await closeElectronApp(context)
    else rmSync(profile, { recursive: true, force: true })
  }
})
