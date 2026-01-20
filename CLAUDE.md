# Claudekeeper Development Guide

## Architecture

Claudekeeper is a session coordinator service that:
1. Manages Claude Code sessions via the `@anthropic-ai/claude-agent-sdk`
2. Surfaces attention needs (permissions, questions, errors, completions)
3. Routes user responses back to sessions
4. Provides REST API + WebSocket for real-time events

## Key Files

- `src/types.ts` - Shared type definitions
- `src/server.ts` - HTTP server with REST routes and WebSocket
- `src/query.ts` - QueryManager that runs SDK queries and handles permissions
- `src/attention.ts` - Attention queue management (permissions, errors, completions)
- `src/claude-sessions.ts` - Reads session data from Claude Code's native storage
- `src/session-meta.ts` - Claudekeeper's own metadata storage (names, configs)
- `src/workdir-browser.ts` - Secure directory/file browsing for clients
- `src/index.ts` - Entry point

## Session Storage

**Claude Code sessions** are stored by Claude Code itself:
- Location: `~/.claude/projects/<workdir-path>/<session-id>.jsonl`
- Example: `~/.claude/projects/-home-jai-Desktop-myproject/abc123.jsonl`
- The workdir path has slashes replaced with dashes

**Claudekeeper metadata** (session names, configs) is stored separately:
- Location: `~/.claudekeeper/sessions/<session-id>/meta.json`

**Important:** There may be a `sessions-index.json` file in Claude's project directories - DO NOT rely on it. It's not reliably maintained. Always read session data directly from `.jsonl` files.

## Data Flow

### Creating a Session
1. Client POSTs to `/sessions` with `{workdir, prompt?, name?, config?}`
2. If prompt provided: QueryManager spawns SDK query immediately
3. If no prompt: Session stored as "pending" in memory
4. SDK spawns Claude Code process which creates the .jsonl file
5. Messages stream via WebSocket as `session:message` events

### Pending Sessions
Sessions created without a prompt are tracked in `server.ts`:
```typescript
private pendingSessions = new Map<string, PendingSession>()
```
When client sends first message via `/sessions/:id/send`, the pending session is converted to a real session.

### Permission Flow
1. SDK permission callback creates attention request
2. Server broadcasts `attention:requested` event
3. Client resolves via `POST /attention/:id/resolve`
4. SDK callback receives resolution, continues or aborts

## Listing Sessions

`claude-sessions.ts` reads sessions by:
1. Scanning all directories in `~/.claude/projects/`
2. Finding all `.jsonl` files in each directory
3. Parsing each file to extract: workdir (from `cwd` field), firstPrompt, timestamps, messageCount
4. Sorting by modified time (most recent first)

This is intentionally slow but reliable - no index to get out of sync.

## Building & Running

```bash
npm install
npm run build  # TypeScript compile
npm start      # Start server (reads token from ~/.claudekeeper/config.json or generates one)
```

Server logs token on startup. Use this token for all API requests.

## Debugging Tips

- Check `/tmp/claudekeeper.log` if running via nohup
- QueryManager logs `[QueryManager] Starting query...` when spawning sessions
- If sessions aren't appearing in list, check the .jsonl file exists in `~/.claude/projects/`
- Session workdir comes from the `cwd` field in message entries, not the directory name
