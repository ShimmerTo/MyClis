import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppConfig } from '../../shared/types'
import { mergeConfig } from './schema'

function configPath(): string {
  return join(app.getPath('userData'), 'clichilds', 'config.json')
}

let cache: AppConfig | null = null

export function loadConfig(): AppConfig {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf-8')) as Partial<AppConfig>
    cache = mergeConfig(raw)
  } catch {
    cache = mergeConfig(null)
  }
  return cache
}

export function saveConfig(cfg: AppConfig): AppConfig {
  const p = configPath()
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8')
  cache = cfg
  return cfg
}
