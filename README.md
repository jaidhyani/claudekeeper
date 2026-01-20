# Claudekeeper

Session coordinator for Claude Code - manages multiple async sessions with attention routing.

## Overview

Claudekeeper is a service that manages Claude Code sessions, surfaces attention needs (permissions, questions, completions), and routes responses. It uses the `@anthropic-ai/claude-agent-sdk` to spawn and communicate with Claude Code processes.

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
# Start server (logs token to console)
npm start

# Or run directly
node dist/index.js

# With nohup for background
nohup npm start > /tmp/claudekeeper.log 2>&1 &
```

The server logs its token on startup. Use this token for all API requests.

## API

### Sessions

- `GET /sessions` - List all sessions (reads from ~/.claude/projects/)
- `GET /sessions/:id` - Get session with messages
- `POST /sessions` - Create new session
  - Body: `{workdir: string, prompt?: string, name?: string, config?: {permissionMode?: string}}`
  - If no prompt provided, session is "pending" until first message
- `PATCH /sessions/:id` - Update session metadata (name, config)
- `DELETE /sessions/:id` - Delete session
- `POST /sessions/:id/send` - Send message to session
  - Body: `{message: string}`
  - For pending sessions, this creates the actual session

### Attention

- `GET /attention` - List pending attention requests
- `POST /attention/:id/resolve` - Resolve an attention request
  - Body: `{allow: boolean}` for permissions
  - Body: `{answer: string}` for questions

### Workdir Browser

- `GET /workdir/browse?path=<path>` - List directory contents
- `GET /workdir/file?path=<path>` - Read file contents
- `GET /workdir/config?path=<path>` - Get merged Claude config for workdir

### Health

- `GET /health` - Health check

## WebSocket

Connect to `ws://localhost:3100/ws?token=<token>` for real-time events:

- `session:started` - New session ID available
- `session:message` - Message from session (user or assistant)
- `session:ended` - Session query completed or interrupted
- `attention:requested` - Permission/question/error needs resolution
- `attention:resolved` - Attention request was resolved

## Authentication

All requests require the token either as:
- Bearer token: `Authorization: Bearer <token>`
- Query param: `?token=<token>`

## Session Storage

Sessions are stored by Claude Code in `~/.claude/projects/<workdir>/*.jsonl`. Claudekeeper reads these files directly to list sessions. Additional metadata (names, configs) is stored in `~/.claudekeeper/sessions/<id>/meta.json`.

## Client Libraries

- **Clarvis** - Web UI client for Claudekeeper
