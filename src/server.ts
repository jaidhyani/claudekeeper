import { createServer, IncomingMessage, ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { URL } from 'url'
import type { Config, AttentionResolution, SessionMeta, ClaudeSessionWithMeta } from './types.js'
import { AttentionManager } from './attention.js'
import { QueryManager } from './query.js'
import { listAllSessions, getSessionById, readSessionMessages, deleteSession } from './claude-sessions.js'
import { getSessionMeta, updateSessionMeta, getInteractions, deleteSessionMeta, getAllSessionMetas } from './session-meta.js'
import { browseWorkdir, readWorkdirFile, getWorkdirConfig } from './workdir-browser.js'

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  body: unknown
) => Promise<void>

export class Server {
  private httpServer: ReturnType<typeof createServer>
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()
  private routes: Map<string, Map<string, RouteHandler>> = new Map()
  private attentionManager: AttentionManager
  private queryManager: QueryManager

  constructor(private config: Config) {
    this.attentionManager = new AttentionManager()
    this.queryManager = new QueryManager(this.attentionManager, (e) => this.broadcast(e))

    this.httpServer = createServer((req, res) => this.handleRequest(req, res))
    this.wss = new WebSocketServer({ noServer: true })
    this.setupRoutes()
    this.setupWebSocket()
  }

