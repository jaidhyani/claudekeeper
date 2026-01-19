import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { Config } from './types.js'

const STATE_DIR = join(homedir(), '.claudekeeper')
const CONFIG_FILE = join(STATE_DIR, 'config.json')

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true })
  }
}

function defaultConfig(): Config {
  return {
    port: 3100,
    token: randomBytes(16).toString('hex')
  }
}

export function loadConfig(): Config {
  ensureDir()

  if (!existsSync(CONFIG_FILE)) {
    const config = defaultConfig()
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
    return config
  }

  const raw = readFileSync(CONFIG_FILE, 'utf-8')
  return JSON.parse(raw) as Config
}
