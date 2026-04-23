import http from 'http'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type {
  DataSource,
  Config,
  ProjectInfo,
  SessionInfo,
  DashboardStats,
} from '@ccsight/shared'

// --- Native HTTP utilities ---

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(
  res: http.ServerResponse,
  text: string,
  contentType = 'text/plain',
  status = 200,
) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sendError(res: http.ServerResponse, status: number, message: string) {
  sendJson(res, { error: message }, status)
}

function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function applyCors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, PUT, POST, DELETE, OPTIONS',
  )
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

// --- Router ---

type Params = Record<string, string>
type Query = Record<string, string>
type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Params,
  query: Query,
) => void | Promise<void>

interface Route {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: RouteHandler
}

const routes: Route[] = []

function route(method: string, pathPattern: string, handler: RouteHandler) {
  const paramNames: string[] = []
  const regexStr = pathPattern.replace(/:([^/]+)/g, (_match, name) => {
    paramNames.push(name)
    return '([^/]+)'
  })
  routes.push({
    method,
    pattern: new RegExp(`^${regexStr}/?$`),
    paramNames,
    handler,
  })
}

// --- Static file serving ---

function serveStatic(
  res: http.ServerResponse,
  distPath: string,
  pathname: string,
) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const filePath = path.join(distPath, safePath)

  // Prevent directory traversal
  if (!path.resolve(filePath).startsWith(path.resolve(distPath))) {
    sendError(res, 403, 'Forbidden')
    return
  }

  // Try the exact file
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath)
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream'
    const content = fs.readFileSync(filePath)
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': content.length,
    })
    res.end(content)
    return
  }

  // SPA fallback: serve index.html
  const indexPath = path.join(distPath, 'index.html')
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': content.length,
    })
    res.end(content)
    return
  }

  sendError(res, 404, 'Not found')
}

// --- Config ---

export const CONFIG_PATH = path.join(os.homedir(), '.ccsight.json')

export const DEFAULT_SOURCES: DataSource[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    path: path.join(os.homedir(), '.claude', 'projects'),
    enabled: true,
  },
]

export function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      return { dataSources: raw.dataSources ?? DEFAULT_SOURCES }
    }
  } catch {
    /* ignore */
  }
  return { dataSources: DEFAULT_SOURCES }
}

export function saveConfig(config: Config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

// --- Config API ---

route('GET', '/api/config', (_req, res) => {
  sendJson(res, loadConfig())
})

route('PUT', '/api/config', async (req, res) => {
  const config = (await parseJsonBody(req)) as Config
  saveConfig(config)
  sendJson(res, config)
})

// --- Scan helpers ---

function extractTitle(filePath: string): string {
  try {
    const text = fs.readFileSync(filePath, 'utf-8')
    // Scan from end — title messages are written after session starts
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i])
        if (msg.type === 'custom-title' && msg.customTitle)
          return msg.customTitle
        if (msg.type === 'ai-title' && msg.aiTitle) return msg.aiTitle
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return ''
}

function extractPreview(filePath: string): string {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(8192)
    fs.readSync(fd, buf, 0, 8192, 0)
    fs.closeSync(fd)
    const lines = buf.toString('utf-8').split('\n')
    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        if (
          msg.type === 'user' &&
          msg.message?.content &&
          typeof msg.message.content === 'string' &&
          !msg.isMeta &&
          !msg.message.content.startsWith('<')
        ) {
          return msg.message.content.slice(0, 120)
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no preview */
  }
  return ''
}

