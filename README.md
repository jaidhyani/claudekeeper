# Claudekeeper

Session coordinator for Claude Code - manages multiple async sessions with attention routing.

## Overview

Claudekeeper is a service that:
- Manages Claude Code sessions via the `@anthropic-ai/claude-agent-sdk`
- Reads session history from `~/.claude/projects/`
- Surfaces attention needs (permissions, errors, completions) via WebSocket
- Routes user responses back to sessions

## Installation

```bash
npm install
npm run build
```

## Configuration

On first run, Claudekeeper creates `~/.claudekeeper/config.json`:

```json
{
  "port": 3100,
  "token": "<generated-uuid>"
}
```

The token is logged on startup. Use it for all API requests.

## Usage

```bash
npm start                    # Start server
npm run dev                  # Development with auto-reload
node dist/index.js           # Run directly

# Background with logs
nohup npm start > /tmp/claudekeeper.log 2>&1 &
```

## Authentication

All requests require the token either as:
- Header: `Authorization: Bearer <token>`
- Query param: `?token=<token>`

---

## REST API

### Health Check

```
GET /health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2026-01-21T12:00:00.000Z"
}
```

### List Sessions

```
GET /sessions
```

Returns all sessions from `~/.claude/projects/` with Claudekeeper metadata merged in.

Response:
```json
[
  {
    "id": "f71a7e8f-269c-4edf-aae2-8c8143a9eec7",
    "workdir": "/home/user/project",
    "firstPrompt": "Help me refactor the auth module",
    "messageCount": 12,
    "created": "2026-01-21T10:00:00.000Z",
    "modified": "2026-01-21T11:30:00.000Z",
    "gitBranch": "main",
    "name": "Auth refactor",
    "config": { "permissionMode": "default" }
  }
]
```

### Get Session

```
GET /sessions/:id
```

Returns session with messages and resolved interactions.

Response:
```json
{
  "id": "f71a7e8f-269c-4edf-aae2-8c8143a9eec7",
  "workdir": "/home/user/project",
  "firstPrompt": "...",
  "messageCount": 12,
  "created": "...",
  "modified": "...",
  "name": "Auth refactor",
  "messages": [
    {
      "id": "msg-uuid",
      "role": "user",
      "content": "Help me refactor the auth module",
      "timestamp": "2026-01-21T10:00:00.000Z"
    },
    {
      "id": "msg-uuid-2",
      "role": "assistant",
      "content": [
        { "type": "text", "text": "I'll help you..." },
        { "type": "tool_use", "name": "Read", "input": { "file_path": "/..." } }
      ],
      "timestamp": "2026-01-21T10:00:05.000Z"
    }
  ],
  "interactions": [
    {
      "type": "permission",
      "toolName": "Edit",
      "toolInput": { "file_path": "..." },
      "resolution": "allow",
      "resolvedAt": "2026-01-21T10:01:00.000Z"
    }
  ]
}
```

### Create Session

```
POST /sessions
Content-Type: application/json

{
  "workdir": "/home/user/project",
  "prompt": "Help me debug this",
  "name": "Debug session",
  "config": {
    "permissionMode": "default"
  }
}
```

- `workdir` (required): Project directory path
- `prompt` (optional): Initial prompt. If omitted, session is "pending" until first message.
- `name` (optional): Display name for session
- `config.permissionMode` (optional): `"default"` | `"acceptEdits"` | `"bypassPermissions"`

Response:
```json
{
  "tempId": "pending_1705840000000",
  "name": "Debug session",
  "config": { "permissionMode": "default" }
}
```

The `tempId` is a temporary identifier. When the Claude SDK returns the real session ID, a `session:created` WebSocket event is broadcast with both `tempId` and the real session data.

### Update Session

```
PATCH /sessions/:id
Content-Type: application/json

{
  "name": "New name",
  "config": { "permissionMode": "acceptEdits" }
}
```

### Delete Session

```
DELETE /sessions/:id
```

Deletes the session JSONL file and Claudekeeper metadata.

### Send Message

```
POST /sessions/:id/send
Content-Type: application/json

{
  "message": "Please continue with step 2"
}
```

For pending sessions (created without prompt), this creates the actual Claude session.

Response:
```json
{
  "sent": true,
  "newSession": true  // Only present if this was a pending session
}
```

### Interrupt Session

```
POST /sessions/:id/interrupt
```

Interrupts an active query.

Response:
```json
{
  "interrupted": true
}
```

### List Attention Requests

```
GET /attention
```

Returns pending attention items awaiting user resolution.

Response:
```json
[
  {
    "id": "attn-uuid",
    "sessionId": "session-uuid",
    "type": "permission",
    "toolName": "Edit",
    "toolInput": { "file_path": "/path/to/file.ts", "old_string": "...", "new_string": "..." },
    "toolUseId": "tool-use-id",
    "timestamp": "2026-01-21T10:00:00.000Z"
  },
  {
    "id": "attn-uuid-2",
    "sessionId": "session-uuid",
    "type": "error",
    "message": "Command failed with exit code 1",
    "timestamp": "2026-01-21T10:01:00.000Z"
  }
]
```

