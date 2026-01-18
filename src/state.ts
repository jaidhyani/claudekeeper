import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { CoordinatorState, CoordinatorConfig, Session, AttentionRequest } from './types.js'

const STATE_DIR = join(homedir(), '.claudekeeper')
const STATE_FILE = join(STATE_DIR, 'state.json')
const CONFIG_FILE = join(STATE_DIR, 'config.json')

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true })
  }
}

function defaultConfig(): CoordinatorConfig {
  return {
    port: 3100,
    token: randomBytes(16).toString('hex'),
    autoImport: false,
    webhooks: []
  }
}

export function loadConfig(): CoordinatorConfig {
  ensureDir()
  if (!existsSync(CONFIG_FILE)) {
    const config = defaultConfig()
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
    return config
  }
  const raw = readFileSync(CONFIG_FILE, 'utf-8')
  return JSON.parse(raw) as CoordinatorConfig
}

export function saveConfig(config: CoordinatorConfig): void {
  ensureDir()
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

export function loadState(): CoordinatorState {
  ensureDir()
  const config = loadConfig()
  if (!existsSync(STATE_FILE)) {
    return { sessions: {}, attention: [], config }
  }
  const raw = readFileSync(STATE_FILE, 'utf-8')
  const partial = JSON.parse(raw) as Partial<CoordinatorState>
  return {
    sessions: partial.sessions ?? {},
    attention: partial.attention ?? [],
    config
  }
}

export function saveState(state: CoordinatorState): void {
  ensureDir()
  const { sessions, attention } = state
  writeFileSync(STATE_FILE, JSON.stringify({ sessions, attention }, null, 2))
}

export class StateManager {
  private state: CoordinatorState

  constructor() {
    this.state = loadState()
  }

  getConfig(): CoordinatorConfig {
    return this.state.config
  }

  getSessions(): Session[] {
    return Object.values(this.state.sessions)
  }

  getSession(id: string): Session | undefined {
    return this.state.sessions[id]
  }

  setSession(session: Session): void {
    this.state.sessions[session.id] = session
    this.persist()
  }

  deleteSession(id: string): boolean {
    if (this.state.sessions[id]) {
      delete this.state.sessions[id]
      this.state.attention = this.state.attention.filter(a => a.sessionId !== id)
      this.persist()
      return true
    }
    return false
  }

  getAttention(): AttentionRequest[] {
    return this.state.attention.filter(a => !a.resolvedAt)
  }

  getAttentionById(id: string): AttentionRequest | undefined {
    return this.state.attention.find(a => a.id === id)
  }

  addAttention(attention: AttentionRequest): void {
    this.state.attention.push(attention)
    this.persist()
  }

  resolveAttention(id: string, resolution: unknown): boolean {
    const attention = this.state.attention.find(a => a.id === id)
    if (attention && !attention.resolvedAt) {
      attention.resolvedAt = new Date().toISOString()
      attention.resolution = resolution
      this.persist()
      return true
    }
    return false
  }

  private persist(): void {
    saveState(this.state)
  }
}
