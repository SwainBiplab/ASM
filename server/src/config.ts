import { z } from 'zod'

/**
 * Server configuration from environment variables, validated at boot (fail fast).
 * Secrets come only from the environment / platform secret store, never from the repo.
 */
const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Public origin of the web app, used for the Origin check (CSRF) and cookies. */
  PUBLIC_ORIGIN: z.string().url(),
  /** Absolute session lifetime regardless of activity. */
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  /** Trust X-Forwarded-* from the load balancer (set true behind a proxy). */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Requests per minute per IP for the API, and for login attempts. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(300),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  /** Document storage driver (D35, D47). 'local' is for development/tests only; production requires 's3'. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./var/documents'),
  /** S3-compatible object storage (required when STORAGE_DRIVER=s3). Credentials: least-privilege, bucket-scoped (D47). */
  STORAGE_S3_BUCKET: z.string().min(1).optional(),
  STORAGE_S3_REGION: z.string().min(1).optional(),
  /** Omit for AWS itself; set for a non-AWS S3-compatible endpoint (MinIO, Spaces, B2, …). */
  STORAGE_S3_ENDPOINT: z.string().url().optional(),
  STORAGE_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  STORAGE_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  STORAGE_S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Malware scanning (U3 open): only 'disabled' exists; uploads are stored as not_scanned. */
  DOCUMENT_SCANNING: z.enum(['disabled']).default('disabled'),
  /** Built browser application (`npm run web:build` → web/dist). When set, served same-origin at `/`. */
  WEB_ROOT: z.string().min(1).optional(),
  /**
   * W9.7 safety gate (KNOWN_ISSUES W-44/W-45): offline sync upload commands exist and are tested,
   * but default OFF. W-44 (the fencing-epoch sequence is not restore-safe) is unresolved, and W-45
   * (device trust is attestation-only) has never been formally accepted as a business decision --
   * per the W9.7 brief, uploads stay disabled until those are actually resolved, not merely coded
   * around. Tests turn this on explicitly to exercise the upload path; do not enable in production.
   */
  SYNC_UPLOADS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
})

export type ServerConfig = z.infer<typeof schema> & {
  /** Secure cookies (HTTPS). Always true outside development/test over plain HTTP. */
  secureCookies: boolean
  cookieName: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid server configuration: ${problems}`)
  }
  const c = parsed.data
  const https = c.PUBLIC_ORIGIN.startsWith('https://')
  if (c.APP_ENV === 'production' && !https) throw new Error('PUBLIC_ORIGIN must use https in production')
  // TAS 7.1: production must not keep documents on an ephemeral container disk.
  if (c.APP_ENV === 'production' && c.STORAGE_DRIVER === 'local') throw new Error('STORAGE_DRIVER=local is not allowed in production; configure S3-compatible storage')
  if (c.STORAGE_DRIVER === 's3' && (!c.STORAGE_S3_BUCKET || !c.STORAGE_S3_REGION || !c.STORAGE_S3_ACCESS_KEY_ID || !c.STORAGE_S3_SECRET_ACCESS_KEY)) {
    throw new Error('STORAGE_DRIVER=s3 requires STORAGE_S3_BUCKET, STORAGE_S3_REGION, STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY')
  }
  return {
    ...c,
    secureCookies: https,
    // The __Host- prefix requires Secure; plain-HTTP development uses an unprefixed name.
    cookieName: https ? '__Host-bpoam_sid' : 'bpoam_sid'
  }
}
