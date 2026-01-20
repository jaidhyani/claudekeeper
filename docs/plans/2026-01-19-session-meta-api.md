# Claudekeeper Session Meta & API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add session metadata storage (names, config), resolved interaction logging, workdir browsing, and new API endpoints.

**Architecture:** New `session-meta.ts` module manages `~/.claudekeeper/sessions/{id}/` directories containing `meta.json` and `interactions.jsonl`. Server routes merge this data with Claude's native session data.

**Tech Stack:** TypeScript, Node.js fs APIs, existing server routing pattern

---

## Task 1: Add New Types

**Files:**
- Modify: `src/types.ts`

**Step 1: Add SessionMeta and ResolvedInteraction types**

Add to `src/types.ts`:

```typescript
// Session metadata stored in ~/.claudekeeper/sessions/{id}/meta.json
export interface SessionMeta {
  name?: string
  config?: SessionConfig
}

export interface SessionConfig {
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  allowedTools?: string[]
  disallowedTools?: string[]
}

// Resolved interaction stored in ~/.claudekeeper/sessions/{id}/interactions.jsonl
export interface ResolvedInteraction {
  id: string
  type: 'permission' | 'error' | 'completion'
  toolName?: string
  toolInput?: unknown
  resolution: string
  message?: string
  resolvedAt: string
}

// Extended session with metadata merged in
export interface ClaudeSessionWithMeta extends ClaudeSession {
  name?: string
  config?: SessionConfig
  interactions?: ResolvedInteraction[]
}

// WebSocket event for session updates
export type WSEvent =
  | { type: 'session:message'; sessionId: string; message: unknown }
  | { type: 'session:started'; sessionId: string }
  | { type: 'session:ended'; sessionId: string; reason: string }
  | { type: 'session:updated'; sessionId: string; changes: Partial<SessionMeta> }
  | { type: 'attention:requested'; attention: Attention }
  | { type: 'attention:resolved'; attentionId: string }
  | { type: 'interaction:resolved'; sessionId: string; interaction: ResolvedInteraction }
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add SessionMeta, SessionConfig, ResolvedInteraction types"
```

---

## Task 2: Create Session Meta Module

**Files:**
- Create: `src/session-meta.ts`

**Step 1: Create the session-meta module**

Create `src/session-meta.ts`:

```typescript
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
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/session-meta.ts
git commit -m "feat(session-meta): add module for ~/.claudekeeper/sessions/{id}/ management"
```

---

## Task 3: Create Workdir Browser Module

**Files:**
- Create: `src/workdir-browser.ts`

**Step 1: Create the workdir-browser module**

Create `src/workdir-browser.ts`:

```typescript
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
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/workdir-browser.ts
git commit -m "feat(workdir-browser): add workdir browse/file/config endpoints"
```

---

## Task 4: Update Server - Add PATCH Endpoint

**Files:**
- Modify: `src/server.ts`

**Step 1: Add imports at top of server.ts**

Add after existing imports:

```typescript
import { getSessionMeta, updateSessionMeta, getInteractions, deleteSessionMeta } from './session-meta.js'
import { browseWorkdir, readWorkdirFile, getWorkdirConfig } from './workdir-browser.js'
import type { SessionMeta, ClaudeSessionWithMeta } from './types.js'
```

**Step 2: Add PATCH /sessions/:id route**

Add after the DELETE /sessions/:id route in setupRoutes():

```typescript
    // Update session metadata (name, config)
    this.route('PATCH', '/sessions/:id', async (_req, res, params, body) => {
      const session = getSessionById(params.id)
      if (!session) {
        this.notFound(res, 'Session not found')
        return
      }

      const { name, config } = body as Partial<SessionMeta>
      const changes: Partial<SessionMeta> = {}

      if (name !== undefined) changes.name = name
      if (config !== undefined) changes.config = config

      const updated = updateSessionMeta(params.id, changes)

      // Broadcast update
      this.broadcast({ type: 'session:updated', sessionId: params.id, changes })

      this.json(res, updated)
    })
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): add PATCH /sessions/:id for name and config updates"
```

---

## Task 5: Update Server - Modify GET /sessions/:id

**Files:**
- Modify: `src/server.ts`

