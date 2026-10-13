import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import type { AssetImportPreview, AssetImportSheetChoice, ImportResult, ImportRowStatus } from '@shared/api'
import { ASSET_IMPORT_FIELD_LABELS, ASSET_IMPORT_FIELDS, REQUIRED_ASSET_IMPORT_FIELDS, type AssetImportField } from '@shared/assets'
import { IMPORT_DATE_FORMATS, type ImportDateFormat } from '@shared/organization'
import { call, formatBytes, uploadFile } from '../../api'
import { Alert, Button, ErrorAlert, PageHeader, Panel, SelectField, Tabs } from '../../components/ui'

type Filter = 'problems' | 'all' | ImportRowStatus

const STATUS_LABEL: Record<ImportRowStatus, string> = { accepted: 'Accepted', warning: 'Accepted with warning', rejected: 'Rejected', duplicate: 'Duplicate' }
const STATUS_CLASS: Record<ImportRowStatus, string> = { accepted: 'badge--ok', warning: 'badge--warn', rejected: 'badge--off', duplicate: 'badge--off' }
const ROWS_SHOWN = 300

function isSheetChoice(p: AssetImportPreview | AssetImportSheetChoice): p is AssetImportSheetChoice {
  return 'needsSheetSelection' in p
}

/**
 * CSV/Excel import wizard for individually tracked assets: choose file (and sheet, for a
 * multi-sheet workbook) → map columns and review every row → import or cancel. Nothing is written
 * to the asset register until "Import"; asset codes are always issued by the server, never read
 * from the file.
 */
