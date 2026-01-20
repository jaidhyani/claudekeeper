import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SessionMeta, ResolvedInteraction } from './types.js'

const CLAUDEKEEPER_DIR = join(homedir(), '.claudekeeper')
const SESSIONS_DIR = join(CLAUDEKEEPER_DIR, 'sessions')

function ensureSessionDir(sessionId: string): string {
  const dir = join(SESSIONS_DIR, sessionId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getSessionMeta(sessionId: string): SessionMeta | null {
  const metaPath = join(SESSIONS_DIR, sessionId, 'meta.json')
  if (!existsSync(metaPath)) return null

  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'))
  } catch {
    return null
  }
}

export function setSessionMeta(sessionId: string, meta: SessionMeta): void {
  const dir = ensureSessionDir(sessionId)
  const metaPath = join(dir, 'meta.json')

  const existing = getSessionMeta(sessionId) || {}
  const merged = { ...existing, ...meta }

  writeFileSync(metaPath, JSON.stringify(merged, null, 2))
}

export function updateSessionMeta(sessionId: string, changes: Partial<SessionMeta>): SessionMeta {
  const existing = getSessionMeta(sessionId) || {}
  const updated = { ...existing, ...changes }
  setSessionMeta(sessionId, updated)
  return updated
}

export function appendInteraction(sessionId: string, interaction: ResolvedInteraction): void {
  const dir = ensureSessionDir(sessionId)
  const interactionsPath = join(dir, 'interactions.jsonl')
  appendFileSync(interactionsPath, JSON.stringify(interaction) + '\n')
}

export function getInteractions(sessionId: string): ResolvedInteraction[] {
  const interactionsPath = join(SESSIONS_DIR, sessionId, 'interactions.jsonl')
  if (!existsSync(interactionsPath)) return []

  try {
    const raw = readFileSync(interactionsPath, 'utf-8')
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

export function deleteSessionMeta(sessionId: string): boolean {
  const dir = join(SESSIONS_DIR, sessionId)
  if (!existsSync(dir)) return false

  try {
    rmSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

export function getAllSessionMetas(): Map<string, SessionMeta> {
  const metas = new Map<string, SessionMeta>()
  if (!existsSync(SESSIONS_DIR)) return metas

  for (const sessionId of readdirSync(SESSIONS_DIR)) {
    const meta = getSessionMeta(sessionId)
    if (meta) metas.set(sessionId, meta)
  }

  return metas
}