function extractCwd(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(4096)
    fs.readSync(fd, buf, 0, 4096, 0)
    fs.closeSync(fd)
    const lines = buf.toString('utf-8').split('\n')
    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        if (msg.cwd) return msg.cwd
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

export function scanSource(source: DataSource): ProjectInfo[] {
  if (!source.enabled || !fs.existsSync(source.path)) return []

  const entries = fs.readdirSync(source.path, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((dir) => {
      const projectDir = path.join(source.path, dir.name)
      const files = fs
        .readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
      const sessions: SessionInfo[] = files.map((f) => {
        const filePath = path.join(projectDir, f)
        const stat = fs.statSync(filePath)
        return {
          id: f.replace('.jsonl', ''),
          filename: f,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          preview: extractPreview(filePath),
          title: extractTitle(filePath),
        }
      })
      sessions.sort(
        (a, b) =>
          new Date(b.modified).getTime() - new Date(a.modified).getTime(),
      )

      let projectPath = dir.name
      if (sessions.length > 0) {
        const cwd = extractCwd(path.join(projectDir, sessions[0].filename))
        if (cwd) projectPath = cwd
      }

      return {
        sourceId: source.id,
        sourceLabel: source.label,
        sourceDir: source.path,
        dirName: dir.name,
        projectPath,
        sessions,
      }
    })
    .filter((p) => p.sessions.length > 0)
}

// --- Dashboard stats ---

export function computeDashboardStats(): DashboardStats {
  const config = loadConfig()
  const allProjects: ProjectInfo[] = []
  for (const source of config.dataSources) {
    allProjects.push(...scanSource(source))
  }

  let totalSessions = 0
  const sessionsPerDayMap: Record<string, number> = {}
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheCreation = 0
  let totalCacheRead = 0
  const allSessions: DashboardStats['recentSessions'] = []

  for (const project of allProjects) {
    for (const session of project.sessions) {
      totalSessions++
      allSessions.push({
        projectDir: project.dirName,
        sessionId: session.id,
        sourceDir: project.sourceDir,
        preview: session.preview,
        title: session.title,
        modified: session.modified,
        projectPath: project.projectPath,
      })

      const day = session.modified.slice(0, 10)
      sessionsPerDayMap[day] = (sessionsPerDayMap[day] ?? 0) + 1

      try {
        const filePath = path.join(
          project.sourceDir,
          project.dirName,
          session.filename,
        )
        const fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(65536)
        const bytesRead = fs.readSync(fd, buf, 0, 65536, 0)
        fs.closeSync(fd)
        const text = buf.toString('utf-8', 0, bytesRead)
        const lines = text.split('\n')
        for (const line of lines) {
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'assistant' && msg.message?.usage) {
              const u = msg.message.usage
              totalInputTokens += u.input_tokens ?? 0
              totalOutputTokens += u.output_tokens ?? 0
              totalCacheCreation += u.cache_creation_input_tokens ?? 0
              totalCacheRead += u.cache_read_input_tokens ?? 0
            }
          } catch {
            /* skip line */
          }
        }
      } catch {
        /* skip file */
      }
    }
  }

  allSessions.sort((a, b) => b.modified.localeCompare(a.modified))
  const recentSessions = allSessions.slice(0, 10)

  const sessionsPerDay = Object.entries(sessionsPerDayMap)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30)

  return {
    totalSessions,
    totalProjects: allProjects.length,
    recentSessions,
    sessionsPerDay,
    tokenUsage: {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cache_creation_input_tokens: totalCacheCreation,
      cache_read_input_tokens: totalCacheRead,
    },
  }
}

// --- Dashboard API ---

route('GET', '/api/dashboard', (_req, res) => {
  try {
    sendJson(res, computeDashboardStats())
  } catch (err) {
    sendError(res, 500, String(err))
  }
})

// --- Projects API ---

route('GET', '/api/projects', (_req, res) => {
  try {
    const config = loadConfig()
    const allProjects: ProjectInfo[] = []
    for (const source of config.dataSources) {
      allProjects.push(...scanSource(source))
    }
    allProjects.sort((a, b) => {
      const aLatest = a.sessions[0]?.modified ?? ''
      const bLatest = b.sessions[0]?.modified ?? ''
      return bLatest.localeCompare(aLatest)
    })
    sendJson(res, allProjects)
  } catch (err) {
    sendError(res, 500, String(err))
  }
})

// --- Session API (uses sourceDir query param to resolve path) ---

