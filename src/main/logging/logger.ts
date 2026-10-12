import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  correlationId?: string
  [key: string]: unknown
}

export interface Logger {
  debug(subsystem: string, message: string, context?: LogContext): void
  info(subsystem: string, message: string, context?: LogContext): void
  warn(subsystem: string, message: string, context?: LogContext): void
  error(subsystem: string, message: string, context?: LogContext): void
}

const SENSITIVE_KEY = /pass(word)?|secret|token|hash|credential/i

/** Redacts secrets before anything reaches disk (TAS §14). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]'
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)
    }
    return out
  }
  return value
}

/** Structured JSON-lines logger writing one file per UTC day. */
export function createFileLogger(logsDir: string, opts: { echo?: boolean } = {}): Logger {
  mkdirSync(logsDir, { recursive: true })
  const write = (level: LogLevel, subsystem: string, message: string, context?: LogContext): void => {
    const ts = new Date().toISOString()
    const entry = JSON.stringify({ ts, level, subsystem, message, ...(redact(context ?? {}) as object) })
    try {
      appendFileSync(join(logsDir, `app-${ts.slice(0, 10)}.log`), entry + '\n', 'utf8')
    } catch {
      // Logging must never crash the application.
    }
    if (opts.echo) (level === 'error' ? console.error : console.log)(entry)
  }
  return {
    debug: (s, m, c) => write('debug', s, m, c),
    info: (s, m, c) => write('info', s, m, c),
    warn: (s, m, c) => write('warn', s, m, c),
    error: (s, m, c) => write('error', s, m, c)
  }
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }
