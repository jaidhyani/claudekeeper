import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ClaudeSession, Message, ContentBlock } from './types.js'

const CLAUDE_DIR = join(homedir(), '.claude', 'projects')

interface SessionIndexEntry {
  sessionId: string
  fullPath: string
  firstPrompt: string
  messageCount: number
  created: string
  modified: string
  projectPath: string
  gitBranch?: string
}

interface SessionsIndex {
  version: number
  entries: SessionIndexEntry[]
}

// Convert workdir path to Claude project directory name (e.g. /home/jai/Desktop -> -home-jai-Desktop)
function workdirToProjectDir(workdir: string): string {
  return workdir.replace(/\//g, '-')
}

// List all Claude sessions across all workdirs
export function listAllSessions(): ClaudeSession[] {
  if (!existsSync(CLAUDE_DIR)) return []

  const sessions: ClaudeSession[] = []

  for (const projectDirName of readdirSync(CLAUDE_DIR)) {
    const projectDir = join(CLAUDE_DIR, projectDirName)
    const indexPath = join(projectDir, 'sessions-index.json')

    if (!existsSync(indexPath)) continue

    try {
      const raw = readFileSync(indexPath, 'utf-8')
      const index = JSON.parse(raw) as SessionsIndex

      for (const entry of index.entries) {
        sessions.push({
          id: entry.sessionId,
          workdir: entry.projectPath,
          firstPrompt: entry.firstPrompt,
          messageCount: entry.messageCount,
          created: entry.created,
          modified: entry.modified,
          gitBranch: entry.gitBranch
        })
      }
    } catch {
      // Skip corrupted index files
    }
  }

  return sessions.sort((a, b) =>
    new Date(b.modified).getTime() - new Date(a.modified).getTime()
  )
}

// List sessions for a specific workdir
export function listSessionsForWorkdir(workdir: string): ClaudeSession[] {
  const projectDirName = workdirToProjectDir(workdir)
  const projectDir = join(CLAUDE_DIR, projectDirName)
  const indexPath = join(projectDir, 'sessions-index.json')

  if (!existsSync(indexPath)) return []

  try {
    const raw = readFileSync(indexPath, 'utf-8')
    const index = JSON.parse(raw) as SessionsIndex

    return index.entries.map(entry => ({
      id: entry.sessionId,
      workdir: entry.projectPath,
      firstPrompt: entry.firstPrompt,
      messageCount: entry.messageCount,
      created: entry.created,
      modified: entry.modified,
      gitBranch: entry.gitBranch
    })).sort((a, b) =>
      new Date(b.modified).getTime() - new Date(a.modified).getTime()
    )
  } catch {
    return []
  }
}

// Get session metadata by ID
export function getSessionById(sessionId: string): ClaudeSession | null {
  const allSessions = listAllSessions()
  return allSessions.find(s => s.id === sessionId) || null
}

// Read messages from a session's JSONL file
export function readSessionMessages(sessionId: string): Message[] {
  // Find which workdir this session belongs to
  const session = getSessionById(sessionId)
  if (!session) return []

  const projectDirName = workdirToProjectDir(session.workdir)
  const sessionPath = join(CLAUDE_DIR, projectDirName, `${sessionId}.jsonl`)

  if (!existsSync(sessionPath)) return []

  try {
    const raw = readFileSync(sessionPath, 'utf-8')
    const lines = raw.trim().split('\n')
    const messages: Message[] = []

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)

        // Only process user and assistant messages
        if (entry.type !== 'user' && entry.type !== 'assistant') continue
        if (!entry.message) continue

        // Skip meta/internal messages
        if (entry.isMeta) continue

        const role = entry.type as 'user' | 'assistant'
        const content = extractContent(entry.message.content)

        // Skip empty messages
        if (!content) continue

        messages.push({
          id: entry.uuid,
          role,
          content,
          timestamp: entry.timestamp
        })
      } catch {
        // Skip malformed lines
      }
    }

    return messages
  } catch {
    return []
  }
}

// Extract readable content from message content field
function extractContent(content: unknown): string | ContentBlock[] {
  if (!content) return ''

  // String content
  if (typeof content === 'string') {
    // Skip internal command content
    if (content.includes('<local-command-caveat>')) return ''
    if (content.includes('<command-name>')) return ''
    return content
  }

  // Array of content blocks
  if (Array.isArray(content)) {
    const blocks: ContentBlock[] = []

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        // Skip internal content
        if (block.text.includes('<local-command-caveat>')) continue
        if (block.text.includes('<command-name>')) continue
        blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool_use') {
        blocks.push({ type: 'tool_use', name: block.name, input: block.input })
      } else if (block.type === 'tool_result') {
        // Skip tool results for cleaner display
      }
    }

    return blocks.length > 0 ? blocks : ''
  }

  return ''
}

// Delete a session (JSONL file and index entry)
export function deleteSession(sessionId: string): boolean {
  const session = getSessionById(sessionId)
  if (!session) return false

  const projectDirName = workdirToProjectDir(session.workdir)
  const projectDir = join(CLAUDE_DIR, projectDirName)
  const sessionPath = join(projectDir, `${sessionId}.jsonl`)
  const indexPath = join(projectDir, 'sessions-index.json')

  // Delete the JSONL file
  if (existsSync(sessionPath)) {
    unlinkSync(sessionPath)
  }

  // Update the index to remove this session
  if (existsSync(indexPath)) {
    try {
      const raw = readFileSync(indexPath, 'utf-8')
      const index = JSON.parse(raw) as SessionsIndex
      index.entries = index.entries.filter(e => e.sessionId !== sessionId)
      writeFileSync(indexPath, JSON.stringify(index, null, 2))
    } catch {
      // Index update failed, but file was deleted
    }
  }

  return true
}
