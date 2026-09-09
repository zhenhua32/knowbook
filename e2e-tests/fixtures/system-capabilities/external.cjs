'use strict'
// This is a real external Node process launched by the temporary Windows URI handler.
const [url, endpoint, token] = process.argv.slice(2)
const parsed = new URL(url)
if (parsed.hostname !== 'probe' || parsed.searchParams.get('token') !== token) process.exit(3)
void fetch(endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url, token, pid: process.pid, execPath: process.execPath })
}).then((response) => { if (!response.ok) process.exitCode = 4 }).catch(() => { process.exitCode = 5 })
