export interface SessionConfig {
  model?: string
  allowedTools?: string[]
  permissionMode?: string
}

export interface SessionProcess {
  state: 'agent_turn' | 'awaiting_feedback' | 'awaiting_input'
  pid?: number
}

export interface Session {
  id: string
  workdir: string
  name?: string
  createdAt: string
  lastActivity: string
  process: SessionProcess | null
  config: SessionConfig
}

export interface AttentionRequest {
  id: string
  sessionId: string
  source: string
  type: 'permission' | 'question' | 'completion' | 'error'
  summary: string
  payload: unknown
  createdAt: string
  resolvedAt?: string
  resolution?: unknown
}

export interface CoordinatorConfig {
  port: number
  token: string
  autoImport: boolean
  webhooks: string[]
}

export interface CoordinatorState {
  sessions: Record<string, Session>
  attention: AttentionRequest[]
  config: CoordinatorConfig
}

export type WSEventType =
  | 'session:created'
  | 'session:updated'
  | 'session:ended'
  | 'session:message'
  | 'attention:requested'
  | 'attention:resolved'

export interface WSEvent {
  type: WSEventType
  [key: string]: unknown
}

export interface CreateSessionRequest {
  workdir: string
  prompt?: string
  name?: string
  config?: SessionConfig
}

export interface SendMessageRequest {
  message: string | ContentBlock[]
}

export interface ResolveAttentionRequest {
  behavior: 'allow' | 'deny'
  updatedInput?: unknown
  message?: string
}

export interface ContentBlock {
  type: 'text' | 'image'
  text?: string
  source?: {
    type: 'base64'
    media_type: string
    data: string
  }
}
