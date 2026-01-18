import { query } from '@anthropic-ai/claude-agent-sdk'
import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import type { Session, SessionConfig, CreateSessionRequest, ContentBlock } from './types.js'
import type { StateManager } from './state.js'
import { AttentionManager, createPermissionAttention, createErrorAttention, createCompletionAttention } from './attention.js'

function findClaudeExecutable(): string {
  if (process.env.CLAUDE_CODE_PATH && existsSync(process.env.CLAUDE_CODE_PATH)) {
    return process.env.CLAUDE_CODE_PATH
  }
  const nativePath = join(homedir(), '.local', 'bin', 'claude')
  if (existsSync(nativePath)) {
    return nativePath
  }
  try {
    const result = execSync('which claude', { encoding: 'utf-8' }).trim()
    if (result && existsSync(result)) return result
  } catch {}
  return nativePath
}

const claudePath = findClaudeExecutable()

export function createSessionId(): string {
  return 'sess_' + randomBytes(8).toString('hex')
}

interface ActiveQuery {
  abortController: AbortController
  pendingPermissions: Map<string, (decision: unknown) => void>
}

export class SessionManager {
  private activeQueries = new Map<string, ActiveQuery>()
  private messageCallbacks = new Map<string, (msg: unknown) => void>()

  constructor(
    private stateManager: StateManager,
    private attentionManager: AttentionManager,
    private broadcast: (event: unknown) => void
  ) {}

  getSessions(): Session[] {
    return this.stateManager.getSessions()
  }

  getSession(id: string): Session | undefined {
    return this.stateManager.getSession(id)
  }

  async createSession(req: CreateSessionRequest): Promise<Session> {
    const id = createSessionId()
    const now = new Date().toISOString()

    const session: Session = {
      id,
      workdir: req.workdir,
      name: req.name,
      createdAt: now,
      lastActivity: now,
      process: null,
      config: req.config ?? {}
    }

    this.stateManager.setSession(session)
    this.broadcast({ type: 'session:created', session })

    if (req.prompt) {
      this.spawnSession(id, req.prompt)
    }

    return session
  }

  async spawnSession(id: string, prompt: string): Promise<void> {
    const session = this.stateManager.getSession(id)
    if (!session) throw new Error(`Session ${id} not found`)

    const abortController = new AbortController()
    const pendingPermissions = new Map<string, (decision: unknown) => void>()

    this.activeQueries.set(id, { abortController, pendingPermissions })

    session.process = { state: 'agent_turn' }
    session.lastActivity = new Date().toISOString()
    this.stateManager.setSession(session)
    this.broadcast({ type: 'session:updated', session })

    const canUseTool = async (toolName: string, input: unknown): Promise<unknown> => {
      const attention = createPermissionAttention(id, toolName, input)
      this.attentionManager.add(attention)
      this.broadcast({ type: 'attention:requested', attention })

      session.process = { state: 'awaiting_feedback', pid: session.process?.pid }
      this.stateManager.setSession(session)
      this.broadcast({ type: 'session:updated', session })

      const resolution = await this.attentionManager.waitForResolution(attention.id)
      this.broadcast({ type: 'attention:resolved', attentionId: attention.id })

      session.process = { state: 'agent_turn', pid: session.process?.pid }
      this.stateManager.setSession(session)
      this.broadcast({ type: 'session:updated', session })

      return resolution
    }

    const runQuery = async () => {
      try {
        const options: Record<string, unknown> = {
          abortController,
          canUseTool,
          includePartialMessages: true,
          cwd: session.workdir,
          pathToClaudeCodeExecutable: claudePath,
          ...session.config
        }

        const response = query({ prompt, options })

        for await (const message of response) {
          session.lastActivity = new Date().toISOString()
          this.stateManager.setSession(session)
          this.broadcast({ type: 'session:message', sessionId: id, message })

          const callback = this.messageCallbacks.get(id)
          if (callback) callback(message)
        }

        session.process = { state: 'awaiting_input' }
        this.stateManager.setSession(session)
        this.broadcast({ type: 'session:updated', session })

        const completion = createCompletionAttention(id, 'Agent turn completed')
        this.attentionManager.add(completion)
        this.broadcast({ type: 'attention:requested', attention: completion })

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        if (errorMsg.includes('abort')) {
          this.broadcast({ type: 'session:ended', sessionId: id, reason: 'interrupted' })
        } else {
          const attention = createErrorAttention(id, errorMsg)
          this.attentionManager.add(attention)
          this.broadcast({ type: 'attention:requested', attention })
        }
      } finally {
        this.activeQueries.delete(id)
        session.process = null
        this.stateManager.setSession(session)
        this.broadcast({ type: 'session:updated', session })
      }
    }

    runQuery()
  }

  async sendMessage(id: string, message: string | ContentBlock[]): Promise<void> {
    const session = this.stateManager.getSession(id)
    if (!session) throw new Error(`Session ${id} not found`)

    const prompt = typeof message === 'string' ? message : JSON.stringify(message)
    await this.spawnSession(id, prompt)
  }

  interrupt(id: string): boolean {
    const active = this.activeQueries.get(id)
    if (active) {
      active.abortController.abort()
      this.activeQueries.delete(id)
      return true
    }
    return false
  }

  delete(id: string): boolean {
    this.interrupt(id)
    const deleted = this.stateManager.deleteSession(id)
    if (deleted) {
      this.broadcast({ type: 'session:ended', sessionId: id, reason: 'deleted' })
    }
    return deleted
  }

  onMessage(id: string, callback: (msg: unknown) => void): () => void {
    this.messageCallbacks.set(id, callback)
    return () => this.messageCallbacks.delete(id)
  }

  resolvePermission(sessionId: string, attentionId: string, resolution: unknown): boolean {
    return this.attentionManager.resolve(attentionId, resolution)
  }
}
