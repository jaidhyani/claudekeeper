#!/usr/bin/env node

import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { loadConfig } from './state.js'
import { Server } from './server.js'

const PID_FILE = join(homedir(), '.claudekeeper', 'claudekeeper.pid')

function printUsage(): void {
  console.log(`
claudekeeper - Session coordinator for Claude Code

Usage:
  claudekeeper [options]
  claudekeeper stop
  claudekeeper status

Options:
  --daemon    Run in background mode

Commands:
  stop        Stop a running daemon
  status      Show server status
`)
}

function writePid(): void {
  writeFileSync(PID_FILE, process.pid.toString())
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
  return isNaN(pid) ? null : pid
}

function removePid(): void {
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE)
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function stopDaemon(): void {
  const pid = readPid()
  if (!pid) {
    console.log('No daemon running')
    return
  }
  if (!isProcessRunning(pid)) {
    console.log('Daemon not running, cleaning up stale PID file')
    removePid()
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`Stopped daemon (PID ${pid})`)
    removePid()
  } catch (err) {
    console.error('Failed to stop daemon:', err)
  }
}

function showStatus(): void {
  const pid = readPid()
  if (!pid) {
    console.log('Status: not running')
    return
  }
  if (isProcessRunning(pid)) {
    console.log(`Status: running (PID ${pid})`)
  } else {
    console.log('Status: not running (stale PID file)')
    removePid()
  }
}

function startServer(daemon: boolean): void {
  const existingPid = readPid()
  if (existingPid && isProcessRunning(existingPid)) {
    console.error(`Server already running (PID ${existingPid})`)
    process.exit(1)
  }

  const config = loadConfig()

  if (daemon) {
    const { spawn } = require('child_process')
    const child = spawn(process.argv[0], [process.argv[1]], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    console.log(`Started daemon (PID ${child.pid})`)
    return
  }

  const server = new Server(config)

  writePid()

  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...')
    server.stop()
    removePid()
    process.exit(0)
  })

  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down...')
    server.stop()
    removePid()
    process.exit(0)
  })

  server.start()
}

function main(): void {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  const command = args[0]

  if (command === 'stop') {
    stopDaemon()
    return
  }

  if (command === 'status') {
    showStatus()
    return
  }

  const daemon = args.includes('--daemon')
  startServer(daemon)
}

main()
