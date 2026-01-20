# Changelog

All notable changes to Claudekeeper will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-01-20

### Fixed
- Removed incorrect reference to non-existent `sessions-index.json` in types.ts

## [0.1.0] - 2026-01-20

Initial release.

### Added
- Session coordinator service using `@anthropic-ai/claude-agent-sdk`
- REST API + WebSocket for real-time session events
- Attention queue for permissions, errors, and completions
- Session metadata storage (names, configs)
- Permission modes: default, acceptEdits, bypassPermissions
- Workdir browser for secure directory/file browsing
- Reads sessions directly from Claude Code's native `.jsonl` storage