**Step 1: Update GET /sessions/:id to merge metadata**

Replace the existing GET /sessions/:id route:

```typescript
    // Get session with messages and metadata
    this.route('GET', '/sessions/:id', async (_req, res, params) => {
      const session = getSessionById(params.id)
      if (!session) {
        this.notFound(res, 'Session not found')
        return
      }

      const messages = readSessionMessages(params.id)
      const meta = getSessionMeta(params.id)
      const interactions = getInteractions(params.id)

      const response: ClaudeSessionWithMeta = {
        ...session,
        messages,
        ...(meta?.name && { name: meta.name }),
        ...(meta?.config && { config: meta.config }),
        interactions
      }

      this.json(res, response)
    })
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): merge session metadata and interactions in GET /sessions/:id"
```

---

## Task 6: Update Server - Modify POST /sessions

**Files:**
- Modify: `src/server.ts`

**Step 1: Update POST /sessions to accept name, config, and optional prompt**

Replace the existing POST /sessions route:

```typescript
    // Create new session (prompt now optional)
    this.route('POST', '/sessions', async (_req, res, _params, body) => {
      const { workdir, prompt, name, config } = body as {
        workdir?: string
        prompt?: string
        name?: string
        config?: SessionMeta['config']
      }

      if (!workdir) {
        this.badRequest(res, 'workdir is required')
        return
      }

      // Generate temp ID for tracking until SDK returns real session ID
      const tempId = `pending_${Date.now()}`

      // Store initial metadata if provided
      if (name || config) {
        // We'll update this with real session ID once we get it
        // For now, store under temp ID and migrate later
      }

      if (prompt) {
        // Run query with prompt
        this.queryManager.runQuery(tempId, prompt, workdir, undefined, config?.permissionMode)
      } else {
        // Create session without initial prompt - just return success
        // The session will be created when user sends first message
      }

      this.json(res, { tempId, name, config }, 201)
    })
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): make prompt optional in POST /sessions, accept name and config"
```

---

## Task 7: Update Server - Add Workdir Endpoints

**Files:**
- Modify: `src/server.ts`

**Step 1: Add workdir browse endpoint**

Add after the attention routes in setupRoutes():

```typescript
    // Browse workdir directory
    this.route('GET', '/workdir/browse', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      const path = url.searchParams.get('path')

      if (!path) {
        this.badRequest(res, 'path query parameter is required')
        return
      }

      const entries = browseWorkdir(path)

      if (entries === null) {
        this.notFound(res, 'Path not found or not accessible')
        return
      }

      this.json(res, { entries })
    })

    // Read workdir file
    this.route('GET', '/workdir/file', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      const path = url.searchParams.get('path')

      if (!path) {
        this.badRequest(res, 'path query parameter is required')
        return
      }

      const file = readWorkdirFile(path)

      if (file === null) {
        this.notFound(res, 'File not found, not accessible, or too large')
        return
      }

      this.json(res, file)
    })

    // Get merged workdir config
    this.route('GET', '/workdir/config', async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      const path = url.searchParams.get('path')

      if (!path) {
        this.badRequest(res, 'path query parameter is required')
        return
      }

      const config = getWorkdirConfig(path)

      if (config === null) {
        this.notFound(res, 'Workdir not found')
        return
      }

      this.json(res, { effective: config })
    })
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): add /workdir/browse, /workdir/file, /workdir/config endpoints"
```

---

## Task 8: Update Attention Manager - Log Resolutions

**Files:**
- Modify: `src/attention.ts`

**Step 1: Add interaction logging to resolve method**

First, add import at top:

```typescript
import { appendInteraction } from './session-meta.js'
import type { ResolvedInteraction } from './types.js'
```

Then update the resolve method to log interactions. Find the resolve method and add logging after the resolution:

