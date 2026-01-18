# Claudekeeper Development Guide

## Architecture

Claudekeeper is a session coordinator service that:
1. Manages Claude Code sessions via the Agent SDK
2. Surfaces attention needs (permissions, questions, errors)
3. Routes user responses back to sessions
4. Provides REST API + WebSocket for clients

## Key Files

- `src/types.ts` - Shared type definitions
- `src/state.ts` - State persistence to ~/.claudekeeper/
- `src/attention.ts` - Attention queue management
- `src/sessions.ts` - Session lifecycle and SDK interaction
- `src/server.ts` - HTTP server with REST routes and WebSocket
- `src/index.ts` - CLI entry point

## Data Flow

1. Client creates session via POST /sessions
2. Server spawns SDK query, streams messages via WebSocket
3. SDK permission callback creates attention request
4. Client receives attention:requested event
5. Client resolves via POST /attention/:id/resolve
6. SDK callback receives resolution, continues

## Design Principles

- Fail fast: surface errors as attention requests, no auto-retry
- Loose coupling: coordinator doesn't know about Clarvis/Pluribus
- SDK-native: work within SDK capabilities, don't fight them
- Minimal state: coordinator state file + SDK session storage

## Building

```bash
npm install
npm run build  # tsc
npm start      # run server
```

## Testing

Manual testing for now. Start server, use curl or a client to test endpoints.