function resolveSessionDir(
  query: { sourceDir?: string },
  projectDir: string,
): string {
  const sourceDir = query.sourceDir
  if (sourceDir) return path.join(sourceDir, projectDir)
  // Fallback: search all enabled sources
  const config = loadConfig()
  for (const source of config.dataSources) {
    const candidate = path.join(source.path, projectDir)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(config.dataSources[0]?.path ?? '', projectDir)
}

// --- SSE Stream endpoint (must be before the catch-all :sessionId route) ---

route(
  'GET',
  '/api/sessions/:projectDir/:sessionId/stream',
  (req, res, params, query) => {
    try {
      const dir = resolveSessionDir(query, params.projectDir)
      const filePath = path.join(dir, `${params.sessionId}.jsonl`)

      if (!fs.existsSync(filePath)) {
        sendError(res, 404, 'Session not found')
        return
      }

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      let offset = 0
      let partialLine = ''
      let closed = false

      function sendEvent(event: string, data: string) {
        if (closed) return
        res.write(`event: ${event}\ndata: ${data}\n\n`)
      }

      function sendLines(text: string) {
        const combined = partialLine + text
        const lines = combined.split('\n')
        // Last element might be partial (no trailing newline)
        partialLine = combined.endsWith('\n') ? '' : lines.pop()!

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            JSON.parse(trimmed) // validate
            sendEvent('message', trimmed)
          } catch {
            /* skip malformed */
          }
        }
      }

      // Initial read — send all existing content
      const initialContent = fs.readFileSync(filePath, 'utf-8')
      offset = Buffer.byteLength(initialContent, 'utf-8')
      sendLines(initialContent)
      sendEvent('init-complete', '{}')

      // Watch for changes
      let debounceTimer: ReturnType<typeof setTimeout> | null = null

      function readNewContent() {
        if (closed) return
        try {
          const stat = fs.statSync(filePath)
          const newSize = stat.size

          if (newSize < offset) {
            // File was truncated — reset
            offset = 0
            partialLine = ''
            sendEvent('reset', '{}')
            const content = fs.readFileSync(filePath, 'utf-8')
            offset = Buffer.byteLength(content, 'utf-8')
            sendLines(content)
            return
          }

          if (newSize <= offset) return

          const bytesToRead = newSize - offset
          const buf = Buffer.alloc(bytesToRead)
          const fd = fs.openSync(filePath, 'r')
          fs.readSync(fd, buf, 0, bytesToRead, offset)
          fs.closeSync(fd)
          offset = newSize

          const newText = buf.toString('utf-8')
          sendLines(newText)
          sendEvent('activity', '{}')
        } catch {
          /* file may be temporarily locked */
        }
      }

      const watcher = fs.watch(filePath, () => {
        if (closed) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(readNewContent, 50)
      })

      // Heartbeat
      const heartbeat = setInterval(() => {
        if (closed) return
        res.write(': keepalive\n\n')
      }, 15000)

      // Idle detection — send idle event if no changes for 30s
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let isIdle = false

      function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer)
        if (isIdle) {
          isIdle = false
        }
        idleTimer = setTimeout(() => {
          isIdle = true
          sendEvent('idle', '{}')
        }, 30000)
      }

      // Start idle timer after initial load
      resetIdleTimer()

      // Patch readNewContent to reset idle timer
      const originalRead = readNewContent
      function readNewContentWithIdle() {
        originalRead()
        resetIdleTimer()
      }

      // Re-wire the debounce to use idle-aware version
      watcher.removeAllListeners('change')
      watcher.on('change', () => {
        if (closed) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(readNewContentWithIdle, 50)
      })

      // Cleanup on disconnect
      req.on('close', () => {
        closed = true
        watcher.close()
        clearInterval(heartbeat)
        if (debounceTimer) clearTimeout(debounceTimer)
        if (idleTimer) clearTimeout(idleTimer)
      })
    } catch (err) {
      sendError(res, 500, String(err))
    }
  },
)

route(
  'GET',
  '/api/sessions/:projectDir/:sessionId',
  (_req, res, params, query) => {
    try {
      const dir = resolveSessionDir(query, params.projectDir)
      const filePath = path.join(dir, `${params.sessionId}.jsonl`)

      if (!fs.existsSync(filePath)) {
        sendError(res, 404, 'Session not found')
        return
      }
      sendText(res, fs.readFileSync(filePath, 'utf-8'))
    } catch (err) {
      sendError(res, 500, String(err))
    }
  },
)

