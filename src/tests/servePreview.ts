import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'

const PORT = 5173
const PUBLIC_DIR = path.resolve(process.cwd(), 'out/renderer')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

const server = http.createServer((req, res) => {
  let reqPath = req.url?.split('?')[0] || '/'
  if (reqPath === '/') reqPath = '/index.html'

  const filePath = path.join(PUBLIC_DIR, reqPath)
  if (!fs.existsSync(filePath)) {
    // SPA fallback
    const fallbackPath = path.join(PUBLIC_DIR, 'index.html')
    const content = fs.readFileSync(fallbackPath)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(content)
    return
  }

  const ext = path.extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  const content = fs.readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': contentType })
  res.end(content)
})

server.listen(PORT, () => {
  console.log(`Preview server live at: http://localhost:${PORT}`)
})
