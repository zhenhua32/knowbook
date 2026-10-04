import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'

// Use the installed Fetch implementation's WHATWG bad-port list rather than
// assuming that the operating system's ephemeral range is safe for HTTP fetch.
const { badPortsSet } = createRequire(import.meta.url)('undici/lib/web/fetch/constants.js') as {
  badPortsSet: ReadonlySet<string>
}

export async function listenOnFetchSafePort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    if (!badPortsSet.has(String(address.port))) return address.port
    const closed = once(server, 'close')
    server.close()
    await closed
  }
  throw new Error('Could not allocate an HTTP test port permitted by Fetch')
}
