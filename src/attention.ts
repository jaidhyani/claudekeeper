import { randomBytes } from 'crypto'
import type { AttentionRequest } from './types.js'
import type { StateManager } from './state.js'

export function createAttentionId(): string {
  return 'attn_' + randomBytes(8).toString('hex')
}

export function createPermissionAttention(
  sessionId: string,
  toolName: string,
  input: unknown
): AttentionRequest {
  return {
    id: createAttentionId(),
    sessionId,
    source: `session:${sessionId}`,
    type: 'permission',
    summary: `Permission requested for ${toolName}`,
    payload: { toolName, input },
    createdAt: new Date().toISOString()
  }
}

export function createQuestionAttention(
  sessionId: string,
  question: string,
  options?: string[]
): AttentionRequest {
  return {
    id: createAttentionId(),
    sessionId,
    source: `session:${sessionId}`,
    type: 'question',
    summary: question,
    payload: { question, options },
    createdAt: new Date().toISOString()
  }
}

export function createCompletionAttention(
  sessionId: string,
  summary: string
): AttentionRequest {
  return {
    id: createAttentionId(),
    sessionId,
    source: `session:${sessionId}`,
    type: 'completion',
    summary,
    payload: { summary },
    createdAt: new Date().toISOString()
  }
}

export function createErrorAttention(
  sessionId: string,
  error: string
): AttentionRequest {
  return {
    id: createAttentionId(),
    sessionId,
    source: `session:${sessionId}`,
    type: 'error',
    summary: `Error: ${error}`,
    payload: { error },
    createdAt: new Date().toISOString()
  }
}

export class AttentionManager {
  private pendingResolvers = new Map<string, (resolution: unknown) => void>()

  constructor(private stateManager: StateManager) {}

  getPending(): AttentionRequest[] {
    return this.stateManager.getAttention()
  }

  getById(id: string): AttentionRequest | undefined {
    return this.stateManager.getAttentionById(id)
  }

  add(attention: AttentionRequest): void {
    this.stateManager.addAttention(attention)
  }

  waitForResolution(attentionId: string): Promise<unknown> {
    return new Promise(resolve => {
      this.pendingResolvers.set(attentionId, resolve)
    })
  }

  resolve(id: string, resolution: unknown): boolean {
    const resolved = this.stateManager.resolveAttention(id, resolution)
    if (resolved) {
      const resolver = this.pendingResolvers.get(id)
      if (resolver) {
        resolver(resolution)
        this.pendingResolvers.delete(id)
      }
    }
    return resolved
  }
}
