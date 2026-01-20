import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { listAllSessions } from './claude-sessions.js'

export interface BrowseEntry {
  name: string
  type: 'file' | 'directory'
  size: number
}

export interface FileContent {
  content: string
  size: number
  modified: string
}

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

function getKnownWorkdirs(): Set<string> {
  const sessions = listAllSessions()
  return new Set(sessions.map(s => s.workdir))
}

function isPathInWorkdir(path: string, workdirs: Set<string>): boolean {
  const resolved = resolve(path)
  for (const workdir of workdirs) {
    if (resolved === workdir || resolved.startsWith(workdir + '/')) {
      return true
    }
  }
  return false
}

export function browseWorkdir(path: string): BrowseEntry[] | null {
  const workdirs = getKnownWorkdirs()

  if (!isPathInWorkdir(path, workdirs)) {
    return null // Security: path not in known workdir
  }

  if (!existsSync(path)) return null

  const stat = statSync(path)
  if (!stat.isDirectory()) return null

  const entries: BrowseEntry[] = []

  for (const name of readdirSync(path)) {
    try {
      const fullPath = join(path, name)
      const entryStat = statSync(fullPath)
      entries.push({
        name,
        type: entryStat.isDirectory() ? 'directory' : 'file',
        size: entryStat.size
      })
    } catch {
      // Skip inaccessible entries
    }
  }

  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export function readWorkdirFile(path: string): FileContent | null {
  const workdirs = getKnownWorkdirs()

  if (!isPathInWorkdir(path, workdirs)) {
    return null // Security: path not in known workdir
  }

  if (!existsSync(path)) return null

  const stat = statSync(path)
  if (!stat.isFile()) return null
  if (stat.size > MAX_FILE_SIZE) return null

  try {
    const content = readFileSync(path, 'utf-8')
    return {
      content,
      size: stat.size,
      modified: stat.mtime.toISOString()
    }
  } catch {
    return null
  }
}

export function getWorkdirConfig(workdir: string): Record<string, unknown> | null {
  const workdirs = getKnownWorkdirs()

  if (!workdirs.has(workdir)) {
    return null
  }

  const globalPath = join(homedir(), '.claude', 'settings.json')
  const projectPath = join(workdir, '.claude', 'settings.json')
  const localPath = join(workdir, '.claude', 'settings.local.json')

  let effective: Record<string, unknown> = {}

  // Layer 1: Global settings
  if (existsSync(globalPath)) {
    try {
      effective = { ...effective, ...JSON.parse(readFileSync(globalPath, 'utf-8')) }
    } catch {}
  }

  // Layer 2: Project settings (override global)
  if (existsSync(projectPath)) {
    try {
      effective = { ...effective, ...JSON.parse(readFileSync(projectPath, 'utf-8')) }
    } catch {}
  }

  // Layer 3: Local settings (override project)
  if (existsSync(localPath)) {
    try {
      effective = { ...effective, ...JSON.parse(readFileSync(localPath, 'utf-8')) }
    } catch {}
  }

  return effective
}
