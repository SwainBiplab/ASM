import { describe, expect, it } from 'vitest'
import { formatAssetCode, formatMinor, parseMoneyToMinor, parseQrPayload, qrPayloadFor, LIFECYCLE_TRANSITIONS } from '../../src/shared/assets'
import { toCsv } from '../../src/main/import/csvExport'

describe('asset codes', () => {
  it('formats the default AST-000001 style and never truncates', () => {
    expect(formatAssetCode({ prefix: 'AST', separator: '-', padding: 6 }, 1)).toBe('AST-000001')
    expect(formatAssetCode({ prefix: 'BPO', separator: '', padding: 4 }, 42)).toBe('BPO0042')
    expect(formatAssetCode({ prefix: 'AST', separator: '-', padding: 6 }, 1234567)).toBe('AST-1234567')
  })
})

describe('QR payload', () => {
  const id = '6f1c2b9e-1111-4222-8333-444455556666'
  it('round-trips and rejects anything else', () => {
    expect(parseQrPayload(qrPayloadFor(id))).toBe(id)
    expect(parseQrPayload(` bpoam:asset:${id.toUpperCase()} `)).toBe(id)
    expect(parseQrPayload('BPOAM:ASSET:../../etc')).toBeNull()
    expect(parseQrPayload('AST-000001')).toBeNull()
  })
})

describe('money in minor units', () => {
  it('parses without floating point and respects currency precision', () => {
    expect(parseMoneyToMinor('45,000.50', 'INR')).toBe(4500050)
    expect(parseMoneyToMinor('0.1', 'INR')).toBe(10)
    expect(parseMoneyToMinor('1.234', 'INR')).toBeNull()
    expect(parseMoneyToMinor('-5', 'INR')).toBeNull()
    expect(parseMoneyToMinor('1e5', 'INR')).toBeNull()
    expect(parseMoneyToMinor('1500', 'JPY')).toBe(1500)
    expect(parseMoneyToMinor('1.5', 'JPY')).toBeNull()
  })

  it('formats with Indian grouping for INR', () => {
    expect(formatMinor(12345678, 'INR')).toBe('INR 1,23,456.78')
    expect(formatMinor(null, 'INR')).toBe('—')
  })
})

describe('lifecycle rules', () => {
  it('makes disposal final and requires the dispose permission for it', () => {
    expect(LIFECYCLE_TRANSITIONS.disposed).toEqual({})
    expect(LIFECYCLE_TRANSITIONS.retired.disposed?.permission).toBe('assets.dispose')
    expect(LIFECYCLE_TRANSITIONS.active.disposed).toBeUndefined()
  })
})

describe('CSV export writer', () => {
  it('quotes every cell and neutralizes spreadsheet formulas', () => {
    const csv = toCsv(['Code', 'Note'], [['AST-1', '=HYPERLINK("x")'], ['AST-2', 'a "quoted", value'], ['AST-3', null], ['AST-4', '-5'], ['AST-5', 1200]])
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain(`"AST-1","'=HYPERLINK(""x"")"`)
    expect(csv).toContain('"AST-2","a ""quoted"", value"')
    expect(csv).toContain('"AST-3",""')
    expect(csv).toContain(`"AST-4","'-5"`)
    expect(csv).toContain('"AST-5","1200"')
  })
})
