import 'dotenv/config'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type AppConfig = {
  todoist: {
    apiToken: string
    /** Todoist label that routes to the Reminders calendar. */
    reminderLabel: string
    /** Todoist label that excludes the task from all Google calendars. */
    noCalendarLabel: string
  }
  google: {
    clientId: string
    clientSecret: string
    refreshToken: string | null
    redirectUri: string
  }
  daemon: {
    pollIntervalMs: number
    databasePath: string
    logLevel: LogLevel
  }
  calendars: {
    reminders: string
    tasks: string
    managedPrefix: string
  }
}

class ConfigError extends Error {
  override name = 'ConfigError'
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v || v.trim() === '') {
    throw new ConfigError(`Missing required environment variable: ${name}`)
  }
  return v.trim()
}

function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name]
  return v && v.trim() !== '' ? v.trim() : fallback
}

function parseLogLevel(raw: string): LogLevel {
  const lower = raw.toLowerCase()
  if (lower === 'debug' || lower === 'info' || lower === 'warn' || lower === 'error') return lower
  throw new ConfigError(`Invalid LOG_LEVEL: ${raw} (expected debug|info|warn|error)`)
}

function parsePositiveInt(name: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got: ${raw}`)
  }
  return n
}

/**
 * Loads and validates the full configuration. Throws ConfigError on bad/missing values.
 * Refresh token is intentionally optional: the bootstrap flow runs precisely when it is absent.
 */
export function loadConfig(): AppConfig {
  const todoistApiToken = requireEnv('TODOIST_API_TOKEN')
  const googleClientId = requireEnv('GOOGLE_CLIENT_ID')
  const googleClientSecret = requireEnv('GOOGLE_CLIENT_SECRET')

  const refreshTokenRaw = process.env.GOOGLE_REFRESH_TOKEN?.trim()
  const refreshToken = refreshTokenRaw && refreshTokenRaw.length > 0 ? refreshTokenRaw : null

  const redirectUri = optionalEnv('GOOGLE_OAUTH_REDIRECT_URI', 'http://localhost:8765/oauth/callback')

  const pollIntervalSeconds = parsePositiveInt(
    'POLL_INTERVAL_SECONDS',
    optionalEnv('POLL_INTERVAL_SECONDS', '60'),
  )

  const databasePath = path.resolve(optionalEnv('DATABASE_PATH', './data/sync.db'))
  const logLevel = parseLogLevel(optionalEnv('LOG_LEVEL', 'info'))

  return {
    todoist: {
      apiToken: todoistApiToken,
      reminderLabel: optionalEnv('TODOIST_REMINDER_LABEL', 'reminder'),
      noCalendarLabel: optionalEnv('TODOIST_NO_CALENDAR_LABEL', 'no-calendar'),
    },
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      refreshToken,
      redirectUri,
    },
    daemon: {
      pollIntervalMs: pollIntervalSeconds * 1000,
      databasePath,
      logLevel,
    },
    calendars: {
      reminders: optionalEnv('SPECIAL_CALENDAR_REMINDERS', 'Reminders'),
      tasks: optionalEnv('SPECIAL_CALENDAR_TASKS', 'Tasks'),
      managedPrefix: rawEnv('MANAGED_CALENDAR_PREFIX', 'Todoist: '),
    },
  }
}

/**
 * Like {@link optionalEnv} but preserves leading/trailing whitespace and the
 * empty string. Use this for env vars where `"Todoist: "` and `""` are both
 * meaningful values (the latter meaning "no prefix").
 */
function rawEnv(name: string, fallback: string): string {
  const v = process.env[name]
  return v === undefined ? fallback : v
}

export { ConfigError }
