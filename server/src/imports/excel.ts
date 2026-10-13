import readXlsxFile from 'read-excel-file/node'
import { IMPORT_MAX_ROWS } from '@shared/organization'
import { AppError } from '../core'
import type { ParsedCsv } from './csv'

const fail = (message: string): never => {
  throw new AppError('VALIDATION_ERROR', message)
}

/** PK\x03\x04 is the zip local-file-header signature every .xlsx starts with. */
export function isExcelFile(data: Uint8Array): boolean {
  return data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04
}

/** A cell as read-excel-file returns it: a real type (string/number/boolean/Date), never guessed from text. */
type Cell = string | number | boolean | Date | null

/** Dates are real Excel dates here (no DD/MM vs MM/DD ambiguity); everything else becomes plain text. */
function cellToText(v: Cell): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v)
}

function toParsedTable(rows: Cell[][]): ParsedCsv {
  const headerIndex = rows.findIndex((r) => r.some((c) => cellToText(c).trim() !== ''))
  if (headerIndex === -1) fail('The sheet has no header row.')
  const headers = rows[headerIndex]!.map((c) => cellToText(c).trim())

  const out: ParsedCsv['rows'] = []
  let blankRows = 0
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const cells = rows[i]!.map(cellToText)
    if (cells.every((c) => c.trim() === '')) {
      blankRows++
      continue
    }
    out.push({ rowNumber: i + 1, cells })
  }
  if (out.length === 0) fail('The sheet has a header row but no data rows.')
  if (out.length > IMPORT_MAX_ROWS) fail(`The sheet has ${out.length} rows; the limit is ${IMPORT_MAX_ROWS}. Split it into smaller files.`)
  return { delimiter: ',', headers, rows: out, blankRows }
}

export type ExcelResult = { kind: 'choose'; sheets: string[] } | { kind: 'parsed'; table: ParsedCsv }

/**
 * Reads every sheet once (read-excel-file has no cheaper "names only" mode). A single-sheet
 * workbook is parsed immediately; a multi-sheet workbook with no `sheet` chosen yet asks the
 * caller to choose one before anything is stored as an import session.
 */
export async function readExcelWorkbook(data: Buffer, sheet: string | null): Promise<ExcelResult> {
  let sheets: Array<{ sheet: string; data: Cell[][] }>
  try {
    // The library's own types declare cell values with `typeof Date` instead of `Date` (an upstream
    // typing quirk); the runtime values are real Date instances, so this cast is to our own exact shape.
    sheets = (await readXlsxFile(data)) as unknown as Array<{ sheet: string; data: Cell[][] }>
  } catch {
    return fail('This file could not be read as an Excel workbook. Make sure it is a valid, uncorrupted .xlsx file.')
  }
  if (sheets.length === 0) fail('The workbook has no sheets.')
  if (sheets.length === 1) return { kind: 'parsed', table: toParsedTable(sheets[0]!.data) }
  if (!sheet) return { kind: 'choose', sheets: sheets.map((s) => s.sheet) }
  const chosen = sheets.find((s) => s.sheet === sheet)
  if (!chosen) return fail(`Sheet "${sheet}" was not found in this workbook.`)
  return { kind: 'parsed', table: toParsedTable(chosen.data) }
}
