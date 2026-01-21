import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import type { ActiveQuery, ClaudeSession } from './types.js'
import { AttentionManager, createPermissionAttention, createErrorAttention, createCompletionAttention } from './attention.js'
import { getSessionById } from './claude-sessions.js'

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
    tempId: string,
    prompt: string,
    workdir: string,
    resumeSessionId?: string,
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  ): Promise<void> {
    console.log(`[QueryManager] Starting query: tempId=${tempId}, workdir=${workdir}, resumeSessionId=${resumeSessionId}, permissionMode=${permissionMode}`)
    console.log(`[QueryManager] Prompt: ${prompt.slice(0, 100)}...`)
    const abortController = new AbortController()

    // Track by tempId initially, will update to realSessionId when SDK returns it
    this.activeQueries.set(tempId, { sessionId: tempId, abortController })

    // Will be set when SDK returns the real session ID
    let realSessionId: string | null = null

    const canUseTool = async (
      toolName: string,
      input: unknown,
      options: { toolUseID: string }
    ) => {
      // Use real session ID if available, otherwise tempId
      const sessionId = realSessionId ?? tempId
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
        const msg = message as { sessionId?: string }

        // Capture real session ID from SDK (only on first message that has it)
        if (msg.sessionId && !realSessionId) {
          realSessionId = msg.sessionId
          console.log(`[QueryManager] Got real sessionId=${realSessionId} for tempId=${tempId}`)

          // Update tracking: remove tempId entry, add realSessionId entry
          this.activeQueries.delete(tempId)
          this.activeQueries.set(realSessionId, { sessionId: realSessionId, abortController })

          // Fetch full session data and broadcast session:created
          // Small delay to ensure JSONL file is written
          setTimeout(() => {
            const session = getSessionById(realSessionId!)
            if (session) {
              this.broadcast({
                type: 'session:created',
                session,
                tempId
              })
            } else {
              // Session file may not exist yet, broadcast minimal info
              this.broadcast({
                type: 'session:created',
                session: {
                  id: realSessionId!,
                  workdir,
                  firstPrompt: prompt.slice(0, 200),
                  messageCount: 0,
                  created: new Date().toISOString(),
                  modified: new Date().toISOString()
                } as ClaudeSession,
                tempId
              })
            }
          }, 100)
        }

        // Broadcast message with real session ID if available
        const sessionId = realSessionId ?? tempId
        this.broadcast({ type: 'session:message', sessionId, message })
      }

      const sessionId = realSessionId ?? tempId
      const completion = createCompletionAttention(sessionId, 'Query completed')
      this.attentionManager.add(completion)
      this.broadcast({ type: 'attention:requested', attention: completion })

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[QueryManager] Error in query: ${errorMsg}`)

      const sessionId = realSessionId ?? tempId
      if (errorMsg.includes('abort')) {
        this.broadcast({ type: 'session:ended', sessionId, reason: 'interrupted' })
      } else {
        const attention = createErrorAttention(sessionId, errorMsg)
        this.attentionManager.add(attention)
        this.broadcast({ type: 'attention:requested', attention })
      }
    } finally {
      const sessionId = realSessionId ?? tempId
      this.activeQueries.delete(tempId)
      if (realSessionId) {
        this.activeQueries.delete(realSessionId)
      }
      this.broadcast({ type: 'session:ended', sessionId, reason: 'completed' })
    }
  }
}