  broadcast(event: unknown): void {
    const data = JSON.stringify(event)
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      }
    }
  }

  private setupRoutes(): void {
    // Health check
    this.route('GET', '/health', async (_req, res) => {
      this.json(res, { status: 'ok', timestamp: new Date().toISOString() })
    })

    // List all sessions from ~/.claude with metadata
    this.route('GET', '/sessions', async (_req, res) => {
      const sessions = listAllSessions()
      const metas = getAllSessionMetas()

      const sessionsWithMeta = sessions.map(session => {
        const meta = metas.get(session.id)
        return {
          ...session,
          ...(meta?.name && { name: meta.name }),
          ...(meta?.config && { config: meta.config })
        }
      })

      this.json(res, sessionsWithMeta)
    })

    // Get session with messages and metadata
    this.route('GET', '/sessions/:id', async (_req, res, params) => {
      const session = getSessionById(params.id)
      if (!session) {
        this.notFound(res, 'Session not found')
        return
      }

      const messages = readSessionMessages(params.id)
      const meta = getSessionMeta(params.id)
      const interactions = getInteractions(params.id)

      const response: ClaudeSessionWithMeta = {
        ...session,
        messages,
        ...(meta?.name && { name: meta.name }),
        ...(meta?.config && { config: meta.config }),
        interactions
      }

      this.json(res, response)
    })

    // Delete session
    this.route('DELETE', '/sessions/:id', async (_req, res, params) => {
      const deleted = deleteSession(params.id)
      if (!deleted) {
        this.notFound(res, 'Session not found')
        return
      }

      // Also delete Claudekeeper metadata
      deleteSessionMeta(params.id)

      this.json(res, { deleted: true })
    })

    // Update session metadata (name, config)
    this.route('PATCH', '/sessions/:id', async (_req, res, params, body) => {
      const session = getSessionById(params.id)
      if (!session) {
        this.notFound(res, 'Session not found')
        return
      }

      const { name, config } = body as Partial<SessionMeta>
      const changes: Partial<SessionMeta> = {}

      if (name !== undefined) changes.name = name
      if (config !== undefined) changes.config = config

      const updated = updateSessionMeta(params.id, changes)

      // Broadcast update
      this.broadcast({ type: 'session:updated', sessionId: params.id, changes })

      this.json(res, updated)
    })

    // Send message to session (start/continue query)
    this.route('POST', '/sessions/:id/send', async (_req, res, params, body) => {
      const session = getSessionById(params.id)
      if (!session) {
        this.notFound(res, 'Session not found')
        return
      }

      const { message } = body as { message?: string }
      if (!message) {
        this.badRequest(res, 'message is required')
        return
      }

      // Run query (async, don't await)
      this.queryManager.runQuery(params.id, message, session.workdir, params.id)

      this.json(res, { sent: true })
    })

    // Create new session (prompt now optional)
    this.route('POST', '/sessions', async (_req, res, _params, body) => {
      const { workdir, prompt, name, config } = body as {
        workdir?: string
        prompt?: string
        name?: string
        config?: SessionMeta['config']
      }

      if (!workdir) {
        this.badRequest(res, 'workdir is required')
        return
      }

      // Generate temp ID for tracking until SDK returns real session ID
      const tempId = `pending_${Date.now()}`

      if (prompt) {
        // Run query with prompt
        this.queryManager.runQuery(tempId, prompt, workdir, undefined, config?.permissionMode)
      }

      this.json(res, { tempId, name, config }, 201)
    })

    // Interrupt active query
    this.route('POST', '/sessions/:id/interrupt', async (_req, res, params) => {
      const interrupted = this.queryManager.interrupt(params.id)
      this.json(res, { interrupted })
    })

    // Get pending attention requests
    this.route('GET', '/attention', async (_req, res) => {
      this.json(res, this.attentionManager.getPending())
    })

    // Resolve attention request
    this.route('POST', '/attention/:id/resolve', async (_req, res, params, body) => {
      const resolution = body as AttentionResolution
      const resolved = this.attentionManager.resolve(params.id, resolution)

      if (!resolved) {
        this.notFound(res, 'Attention request not found or already resolved')
        return
      }

      this.json(res, { resolved: true })
    })

    // Browse workdir directory
    this.route('GET', '/workdir/browse', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      const path = url.searchParams.get('path')

      if (!path) {
        this.badRequest(res, 'path query parameter is required')
        return
      }

      const entries = browseWorkdir(path)

      if (entries === null) {
        this.notFound(res, 'Path not found or not accessible')
        return
      }

      this.json(res, { entries })
    })

    // Read workdir file
    this.route('GET', '/workdir/file', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      const path = url.searchParams.get('path')

      if (!path) {
        this.badRequest(res, 'path query parameter is required')
        return
      }

      const file = readWorkdirFile(path)

      if (file === null) {
        this.notFound(res, 'File not found, not accessible, or too large')
        return
      }

      this.json(res, file)
    })

    // Get merged workdir config
    this.route('GET', '/workdir/config', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      const path = url.searchParams.get('path')

      if (!path) {
        this.badRequest(res, 'path query parameter is required')
        return
      }

      const config = getWorkdirConfig(path)

      if (config === null) {
        this.notFound(res, 'Workdir not found')
        return
      }

      this.json(res, { effective: config })
    })
  }

  private setupWebSocket(): void {
    this.httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '', `http://${request.headers.host}`)
      const providedToken = url.searchParams.get('token')

      if (providedToken !== this.config.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request)
      })
    })

    this.wss.on('connection', (ws) => {
      this.clients.add(ws)

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'subscribe') {
            ws.send(JSON.stringify({ type: 'subscribed' }))
          }
        } catch {}
      })

      ws.on('close', () => {
        this.clients.delete(ws)
      })
    })
  }

  private route(method: string, path: string, handler: RouteHandler): void {
    if (!this.routes.has(method)) {
      this.routes.set(method, new Map())
    }
    this.routes.get(method)!.set(path, handler)
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Auth check
    const authHeader = req.headers.authorization
    if (authHeader !== `Bearer ${this.config.token}`) {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      const queryToken = url.searchParams.get('token')
      if (queryToken !== this.config.token) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
    }

    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '', `http://${req.headers.host}`)
    const pathname = url.pathname

    const methodRoutes = this.routes.get(method)
    if (!methodRoutes) {
      this.notFound(res, 'Not found')
      return
    }

    for (const [pattern, handler] of methodRoutes) {
      const params = this.matchRoute(pattern, pathname)
      if (params !== null) {
        const body = await this.parseBody(req)
        try {
          await handler(req, res, params, body)
        } catch (err) {
          console.error('Handler error:', err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
        return
      }
    }

    this.notFound(res, 'Not found')
  }

  private matchRoute(pattern: string, pathname: string): Record<string, string> | null {
    const patternParts = pattern.split('/')
    const pathParts = pathname.split('/')

    if (patternParts.length !== pathParts.length) return null

    const params: Record<string, string> = {}

    for (let i = 0; i < patternParts.length; i++) {
      const patternPart = patternParts[i]
      const pathPart = pathParts[i]

      if (patternPart.startsWith(':')) {
        params[patternPart.slice(1)] = pathPart
      } else if (patternPart !== pathPart) {
        return null
      }
    }

    return params
  }

  private parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => {
        if (!data) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(data))
        } catch {
          resolve({})
        }
      })
    })
  }

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private notFound(res: ServerResponse, message: string): void {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: message }))
  }

  private badRequest(res: ServerResponse, message: string): void {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: message }))
  }

  start(): void {
    this.httpServer.listen(this.config.port, () => {
      console.log(`Claudekeeper running on port ${this.config.port}`)
      console.log(`Token: ${this.config.token}`)
    })
  }

  stop(): void {
    for (const client of this.clients) {
      client.close()
    }
    this.wss.close()
    this.httpServer.close()
  }
}
