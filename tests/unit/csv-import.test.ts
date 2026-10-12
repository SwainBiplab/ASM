import { describe, expect, it } from 'vitest'
import { decodeCsv, parseCsv } from '../../src/main/import/csv'
import { autoMapHeaders, parseImportDate } from '../../src/main/import/employeeImport'
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from '../../src/shared/organization'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const parse = (s: string) => parseCsv(decodeCsv(enc(s)))

describe('CSV parsing', () => {
  it('handles quoted fields, embedded delimiters, escaped quotes and embedded newlines', () => {
    const r = parse('Employee ID,Full name,Notes\nE1,"Rao, Priya","She said ""hi"""\nE2,"Multi\nLine",x\n')
    expect(r.headers).toEqual(['Employee ID', 'Full name', 'Notes'])
    expect(r.rows[0]!.cells).toEqual(['E1', 'Rao, Priya', 'She said "hi"'])
    expect(r.rows[1]!.cells).toEqual(['E2', 'Multi\nLine', 'x'])
  })

  it('parses CRLF, LF, CR and mixed line endings identically', () => {
    const expected = parse('a,b\n1,2\n3,4\n').rows.map((r) => r.cells)
    for (const text of ['a,b\r\n1,2\r\n3,4\r\n', 'a,b\r1,2\r3,4', 'a,b\r\n1,2\n3,4\r']) {
      expect(parse(text).rows.map((r) => r.cells)).toEqual(expected)
    }
  })

  it('strips a UTF-8 BOM and keeps non-ASCII names', () => {
    const r = parse('﻿Employee ID,Full name\nE1,Zoë Müller\nE2,अनिल कुमार\n')
    expect(r.headers[0]).toBe('Employee ID')
    expect(r.rows.map((x) => x.cells[1])).toEqual(['Zoë Müller', 'अनिल कुमार'])
  })

  it('detects semicolon-delimited files', () => {
    const r = parse('Employee ID;Full name\nE1;"Rao; Priya"\n')
    expect(r.delimiter).toBe(';')
    expect(r.rows[0]!.cells).toEqual(['E1', 'Rao; Priya'])
  })

  it('skips blank lines but keeps spreadsheet row numbers', () => {
    const r = parse('a,b\n1,2\n\n , \n3,4\n')
    expect(r.blankRows).toBe(2)
    expect(r.rows.map((x) => x.rowNumber)).toEqual([2, 5])
  })

  it('keeps rows with the wrong number of columns for row-level reporting', () => {
    const r = parse('a,b,c\n1,2\n1,2,3,4\n')
    expect(r.rows.map((x) => x.cells.length)).toEqual([2, 4])
  })

  it.each([
    ['empty file', new Uint8Array(), /empty/],
    ['whitespace only', enc('  \n \n'), /empty/],
    ['invalid UTF-8', new Uint8Array([0x45, 0x31, 0x2c, 0xff, 0xfe, 0x41]), /not valid UTF-8/],
    ['UTF-16', new Uint8Array([0xff, 0xfe, 0x41, 0x00]), /UTF-16/],
    ['Excel workbook', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]), /Excel workbook/],
    ['binary NUL', enc('a,b\n1,\u00002\n'), /binary/],
    ['oversized', new Uint8Array(IMPORT_MAX_BYTES + 1).fill(0x41), /larger than/]
  ])('rejects %s', (_name, data, message) => {
    expect(() => parseCsv(decodeCsv(data))).toThrow(message)
  })

  it('rejects header-only files, unclosed quotes and too many rows', () => {
    expect(() => parse('Employee ID,Full name\n')).toThrow(/no employee rows/)
    expect(() => parse('a,b\n1,"unterminated\n2,3\n')).toThrow(/not valid CSV/)
    const many = 'a\n' + Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `r${i}`).join('\n')
    expect(() => parse(many)).toThrow(/limit/)
  })
})

describe('header auto-mapping', () => {
  it('maps common header names and leaves unknown ones unmapped', () => {
    const m = autoMapHeaders(['Emp_Code', 'Employee Name', 'E-mail', 'Dept', 'Reporting Manager ID', 'DOJ', 'Favourite colour'])
    expect(m).toMatchObject({ employeeCode: 0, fullName: 1, email: 2, department: 3, managerCode: 4, joiningDate: 5, phone: null, team: null })
  })

  it('never maps one column to two fields', () => {
    const m = autoMapHeaders(['Name'])
    expect(Object.values(m).filter((v) => v === 0)).toHaveLength(1)
  })
})

describe('import date parsing', () => {
  it('uses the chosen format and never guesses', () => {
    expect(parseImportDate('2026-03-04', 'YYYY-MM-DD')).toBe('2026-03-04')
    expect(parseImportDate('04/03/2026', 'DD-MM-YYYY')).toBe('2026-03-04')
    expect(parseImportDate('04/03/2026', 'MM-DD-YYYY')).toBe('2026-04-03')
    expect(parseImportDate('4.3.2026', 'DD-MM-YYYY')).toBe('2026-03-04')
  })

  it('rejects impossible or mismatched dates', () => {
    expect(parseImportDate('2026-02-30', 'YYYY-MM-DD')).toBeNull()
    expect(parseImportDate('13/13/2026', 'DD-MM-YYYY')).toBeNull()
    expect(parseImportDate('04/03/26', 'DD-MM-YYYY')).toBeNull()
    expect(parseImportDate('45210', 'YYYY-MM-DD')).toBeNull()
    expect(parseImportDate('2026-03-04', 'DD-MM-YYYY')).toBeNull()
  })
})
