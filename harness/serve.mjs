// Static server for the browser harness: / → harness/harness.html,
// everything else → dist/ (so ./index.js resolves to the built bundle).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const here = fileURLToPath(new URL('./', import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const name = path === '/' ? 'harness.html' : path.replace(/^\//, '')
  const base = name === 'harness.html' ? here : dist
  try {
    const file = normalize(join(base, name))
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}).listen(0, '127.0.0.1', function () {
  console.log(`{"harness":true,"port":${this.address().port}}`)
})