```typescript
  resolve(id: string, resolution: AttentionResolution): boolean {
    const pending = this.pending.get(id)
    if (!pending) return false

    // Log the resolved interaction
    const interaction: ResolvedInteraction = {
      id,
      type: pending.type,
      toolName: pending.toolName,
      toolInput: pending.toolInput,
      resolution: resolution.behavior,
      message: resolution.message,
      resolvedAt: new Date().toISOString()
    }
    appendInteraction(pending.sessionId, interaction)

    // Broadcast interaction resolved event
    if (this.broadcast) {
      this.broadcast({ type: 'interaction:resolved', sessionId: pending.sessionId, interaction })
    }

    // Existing resolution logic...
    pending.resolve(resolution)
    this.pending.delete(id)
    return true
  }
```

**Step 2: Add broadcast callback to AttentionManager**

Update the constructor and class to accept a broadcast callback:

```typescript
export class AttentionManager {
  private pending = new Map<string, PendingAttention>()
  private broadcast?: (event: unknown) => void

  constructor(broadcast?: (event: unknown) => void) {
    this.broadcast = broadcast
  }
  // ... rest of class
}
```

**Step 3: Update Server to pass broadcast to AttentionManager**

In `src/server.ts`, update the constructor:

```typescript
  constructor(private config: Config) {
    this.attentionManager = new AttentionManager((e) => this.broadcast(e))
    // ... rest
  }
```

**Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/attention.ts src/server.ts
git commit -m "feat(attention): log resolved interactions and broadcast events"
```

---

## Task 9: Update Query Manager - Pass Permission Mode

**Files:**
- Modify: `src/query.ts`

**Step 1: Update runQuery signature to accept permissionMode**

Find the runQuery method and update it:

```typescript
  async runQuery(
    trackingId: string,
    prompt: string,
    workdir: string,
    existingSessionId?: string,
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  ): Promise<void> {
```

**Step 2: Pass permissionMode to SDK query options**

In the query call, add the permissionMode option:

```typescript
    const result = query({
      prompt,
      options: {
        cwd: workdir,
        resume: existingSessionId,
        abortController,
        canUseTool: this.createToolCallback(trackingId),
        includePartialMessages: true,
        pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH,
        ...(permissionMode && { permissionMode }),
        ...(permissionMode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true })
      }
    })
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/query.ts
git commit -m "feat(query): pass permissionMode to SDK"
```

---

## Task 10: Update DELETE to Clean Up Meta

**Files:**
- Modify: `src/server.ts`

**Step 1: Update DELETE /sessions/:id to also delete metadata**

Update the DELETE route:

```typescript
    // Delete session
    this.route('DELETE', '/sessions/:id', async (_req, res, params) => {
      const deleted = deleteSession(params.id)
      if (!deleted) {
        this.notFound(res, 'Session not found')
        return
      }

      // Also delete Claudekeeper metadata
      deleteSessionMeta(params.id)

      this.json(res, { deleted: true })
    })
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): delete session metadata when deleting session"
```

---

## Task 11: Update GET /sessions to Include Names

**Files:**
- Modify: `src/server.ts`

**Step 1: Update GET /sessions to merge names**

Replace the GET /sessions route:

```typescript
    // List all sessions from ~/.claude with metadata
    this.route('GET', '/sessions', async (_req, res) => {
      const sessions = listAllSessions()
      const metas = getAllSessionMetas()

      const sessionsWithMeta = sessions.map(session => {
        const meta = metas.get(session.id)
        return {
          ...session,
          ...(meta?.name && { name: meta.name }),
          ...(meta?.config && { config: meta.config })
        }
      })

      this.json(res, sessionsWithMeta)
    })
```

**Step 2: Add import for getAllSessionMetas**

Add to imports:

```typescript
import { getSessionMeta, updateSessionMeta, getInteractions, deleteSessionMeta, getAllSessionMetas } from './session-meta.js'
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): include session names and config in GET /sessions"
```

---

## Task 12: Build and Test

**Step 1: Full build**

Run: `npm run build`
Expected: Build succeeds

**Step 2: Start server and test endpoints manually**

Run: `npm start`

Test with curl:
```bash
# List sessions
curl -H "Authorization: Bearer <token>" http://localhost:3001/sessions

# PATCH a session name
curl -X PATCH -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"name":"My Test Session"}' http://localhost:3001/sessions/<session-id>

# Get session (should include name)
curl -H "Authorization: Bearer <token>" http://localhost:3001/sessions/<session-id>
```

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete session metadata and workdir API implementation"
```
