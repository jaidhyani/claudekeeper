import { readFileSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ClaudeSession, Message, ContentBlock } from './types.js'

const CLAUDE_DIR = join(homedir(), '.claude', 'projects')

// Convert workdir path to Claude project directory name (e.g. /home/jai/Desktop -> -home-jai-Desktop)
function workdirToProjectDir(workdir: string): string {
  return workdir.replace(/\//g, '-')
}

// Parse session metadata from a .jsonl file
function parseSessionFile(sessionPath: string): ClaudeSession | null {
  try {
    const raw = readFileSync(sessionPath, 'utf-8')
    const lines = raw.trim().split('\n')

    let firstPrompt = ''
    let created = ''
    let modified = ''
    let gitBranch = ''
    let workdir = ''
    let messageCount = 0

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)

        // Get workdir (cwd) from any message entry
        if (!workdir && entry.cwd) {
          workdir = entry.cwd
        }

        // Get metadata from first user message
        if (entry.type === 'user' && entry.message?.content) {
          messageCount++
          if (!firstPrompt) {
            const content = entry.message.content
            if (typeof content === 'string') {
              firstPrompt = content.slice(0, 200)
            } else if (Array.isArray(content)) {
              const textBlock = content.find((b: { type: string }) => b.type === 'text')
              if (textBlock?.text) {
                firstPrompt = textBlock.text.slice(0, 200)
              }
            }
          }
          if (!created && entry.timestamp) {
            created = entry.timestamp
          }
          if (!gitBranch && entry.gitBranch) {
            gitBranch = entry.gitBranch
          }
        }

        if (entry.type === 'assistant') {
          messageCount++
        }

        // Track latest timestamp
        if (entry.timestamp) {
          modified = entry.timestamp
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (!firstPrompt || !workdir) return null

    const sessionId = sessionPath.split('/').pop()?.replace('.jsonl', '') || ''

    return {
      id: sessionId,
      workdir,
      firstPrompt,
      messageCount,
      created: created || modified,
      modified,
      gitBranch
    }
  } catch {
    return null
  }
}

// List all Claude sessions across all workdirs (reads directly from .jsonl files)
export function listAllSessions(): ClaudeSession[] {
  if (!existsSync(CLAUDE_DIR)) return []

  const sessions: ClaudeSession[] = []

  for (const projectDirName of readdirSync(CLAUDE_DIR)) {
    const projectDir = join(CLAUDE_DIR, projectDirName)

    // Read all .jsonl files in this project directory
    let files: string[]
    try {
      files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }

    for (const file of files) {
      const sessionPath = join(projectDir, file)
      const session = parseSessionFile(sessionPath)
      if (session) {
        sessions.push(session)
      }
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

  if (!existsSync(projectDir)) return []

  const sessions: ClaudeSession[] = []

  try {
    const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))

    for (const file of files) {
      const sessionPath = join(projectDir, file)
      const session = parseSessionFile(sessionPath)
      if (session) {
        sessions.push(session)
      }
    }
  } catch {
    return []
  }

  return sessions.sort((a, b) =>
    new Date(b.modified).getTime() - new Date(a.modified).getTime()
  )
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

// Delete a session (JSONL file)
export function deleteSession(sessionId: string): boolean {
  const session = getSessionById(sessionId)
  if (!session) return false

  const projectDirName = workdirToProjectDir(session.workdir)
  const projectDir = join(CLAUDE_DIR, projectDirName)
  const sessionPath = join(projectDir, `${sessionId}.jsonl`)

  // Delete the JSONL file
  if (existsSync(sessionPath)) {
    unlinkSync(sessionPath)
    return true
  }

  return false
}