export function AssetImport({ onDone }: { onDone: (message?: string) => void }) {
  const [preview, setPreview] = useState<AssetImportPreview | null>(null)
  const [sheetChoice, setSheetChoice] = useState<{ file: File; sheets: string[] } | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>('problems')
  const [skipInvalid, setSkipInvalid] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const fileInput = useRef<HTMLInputElement>(null)
  const choose = () => fileInput.current?.click()

  const upload = async (file: File, sheet?: string) => {
    if (preview) await call('assets.importCancel', { importId: preview.importId }).catch(() => undefined)
    setPreview(null)
    setSheetChoice(null)
    const p = await uploadFile<AssetImportPreview | AssetImportSheetChoice>('/api/v1/uploads/asset-import', file, sheet ? { sheet } : {})
    if (isSheetChoice(p)) {
      setSheetChoice({ file, sheets: p.sheets })
      return
    }
    setPreview(p)
    setSkipInvalid(false)
    setFilter(p.counts.rejected > 0 ? 'problems' : 'all')
  }

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    void run(() => upload(file))
  }

  const chooseSheet = (sheet: string) => sheetChoice && run(() => upload(sheetChoice.file, sheet))

  const remap = (mapping: AssetImportPreview['mapping'], dateFormat: ImportDateFormat) =>
    preview && run(async () => setPreview(await call('assets.importPreview', { importId: preview.importId, mapping, dateFormat })))

  const commit = () =>
    preview && run(async () => setResult(await call('assets.importCommit', { importId: preview.importId, mapping: preview.mapping, dateFormat: preview.dateFormat, skipInvalidRows: skipInvalid })))

  const cancel = async () => {
    if (preview) await call('assets.importCancel', { importId: preview.importId }).catch(() => undefined)
    onDone()
  }

  const rows = useMemo(() => {
    if (!preview) return []
    return preview.rows.filter((r) => (filter === 'all' ? true : filter === 'problems' ? r.status !== 'accepted' : r.status === filter))
  }, [preview, filter])

  const step = result ? 3 : preview ? 2 : 1
  const blocked = preview ? preview.counts.rejected : 0
  const canCommit = preview !== null && preview.fileIssues.length === 0 && preview.counts.accepted > 0 && (blocked === 0 || skipInvalid)

  return (
    <div className="stack">
      <PageHeader
        title="Import assets from CSV or Excel"
        description="Every row is checked before anything is saved. Individually tracked categories only; the import either saves all accepted rows or nothing. Asset codes are always issued by the system, never read from the file."
        actions={<Button onClick={() => void cancel()}>{result ? 'Back to assets' : 'Cancel import'}</Button>}
      />
      <ol className="steps" aria-label="Import progress">
        {['Choose file', 'Map and review', 'Done'].map((label, i) => (
          <li key={label} aria-current={step === i + 1 ? 'step' : undefined}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>
      <ErrorAlert error={error} />

      {result ? (
        <Panel title="Import complete">
          <div className="stack">
            <Alert tone="success">
              {result.imported} asset{result.imported === 1 ? '' : 's'} imported.{result.skipped ? ` ${result.skipped} row(s) were skipped as you chose.` : ''}
            </Alert>
            <div className="chips">
              <Button variant="primary" onClick={() => onDone(`${result.imported} assets imported.`)}>View assets</Button>
              <Button onClick={() => { setResult(null); setPreview(null) }}>Import another file</Button>
            </div>
          </div>
        </Panel>
      ) : null}

      <input ref={fileInput} type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden aria-label="CSV or Excel file" data-testid="import-file" onChange={onFile} />

      {!result && !preview && !sheetChoice ? (
        <Panel title="Choose a CSV or Excel file">
          <div className="stack">
            <p className="muted">
              A UTF-8 CSV, or an .xlsx workbook (one sheet per import). Only the Category column is required; category, location and supplier must
              already exist, by name or code. Serial number is required only where the category requires one. Limit: 10,000 rows or 5 MB per file.
            </p>
            <div><Button variant="primary" disabled={busy} onClick={() => void choose()}>{busy ? 'Reading…' : 'Choose file'}</Button></div>
          </div>
        </Panel>
      ) : null}

      {!result && sheetChoice ? (
        <Panel title={`${sheetChoice.file.name}: choose a sheet`}>
          <div className="stack">
            <p className="muted">This workbook has more than one sheet. Each import reads exactly one sheet; run the import again for another sheet.</p>
            <div className="chips">
              {sheetChoice.sheets.map((s) => (
                <Button key={s} disabled={busy} onClick={() => void chooseSheet(s)}>{s}</Button>
              ))}
            </div>
            <div><Button small onClick={() => setSheetChoice(null)}>Choose a different file</Button></div>
          </div>
        </Panel>
      ) : null}

      {!result && preview ? (
        <>
          <Panel title={`${preview.fileName} (${formatBytes(preview.fileBytes)})`} actions={<Button small onClick={() => void choose()}>Choose another file</Button>}>
            <div className="stack">
              <p className="muted">Match each field to a column in your file. Fields left as "Not in file" are left empty.</p>
              <div className="mapping-grid">
                {ASSET_IMPORT_FIELDS.map((f: AssetImportField) => (
                  <SelectField
                    key={f}
                    label={`${ASSET_IMPORT_FIELD_LABELS[f]}${REQUIRED_ASSET_IMPORT_FIELDS.includes(f) ? ' (required)' : ''}`}
                    value={preview.mapping[f] === null ? '' : String(preview.mapping[f])}
                    placeholder="Not in file"
                    disabled={busy}
                    onChange={(v) => void remap({ ...preview.mapping, [f]: v === '' ? null : Number(v) }, preview.dateFormat)}
                    options={preview.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))}
                  />
                ))}
                <SelectField
                  label="Date format in this file"
                  value={preview.dateFormat}
                  disabled={busy}
                  onChange={(v) => void remap(preview.mapping, v as ImportDateFormat)}
                  options={IMPORT_DATE_FORMATS.map((d) => ({ value: d, label: d }))}
                  hint="Dates are never guessed for a CSV; an Excel date cell is always exact"
                />
              </div>
              {preview.fileIssues.length ? (
                <Alert tone="error">
                  <ul className="issue-list">{preview.fileIssues.map((i) => <li key={i}>{i}</li>)}</ul>
                </Alert>
              ) : null}
            </div>
          </Panel>

          {preview.fileIssues.length === 0 ? (
            <>
              <div className="counts" aria-label="Import summary">
                <div><strong>{preview.counts.totalRows}</strong><span>Rows in file</span></div>
                <div className="is-good"><strong>{preview.counts.accepted}</strong><span>Accepted{preview.counts.withWarnings ? ` (${preview.counts.withWarnings} with warnings)` : ''}</span></div>
                <div className={preview.counts.rejected ? 'is-bad' : ''}><strong>{preview.counts.rejected}</strong><span>Rejected</span></div>
                <div><strong>{preview.counts.blankRowsSkipped}</strong><span>Blank rows skipped</span></div>
              </div>

              <Panel flush title="Row review">
                <div className="toolbar">
                  <Tabs
                    label="Row filter"
                    value={filter}
                    onChange={setFilter}
                    tabs={[
                      { id: 'problems', label: `Needs attention (${preview.counts.rejected + preview.counts.withWarnings})` },
                      { id: 'all', label: `All rows (${preview.counts.totalRows})` },
                      { id: 'accepted', label: 'Accepted' },
                      { id: 'rejected', label: 'Rejected' }
                    ]}
                  />
                </div>
                <div className="table-wrap">
                  <table className="grid">
                    <thead><tr><th className="num">Row</th><th>Status</th><th>Category</th><th>Manufacturer / Model</th><th>Serial</th><th>What to fix</th></tr></thead>
                    <tbody>
                      {rows.slice(0, ROWS_SHOWN).map((r) => (
                        <tr key={r.rowNumber}>
                          <td className="num">{r.rowNumber}</td>
                          <td><span className={`badge ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span></td>
                          <td className="ident">{r.values.category || '—'}</td>
                          <td>{[r.values.manufacturer, r.values.modelName].filter(Boolean).join(' / ') || '—'}</td>
                          <td>{r.values.serialNumber || '—'}</td>
                          <td>
                            {r.issues.length === 0 ? <span className="faint">Ready</span> : (
                              <ul className="issue-list">
                                {r.issues.map((i, idx) => (
                                  <li key={idx} className={`issue--${i.severity}`}>
                                    {i.field ? <strong>{ASSET_IMPORT_FIELD_LABELS[i.field]}: </strong> : null}
                                    {i.message}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length === 0 ? <div className="empty">No rows in this view.</div> : null}
                  {rows.length > ROWS_SHOWN ? <div className="empty">Showing the first {ROWS_SHOWN} of {rows.length} rows in this view.</div> : null}
                </div>
              </Panel>

              <Panel title="Import">
                <div className="stack">
                  {blocked > 0 ? (
                    <>
                      <Alert tone="warn">
                        {blocked} row(s) cannot be imported. Correct them in your file and choose it again, or skip them and import only the {preview.counts.accepted} accepted row(s).
                      </Alert>
                      <label className="checkbox">
                        <input type="checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />
                        Skip the {blocked} rejected row(s)
                      </label>
                    </>
                  ) : (
                    <p className="muted">All {preview.counts.accepted} row(s) passed validation.</p>
                  )}
                  <div className="chips">
                    <Button variant="primary" disabled={!canCommit || busy} onClick={() => void commit()}>
                      {busy ? 'Importing…' : `Import ${preview.counts.accepted} asset${preview.counts.accepted === 1 ? '' : 's'}`}
                    </Button>
                    <Button onClick={() => void cancel()}>Cancel import</Button>
                  </div>
                </div>
              </Panel>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
