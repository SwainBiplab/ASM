import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * Password hashing with scrypt (memory-hard, built into Node — no native dependency).
 * Format: scrypt$N$r$p$<salt b64>$<hash b64>. Parameters are stored per hash so the
 * work factor can be raised later without invalidating existing passwords.
 */
const DEFAULT_PARAMS = { N: 2 ** 15, r: 8, p: 1 }
const KEY_LENGTH = 64
const SALT_BYTES = 16

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

const maxmem = (N: number, r: number): number => 256 * N * r

export async function hashPassword(password: string, params = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...params, maxmem: maxmem(params.N, params.r) })
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string]
  const N = Number(nStr)
  const r = Number(rStr)
  const p = Number(pStr)
  if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N,
    r,
    p,
    maxmem: maxmem(N, r)
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Used for unknown usernames so response timing does not reveal which accounts exist. */
let dummyHash: Promise<string> | null = null
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'))
  return dummyHash
}
