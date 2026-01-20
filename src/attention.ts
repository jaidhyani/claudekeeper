import { randomBytes } from 'crypto'
import { appendInteraction } from './session-meta.js'
import type { Attention, AttentionResolution, ResolvedInteraction } from './types.js'

function createId(): string {
  return 'attn_' + randomBytes(8).toString('hex')
}

export function createPermissionAttention(
  sessionId: string,
  toolName: string,
  input: unknown,
  toolUseId: string
): Attention {
  return {
    id: createId(),
    sessionId,
    type: 'permission',
    toolName,
    toolInput: input,
    toolUseId,
    timestamp: new Date().toISOString()
  }
}

export function createErrorAttention(sessionId: string, message: string): Attention {
  return {
    id: createId(),
    sessionId,
    type: 'error',
    message,
    timestamp: new Date().toISOString()
  }
}

export function createCompletionAttention(sessionId: string, message: string): Attention {
  return {
    id: createId(),
    sessionId,
    type: 'completion',
    message,
    timestamp: new Date().toISOString()
  }
}

export class AttentionManager {
  private pending = new Map<string, Attention>()
  private resolvers = new Map<string, (resolution: unknown) => void>()
  private broadcast?: (event: unknown) => void

  constructor(broadcast?: (event: unknown) => void) {
    this.broadcast = broadcast
  }

  getPending(): Attention[] {
    return Array.from(this.pending.values())
  }

  getById(id: string): Attention | undefined {
    return this.pending.get(id)
  }

  add(attention: Attention): void {
    this.pending.set(attention.id, attention)
  }

  waitForResolution(attentionId: string): Promise<unknown> {
    return new Promise(resolve => {
      this.resolvers.set(attentionId, resolve)
    })
  }

  resolve(id: string, resolution: AttentionResolution): boolean {
    const attention = this.pending.get(id)
    if (!attention) return false

    // Log the resolved interaction
    const interaction: ResolvedInteraction = {
      id,
      type: attention.type,
      toolName: attention.toolName,
      toolInput: attention.toolInput,
      resolution: resolution.behavior,
      message: resolution.message,
      resolvedAt: new Date().toISOString()
    }
    appendInteraction(attention.sessionId, interaction)

    // Broadcast interaction resolved event
    if (this.broadcast) {
      this.broadcast({ type: 'interaction:resolved', sessionId: attention.sessionId, interaction })
    }

    const resolver = this.resolvers.get(id)
    if (resolver) {
      // Build SDK-compatible result
      const result: Record<string, unknown> = { behavior: resolution.behavior }

      if (attention.toolUseId) {
        result.toolUseID = attention.toolUseId
      }

      // SDK expects updatedInput for allow behavior
      if (resolution.behavior === 'allow' && attention.toolInput !== undefined) {
        result.updatedInput = attention.toolInput
      }

      if (resolution.behavior === 'deny') {
        result.message = resolution.message || 'Denied by user'
      }

      resolver(result)
      this.resolvers.delete(id)
    }

    this.pending.delete(id)
    return true
  }

  clearForSession(sessionId: string): void {
    for (const [id, attention] of this.pending) {
      if (attention.sessionId === sessionId) {
        this.pending.delete(id)
        this.resolvers.delete(id)
      }
    }
  }
}