Attention types:
- `permission`: Tool needs approval (Edit, Bash, etc.)
- `error`: Query encountered an error
- `completion`: Query completed successfully

### Resolve Attention

```
POST /attention/:id/resolve
Content-Type: application/json

{
  "behavior": "allow",
  "message": "Optional message"
}
```

- `behavior`: `"allow"` | `"deny"` | `"allowAlways"`
- `message` (optional): Feedback message

### Browse Workdir

```
GET /workdir/browse?path=/home/user/project
```

Response:
```json
{
  "entries": [
    { "name": "src", "type": "directory" },
    { "name": "package.json", "type": "file" }
  ]
}
```

### Read Workdir File

```
GET /workdir/file?path=/home/user/project/package.json
```

Response:
```json
{
  "content": "{ \"name\": \"my-project\", ... }",
  "size": 1234
}
```

### Get Workdir Config

```
GET /workdir/config?path=/home/user/project
```

Returns merged Claude configuration for the workdir.

Response:
```json
{
  "effective": {
    "permissionMode": "default",
    "allowedTools": ["Read", "Glob", "Grep"]
  }
}
```

---

## WebSocket API

Connect to `ws://localhost:3100/ws?token=<token>` for real-time events.

After connecting, send a subscribe message:
```json
{ "type": "subscribe" }
```

Server responds:
```json
{ "type": "subscribed" }
```

### Events

#### session:created

Broadcast when Claude SDK returns the real session ID for a newly created session.

```json
{
  "type": "session:created",
  "session": {
    "id": "f71a7e8f-269c-4edf-aae2-8c8143a9eec7",
    "workdir": "/home/user/project",
    "firstPrompt": "Help me debug this",
    "messageCount": 0,
    "created": "2026-01-21T10:00:00.000Z",
    "modified": "2026-01-21T10:00:00.000Z"
  },
  "tempId": "pending_1705840000000"
}
```

Use `tempId` to correlate with your local pending session and replace it with the real session.

#### session:message

Broadcast for each message during a query.

```json
{
  "type": "session:message",
  "sessionId": "f71a7e8f-269c-4edf-aae2-8c8143a9eec7",
  "message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "I'll help you..." }]
  }
}
```

#### session:updated

Broadcast when session metadata changes.

```json
{
  "type": "session:updated",
  "sessionId": "f71a7e8f-269c-4edf-aae2-8c8143a9eec7",
  "changes": {
    "name": "New name"
  }
}
```

#### session:ended

Broadcast when a query completes or is interrupted.

```json
{
  "type": "session:ended",
  "sessionId": "f71a7e8f-269c-4edf-aae2-8c8143a9eec7",
  "reason": "completed"
}
```

Reasons: `"completed"` | `"interrupted"`

#### attention:requested

Broadcast when a session needs user attention.

```json
{
  "type": "attention:requested",
  "attention": {
    "id": "attn-uuid",
    "sessionId": "session-uuid",
    "type": "permission",
    "toolName": "Edit",
    "toolInput": { "file_path": "..." },
    "timestamp": "2026-01-21T10:00:00.000Z"
  }
}
```

#### attention:resolved

Broadcast when an attention request is resolved.

```json
{
  "type": "attention:resolved",
  "attentionId": "attn-uuid"
}
```

#### interaction:resolved

Broadcast when a permission interaction is resolved (for transcript history).

```json
{
  "type": "interaction:resolved",
  "sessionId": "session-uuid",
  "interaction": {
    "type": "permission",
    "toolName": "Edit",
    "toolInput": { "file_path": "..." },
    "resolution": "allow",
    "message": "Looks good",
    "resolvedAt": "2026-01-21T10:00:00.000Z"
  }
}
```

---

## Session Creation Flow

```
Client                           Claudekeeper                    Claude SDK
  |                                   |                               |
  |-- POST /sessions --------------->|                               |
  |   { workdir, prompt }            |                               |
  |                                   |-- query(prompt) ------------>|
  |<-- { tempId } -------------------|                               |
  |                                   |                               |
  |   [Client creates local          |                               |
  |    pending session with tempId]  |                               |
  |                                   |                               |
  |                                   |<-- first message ------------|
  |                                   |    { sessionId: "real-uuid" }|
  |                                   |                               |
  |<-- session:created --------------|                               |
  |    { session, tempId }           |                               |
  |                                   |                               |
  |   [Client matches by tempId,     |                               |
  |    replaces pending with real]   |                               |
  |                                   |                               |
  |<-- session:message --------------|<-- messages -----------------|
  |    { sessionId, message }        |                               |
```

---

## Data Storage

### Claude Code Sessions

Sessions are stored by Claude Code in:
```
~/.claude/projects/<workdir-path>/<session-uuid>.jsonl
```

Where `<workdir-path>` is the project path with `/` replaced by `-` (e.g., `/home/user/project` becomes `-home-user-project`).

### Claudekeeper Metadata

Additional metadata is stored in:
```
~/.claudekeeper/sessions/<session-uuid>/meta.json
~/.claudekeeper/sessions/<session-uuid>/interactions.jsonl
```

---

## Client Libraries

- **Clarvis** - Web UI client for Claudekeeper
