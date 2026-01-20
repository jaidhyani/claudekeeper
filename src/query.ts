import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import type { ActiveQuery } from './types.js'
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

export class QueryManager {
  private activeQueries = new Map<string, ActiveQuery>()

  constructor(
    private attentionManager: AttentionManager,
    private broadcast: (event: unknown) => void
  ) {}

  isActive(sessionId: string): boolean {
    return this.activeQueries.has(sessionId)
  }

  interrupt(sessionId: string): boolean {
    const active = this.activeQueries.get(sessionId)
    if (active) {
      active.abortController.abort()
      this.activeQueries.delete(sessionId)
      return true
    }
    return false
  }

  async runQuery(
    sessionId: string,
    prompt: string,
    workdir: string,
    resumeSessionId?: string,
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  ): Promise<void> {
    console.log(`[QueryManager] Starting query: sessionId=${sessionId}, workdir=${workdir}, resumeSessionId=${resumeSessionId}, permissionMode=${permissionMode}`)
    console.log(`[QueryManager] Prompt: ${prompt.slice(0, 100)}...`)
    const abortController = new AbortController()
    this.activeQueries.set(sessionId, { sessionId, abortController })

    const canUseTool = async (
      toolName: string,
      input: unknown,
      options: { toolUseID: string }
    ) => {
      const attention = createPermissionAttention(sessionId, toolName, input, options.toolUseID)
      this.attentionManager.add(attention)
      this.broadcast({ type: 'attention:requested', attention })

      const resolution = await this.attentionManager.waitForResolution(attention.id)
      this.broadcast({ type: 'attention:resolved', attentionId: attention.id })

      return resolution
    }

    try {
      const options: Record<string, unknown> = {
        abortController,
        canUseTool,
        includePartialMessages: true,
        cwd: workdir,
        pathToClaudeCodeExecutable: claudePath,
        ...(permissionMode && { permissionMode }),
        ...(permissionMode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true })
      }

      // Resume existing Claude session if provided
      if (resumeSessionId) {
        options.resume = resumeSessionId
      }

      const response = query({ prompt, options })

      for await (const message of response) {
        // Capture session ID from first message
        const msg = message as { sessionId?: string }
        if (msg.sessionId) {
          this.broadcast({ type: 'session:started', sessionId: msg.sessionId })
        }

        this.broadcast({ type: 'session:message', sessionId, message })
      }

      const completion = createCompletionAttention(sessionId, 'Query completed')
      this.attentionManager.add(completion)
      this.broadcast({ type: 'attention:requested', attention: completion })

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[QueryManager] Error in query: ${errorMsg}`)

      if (errorMsg.includes('abort')) {
        this.broadcast({ type: 'session:ended', sessionId, reason: 'interrupted' })
      } else {
        const attention = createErrorAttention(sessionId, errorMsg)
        this.attentionManager.add(attention)
        this.broadcast({ type: 'attention:requested', attention })
      }
    } finally {
      this.activeQueries.delete(sessionId)
      this.broadcast({ type: 'session:ended', sessionId, reason: 'completed' })
    }
  }
}