interface ModelTokens {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function extractSubagentTokens(filePath: string): ModelTokens[] {
  const byModel: Record<string, ModelTokens> = {}
  try {
    const text = fs.readFileSync(filePath, 'utf-8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type !== 'assistant' || !msg.message?.usage) continue
        const model = msg.message.model ?? 'unknown'
        const u = msg.message.usage
        if (!byModel[model]) {
          byModel[model] = {
            model,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          }
        }
        byModel[model].input_tokens += u.input_tokens ?? 0
        byModel[model].output_tokens += u.output_tokens ?? 0
        byModel[model].cache_read_input_tokens += u.cache_read_input_tokens ?? 0
        byModel[model].cache_creation_input_tokens +=
          u.cache_creation_input_tokens ?? 0
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return Object.values(byModel)
}

route(
  'GET',
  '/api/sessions/:projectDir/:sessionId/subagents',
  (_req, res, params, query) => {
    try {
      const dir = resolveSessionDir(query, params.projectDir)
      const subagentsDir = path.join(dir, params.sessionId, 'subagents')

      if (!fs.existsSync(subagentsDir)) {
        sendJson(res, [])
        return
      }

      const files = fs
        .readdirSync(subagentsDir)
        .filter((f: string) => f.endsWith('.jsonl'))
      sendJson(
        res,
        files.map((f: string) => {
          const filePath = path.join(subagentsDir, f)
          return {
            id: f.replace('.jsonl', ''),
            filename: f,
            size: fs.statSync(filePath).size,
            tokensByModel: extractSubagentTokens(filePath),
          }
        }),
      )
    } catch (err) {
      sendError(res, 500, String(err))
    }
  },
)

route(
  'GET',
  '/api/sessions/:projectDir/:sessionId/subagents/:agentId',
  (_req, res, params, query) => {
    try {
      const dir = resolveSessionDir(query, params.projectDir)
      const filePath = path.join(
        dir,
        params.sessionId,
        'subagents',
        `${params.agentId}.jsonl`,
      )

      if (!fs.existsSync(filePath)) {
        sendError(res, 404, 'Subagent not found')
        return
      }
      sendText(res, fs.readFileSync(filePath, 'utf-8'))
    } catch (err) {
      sendError(res, 500, String(err))
    }
  },
)

// --- Main request handler ---

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  distPath: string,
  hasStaticFiles: boolean,
) {
  applyCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname
  const query: Query = Object.fromEntries(url.searchParams)

  // Try API routes
  for (const r of routes) {
    if (req.method !== r.method) continue
    const match = pathname.match(r.pattern)
    if (!match) continue
    const params: Params = {}
    r.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1])
    })
    try {
      await r.handler(req, res, params, query)
    } catch (err) {
      sendError(res, 500, String(err))
    }
    return
  }

  // Static files / SPA fallback
  if (hasStaticFiles) {
    serveStatic(res, distPath, pathname)
    return
  }

  sendError(res, 404, 'Not found')
}

// --- Server startup ---

export const MAX_PORT_RETRIES = 20

export interface ServerOptions {
  port?: number
  distPath?: string
}

export function startServer(
  options: ServerOptions = {},
): Promise<{ port: number }> {
  const basePort = options.port ?? parseInt(process.env.PORT ?? '3211', 10)
  const distPath =
    options.distPath ??
    path.join(import.meta.dirname, '..', '..', 'web', 'dist')
  const hasStaticFiles = fs.existsSync(path.join(distPath, 'index.html'))

  function tryListen(port: number, attempt: number): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        handleRequest(req, res, distPath, hasStaticFiles)
      })
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_RETRIES) {
          resolve(tryListen(port + 1, attempt + 1))
        } else {
          reject(err)
        }
      })
      server.listen(port, () => {
        resolve({ port })
      })
    })
  }

  return tryListen(basePort, 0)
}

// Auto-start when run directly (not imported by CLI)
// @ts-expect-error BUNDLED is defined by esbuild at bundle time
const isDirectRun = typeof BUNDLED === 'undefined' &&
  process.argv[1] &&
  path.resolve(process.argv[1]).replace(/\.ts$/, '') ===
    path.resolve(import.meta.filename).replace(/\.ts$/, '')

if (isDirectRun) {
  startServer().then(({ port }) => {
    console.log(`CCSight API running at http://localhost:${port}`)
  })
}
