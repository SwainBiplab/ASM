import { parse } from 'csv-parse/sync'
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from '@shared/organization'
import { AppError } from '../app/errors'

export interface ParsedCsv {
  delimiter: ',' | ';'
  headers: string[]
  /** Data rows; `rowNumber` counts the header as row 1 (matches spreadsheet row numbers). */
  rows: Array<{ rowNumber: number; cells: string[] }>
  blankRows: number
}

const fail = (message: string): never => {
  throw new AppError('VALIDATION_ERROR', message)
}

/**
 * Decodes an uploaded CSV strictly as UTF-8 (BOM optional). Rejects empty, oversized,
 * binary, UTF-16 and invalid-UTF-8 files with actionable messages rather than guessing.
 */
export function decodeCsv(data: Uint8Array): string {
  if (data.byteLength === 0) fail('The file is empty.')
  if (data.byteLength > IMPORT_MAX_BYTES) {
    fail(`The file is larger than ${IMPORT_MAX_BYTES / (1024 * 1024)} MB. Split it into smaller files.`)
  }
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    fail('This looks like an Excel workbook, not a CSV file. In Excel use File > Save As > "CSV UTF-8 (Comma delimited)".')
  }
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) {
    fail('The file is saved as UTF-16 (Unicode text). Save it as "CSV UTF-8 (Comma delimited)" and try again.')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data)
  } catch {
    return fail('The file is not valid UTF-8 text. In Excel use File > Save As > "CSV UTF-8 (Comma delimited)".')
  }
  if (text.includes('\u0000')) fail('The file contains binary data and cannot be read as CSV.')
  if (text.trim() === '') fail('The file is empty.')
  return text
}

/**
 * Parses CSV text with csv-parse: quoted fields, embedded delimiters/newlines and escaped
 * quotes are supported. Line endings are normalized first so CRLF, LF and CR files (and
 * mixed files) parse identically. Rows with a different column count are kept so the
 * preview can report them per row instead of rejecting the whole file.
 */
export function parseCsv(text: string): ParsedCsv {
  const normalized = text.replace(/\r\n?/g, '\n')
  const firstLine = normalized.slice(0, normalized.indexOf('\n') === -1 ? undefined : normalized.indexOf('\n'))
  const delimiter: ',' | ';' = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ','

  let records: string[][]
  try {
    records = parse(normalized, {
      delimiter,
      record_delimiter: '\n',
      bom: true,
      relax_column_count: true,
      skip_empty_lines: false
    }) as string[][]
  } catch (err) {
    const e = err as { message?: string; lines?: number }
    return fail(`The file is not valid CSV${e.lines ? ` near line ${e.lines}` : ''}: ${e.message ?? 'parse error'}. Check for an unclosed quote.`)
  }

  const headerIndex = records.findIndex((r) => r.some((c) => c.trim() !== ''))
  if (headerIndex === -1) fail('The file has no header row.')
  const headers = records[headerIndex]!.map((h) => h.trim())

  const rows: ParsedCsv['rows'] = []
  let blankRows = 0
  for (let i = headerIndex + 1; i < records.length; i++) {
    const cells = records[i]!
    if (cells.every((c) => c.trim() === '')) {
      blankRows++
      continue
    }
    rows.push({ rowNumber: i + 1, cells })
  }
  if (rows.length === 0) fail('The file has a header row but no employee rows.')
  if (rows.length > IMPORT_MAX_ROWS) fail(`The file has ${rows.length} rows; the limit is ${IMPORT_MAX_ROWS}. Split it into smaller files.`)
  return { delimiter, headers, rows, blankRows }
}
