'use strict'

module.exports = {
  async activate(context) {
    const fs = context.require('node:fs')
    const path = context.require('node:path')
    fs.mkdirSync(context.plugin.dataRoot, { recursive: true })
    const frameTarget = context.process.env.KNOWBOOK_E2E_FULL_TRUST_FRAME_TARGET
    const capabilities = await exerciseCapabilities(context, frameTarget)
    fs.writeFileSync(path.join(context.plugin.dataRoot, 'activated.json'), JSON.stringify({
      pluginId: context.plugin.id,
      revisionHash: context.plugin.revisionHash,
      nodeVersion: context.process.versions.node
    }), 'utf8')
    fs.writeFileSync(
      path.join(context.plugin.dataRoot, 'capabilities.json'),
      JSON.stringify(capabilities),
      'utf8'
    )
    if (frameTarget) {
      context.settings.set('system.e2e.fullTrustFrameTarget', frameTarget)
      const source = `Object.defineProperty(window, '__knowbookFullTrustAcceptanceFrameTarget', {
        configurable: true,
        value: ${JSON.stringify(frameTarget)}
      }); null`
      await Promise.all(context.desktop.electron.BrowserWindow.getAllWindows().map((window) => (
        window.webContents.executeJavaScript(source, true)
      )))
    }
  },
  healthCheck() {
    return { ok: true }
  }
}

async function exerciseCapabilities(context, frameTarget) {
  const parent = await context.documents.create({
    title: 'Full Trust E2E Parent',
    blocks: [paragraph('parent')]
  })
  const child = await context.documents.create({
    parentId: parent.id,
    title: 'Full Trust E2E Child',
    blocks: [paragraph('child')]
  })
  const moved = await context.documents.move(child.id, null)
  await context.documents.delete(parent.id)
  await context.documents.delete(child.id)

  const database = context.databases.create({
    name: 'Full Trust E2E Database',
    description: 'Controlled acceptance data'
  })
  const column = context.databases.createColumn({
    databaseId: database.id,
    name: 'Status',
    type: 'select',
    options: ['Open', 'Done']
  })
  const entity = context.databases.createEntity({
    databaseId: database.id,
    title: 'Full Trust E2E Entity',
    fieldValues: { [column.id]: 'Open' }
  })
  context.databases.updateEntity({
    entityId: entity.id,
    title: 'Full Trust E2E Entity Updated'
  })
  const updatedEntity = context.databases.listEntities(database.id)[0]
  context.databases.delete(database.id)

  const settingKey = 'system.e2e.fullTrustRoundTrip'
  context.settings.set(settingKey, 'accepted')
  const settingValue = context.settings.get(settingKey)
  context.settings.delete(settingKey)

  const childOutput = await runChildProcess(context)
  const rawSql = context.sqlite.prepare(
    'SELECT sqlite_version() AS sqliteVersion, COUNT(*) AS documentCount FROM documents'
  ).get()
  const networkResponse = frameTarget
    ? await fetch(new URL('/api', frameTarget))
    : null
  const networkPayload = networkResponse ? await networkResponse.json() : null
  const ai = await exerciseAi(context, frameTarget)

  return {
    filesystem: {
      dataRootExists: context.require('node:fs').existsSync(context.plugin.dataRoot),
      userDataPath: context.paths.userData
    },
    runtime: {
      nodeVersion: context.process.versions.node,
      electronVersion: context.process.versions.electron,
      appVersion: context.desktop.electron.app.getVersion(),
      childOutput,
      npmDependency: context.require('full-trust-local-dependency')
    },
    environment: {
      frameTargetMatches: context.secrets.getEnvironmentVariable(
        'KNOWBOOK_E2E_FULL_TRUST_FRAME_TARGET'
      ) === frameTarget
    },
    network: {
      ok: networkResponse?.ok === true && networkPayload?.ok === true
    },
    ai,
    documents: {
      movedPath: moved.path,
      parentDeleted: context.documents.get(parent.id) === null,
      childDeleted: context.documents.get(child.id) === null
    },
    database: {
      updatedTitle: updatedEntity?.title ?? null,
      deleted: !context.databases.list().some((item) => item.id === database.id)
    },
    rawSql,
    store: {
      documentCount: context.store.getDocumentCatalog().length
    },
    settings: {
      value: settingValue,
      deleted: context.settings.get(settingKey) === null
    },
    electron: {
      mainWindowCount: context.desktop.electron.BrowserWindow.getAllWindows().length
    }
  }
}

