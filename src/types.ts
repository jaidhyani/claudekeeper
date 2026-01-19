// Claude session from ~/.claude/projects/{workdir}/sessions-index.json
export interface ClaudeSession {
  id: string                    // UUID from filename
  workdir: string               // Project path (e.g. /home/jai/Desktop/myproject)
  firstPrompt: string
  messageCount: number
  created: string               // ISO timestamp
  modified: string              // ISO timestamp
  gitBranch?: string
}

// Message extracted from JSONL files
export interface Message {
  id: string                    // UUID from JSONL
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  timestamp: string
}

export interface ContentBlock {
  type: string
  text?: string
  name?: string
  input?: unknown
}

// Attention request (permission prompts from SDK)
export interface Attention {
  id: string
  sessionId: string
  type: 'permission' | 'error' | 'completion'
  toolName?: string
  toolInput?: unknown
  toolUseId?: string
  message?: string
  timestamp: string
}

export interface AttentionResolution {
  behavior: 'allow' | 'deny' | 'allowAlways' | string
  message?: string
}

// Active SDK query state
export interface ActiveQuery {
  sessionId: string
  abortController: AbortController
}

// Config stored in ~/.claudekeeper/config.json
export interface Config {
  port: number
  token: string
}

// WebSocket event types
export type WSEvent =
  | { type: 'session:message'; sessionId: string; message: unknown }
  | { type: 'session:started'; sessionId: string }
  | { type: 'session:ended'; sessionId: string; reason: string }
  | { type: 'attention:requested'; attention: Attention }
  | { type: 'attention:resolved'; attentionId: string }
