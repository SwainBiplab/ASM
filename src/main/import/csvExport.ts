/**
 * CSV writer for exports. Every cell is quoted, and cells that a spreadsheet would treat as
 * a formula (= + - @ TAB CR) are prefixed with an apostrophe (formula-injection protection).
 * Output starts with a UTF-8 BOM so Excel detects the encoding.
 */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  const cell = (v: string | number | null): string => {
    if (v === null || v === undefined) return '""'
    let s = String(v)
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return `"${s.replace(/"/g, '""')}"`
  }
  return '﻿' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}
