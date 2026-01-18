import { createServer, IncomingMessage, ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { URL } from 'url'
import type { StateManager } from './state.js'
import type { SessionManager } from './sessions.js'
import type { AttentionManager } from './attention.js'
import type { CreateSessionRequest, SendMessageRequest, ResolveAttentionRequest } from './types.js'

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: unknown) => Promise<void>

export class Server {
  private httpServer: ReturnType<typeof createServer>
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()
  private routes: Map<string, Map<string, RouteHandler>> = new Map()

  constructor(
    private stateManager: StateManager,
    private sessionManager: SessionManager,
    private attentionManager: AttentionManager
  ) {
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
    this.route('GET', '/health', async (_req, res) => {
      this.json(res, { status: 'ok', timestamp: new Date().toISOString() })
    })

    this.route('GET', '/sessions', async (_req, res) => {
      this.json(res, this.sessionManager.getSessions())
    })

    this.route('GET', '/sessions/:id', async (_req, res, params) => {
      const session = this.sessionManager.getSession(params.id)
      if (!session) {
        this.notFound(res, 'Session not found')
        return
      }
      this.json(res, session)
    })

    this.route('POST', '/sessions', async (_req, res, _params, body) => {
      const data = body as CreateSessionRequest
      if (!data.workdir) {
        this.badRequest(res, 'workdir is required')
        return
      }
      const session = await this.sessionManager.createSession(data)
      this.json(res, session, 201)
    })

    this.route('DELETE', '/sessions/:id', async (_req, res, params) => {
      const deleted = this.sessionManager.delete(params.id)
      if (!deleted) {
        this.notFound(res, 'Session not found')
        return
      }
      this.json(res, { deleted: true })
    })

    this.route('POST', '/sessions/:id/spawn', async (_req, res, params, body) => {
      const session = this.sessionManager.getSession(params.id)
      if (!session) {
        this.notFound(res, 'Session not found')
        return
      }
      const { prompt } = body as { prompt?: string }
      await this.sessionManager.spawnSession(params.id, prompt ?? '')
      this.json(res, { spawned: true })
    })

    this.route('POST', '/sessions/:id/send', async (_req, res, params, body) => {
      const session = this.sessionManager.getSession(params.id)
      if (!session) {
        this.notFound(res, 'Session not found')
        return
      }
      const { message } = body as SendMessageRequest
      await this.sessionManager.sendMessage(params.id, message)
      this.json(res, { sent: true })
    })

    this.route('POST', '/sessions/:id/interrupt', async (_req, res, params) => {
      const interrupted = this.sessionManager.interrupt(params.id)
      this.json(res, { interrupted })
    })

    this.route('GET', '/sessions/:id/config', async (_req, res, params) => {
      const session = this.sessionManager.getSession(params.id)
      if (!session) {
        this.notFound(res, 'Session not found')
        return
      }
      this.json(res, session.config)
    })

    this.route('GET', '/attention', async (_req, res) => {
      this.json(res, this.attentionManager.getPending())
    })

    this.route('POST', '/attention/:id/resolve', async (_req, res, params, body) => {
      const data = body as ResolveAttentionRequest
      const resolved = this.attentionManager.resolve(params.id, data)
      if (!resolved) {
        this.notFound(res, 'Attention request not found or already resolved')
        return
      }
      this.json(res, { resolved: true })
    })
  }

  private setupWebSocket(): void {
    const token = this.stateManager.getConfig().token

    this.httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '', `http://${request.headers.host}`)
      const providedToken = url.searchParams.get('token')

      if (providedToken !== token) {
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

    const token = this.stateManager.getConfig().token
    const authHeader = req.headers.authorization
    if (authHeader !== `Bearer ${token}`) {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      const queryToken = url.searchParams.get('token')
      if (queryToken !== token) {
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

  start(port: number): void {
    this.httpServer.listen(port, () => {
      console.log(`Claudekeeper running on port ${port}`)
      console.log(`Token: ${this.stateManager.getConfig().token}`)
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