async function exerciseAi(context, frameTarget) {
  if (!frameTarget) return { configured: false }
  context.store.updateAiConfig({
    enabled: true,
    baseUrl: new URL('/v1', frameTarget).href,
    model: 'full-trust-e2e-model',
    autoSummaryOnSave: false,
    relatedNotesEnabled: false,
    apiKey: 'full-trust-e2e-key'
  })
  const response = await context.ai.complete({
    messages: [{ role: 'user', content: 'Full Trust arbitrary prompt' }],
    temperature: 0,
    tools: [{ type: 'function', function: { name: 'full_trust_tool' } }],
    extra: { seed: 7, stream: true }
  })
  const stream = await context.ai.stream({
    messages: [{ role: 'user', content: 'Stream arbitrary UTF-8 text' }],
    extra: { stream: false }
  })
  const streamText = await stream.text()
  const controller = new AbortController()
  const cancelledResponse = await context.ai.stream({
    model: 'full-trust-cancel-stream',
    messages: [],
    signal: controller.signal
  })
  const cancelledReader = cancelledResponse.body.getReader()
  await cancelledReader.read()
  controller.abort()
  const cancelledStream = await captureFailure(() => cancelledReader.read(), 'name')
  cancelledReader.releaseLock()

  const completionError = await captureFailure(() => context.ai.complete({
    model: 'full-trust-http-error', messages: []
  }), 'message')
  const streamError = await captureFailure(() => context.ai.stream({
    model: 'full-trust-http-error', messages: []
  }), 'message')
  const invalidJsonError = await captureFailure(() => context.ai.complete({
    model: 'full-trust-invalid-json', messages: []
  }), 'name')
  const rawResponse = await context.ai.rawRequest({ pathOrUrl: 'raw-text' })
  const raw = {
    status: rawResponse.status,
    header: rawResponse.headers.get('x-full-trust-probe'),
    body: await rawResponse.text()
  }

  // Keep an SDK stream open through activation and verify host disposal aborts it.
  const disposalResponse = await context.ai.stream({
    model: 'full-trust-dispose-stream', messages: []
  })
  const disposalReader = disposalResponse.body.getReader()
  await disposalReader.read()
  void (async () => {
    let errorName = null
    try {
      while (!(await disposalReader.read()).done) { /* wait for host disposal */ }
    } catch (error) {
      errorName = error.name
    } finally {
      disposalReader.releaseLock()
    }
    context.require('node:fs').writeFileSync(
      context.require('node:path').join(context.plugin.dataRoot, 'ai-disposed.json'),
      JSON.stringify({ errorName }),
      'utf8'
    )
  })()
  return {
    configured: true,
    id: response.id,
    authorized: response.authorized,
    prompt: response.received?.messages?.[0]?.content ?? null,
    seed: response.received?.seed ?? null,
    toolName: response.received?.tools?.[0]?.function?.name ?? null,
    apiKeyAccessible: context.secrets.getAiApiKey() === 'full-trust-e2e-key',
    streamText,
    cancelledStream,
    completionError,
    streamError,
    invalidJsonError,
    raw
  }
}

async function captureFailure(operation, property) {
  try {
    await operation()
    return 'unexpected-success'
  } catch (error) {
    return error[property]
  }
}

function runChildProcess(context) {
  return new Promise((resolve, reject) => {
    const child = context.background.spawn(
      context.process.execPath,
      ['-e', "process.stdout.write('full-trust-child-ok')"],
      {
        env: {
          ...context.process.env,
          ELECTRON_RUN_AS_NODE: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`Child process failed (${String(code ?? signal)}): ${stderr}`))
    })
  })
}

function paragraph(content) {
  return {
    type: 'paragraph',
    content,
    checked: false,
    depth: 0
  }
}
