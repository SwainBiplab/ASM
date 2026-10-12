import { useMemo, useState } from 'react'
import type { ImportPreview, ImportResult, ImportRowStatus } from '@shared/api'
import { IMPORT_DATE_FORMATS, IMPORT_FIELD_LABELS, IMPORT_FIELDS, REQUIRED_IMPORT_FIELDS, type ImportDateFormat, type ImportField } from '@shared/organization'
import { call, formatBytes } from '../../api'
import { Alert, Button, ErrorAlert, PageHeader, Panel, SelectField, Tabs } from '../../components/ui'

type Filter = 'problems' | 'all' | ImportRowStatus

const STATUS_LABEL: Record<ImportRowStatus, string> = { accepted: 'Accepted', warning: 'Accepted with warning', rejected: 'Rejected', duplicate: 'Duplicate' }
const STATUS_CLASS: Record<ImportRowStatus, string> = { accepted: 'badge--ok', warning: 'badge--warn', rejected: 'badge--off', duplicate: 'badge--off' }
const ROWS_SHOWN = 300

/**
 * CSV import wizard: choose file → map columns and review every row → import or cancel.
 * Nothing is written until "Import"; the main process re-validates everything at that point.
 */
export function EmployeeImport({ onDone }: { onDone: (message?: string) => void }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null)
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

  const choose = () =>
    run(async () => {
      if (preview) await call('employees.importCancel', { importId: preview.importId }).catch(() => undefined)
      const p = await call('employees.importSelectFile')
      if (p) {
        setPreview(p)
        setSkipInvalid(false)
        setFilter(p.counts.rejected + p.counts.duplicates > 0 ? 'problems' : 'all')
      }
    })

  const remap = (mapping: ImportPreview['mapping'], dateFormat: ImportDateFormat) =>
    preview && run(async () => setPreview(await call('employees.importPreview', { importId: preview.importId, mapping, dateFormat })))

  const commit = () =>
    preview && run(async () => setResult(await call('employees.importCommit', { importId: preview.importId, mapping: preview.mapping, dateFormat: preview.dateFormat, skipInvalidRows: skipInvalid })))

  const cancel = async () => {
    if (preview) await call('employees.importCancel', { importId: preview.importId }).catch(() => undefined)
    onDone()
  }

  const rows = useMemo(() => {
    if (!preview) return []
    return preview.rows.filter((r) => (filter === 'all' ? true : filter === 'problems' ? r.status !== 'accepted' : r.status === filter))
  }, [preview, filter])

  const step = result ? 3 : preview ? 2 : 1
  const blocked = preview ? preview.counts.rejected + preview.counts.duplicates : 0
  const canCommit = preview !== null && preview.fileIssues.length === 0 && preview.counts.accepted > 0 && (blocked === 0 || skipInvalid)

  return (
    <div className="stack">
      <PageHeader
        title="Import employees from CSV"
        description="Every row is checked before anything is saved. Existing employees are never overwritten, and the import either saves all accepted rows or nothing."
        actions={<Button onClick={() => void cancel()}>{result ? 'Back to employees' : 'Cancel import'}</Button>}
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
              {result.imported} employee{result.imported === 1 ? '' : 's'} imported.{result.skipped ? ` ${result.skipped} row(s) were skipped as you chose.` : ''}
            </Alert>
            <div className="chips">
              <Button variant="primary" onClick={() => onDone(`${result.imported} employees imported from CSV.`)}>View employees</Button>
              <Button onClick={() => { setResult(null); setPreview(null) }}>Import another file</Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {!result && !preview ? (
        <Panel title="Choose a CSV file">
          <div className="stack">
            <p className="muted">
              Use a UTF-8 CSV with a header row. In Excel: File, Save As, "CSV UTF-8 (Comma delimited)". Required columns are Employee ID and full name.
              Department, team and location must already exist; they can be given by name or code. Limit: 10,000 rows or 5 MB per file.
            </p>
            <div><Button variant="primary" disabled={busy} onClick={() => void choose()}>{busy ? 'Reading…' : 'Choose CSV file'}</Button></div>
          </div>
        </Panel>
      ) : null}

      {!result && preview ? (
        <>
          <Panel title={`${preview.fileName} (${formatBytes(preview.fileBytes)})`} actions={<Button small onClick={() => void choose()}>Choose another file</Button>}>
            <div className="stack">
              <p className="muted">Match each field to a column in your file. Fields left as "Not in file" are left empty.</p>
              <div className="mapping-grid">
                {IMPORT_FIELDS.map((f: ImportField) => (
                  <SelectField
                    key={f}
                    label={`${IMPORT_FIELD_LABELS[f]}${REQUIRED_IMPORT_FIELDS.includes(f) ? ' (required)' : ''}`}
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
                  hint="Dates are never guessed"
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
                <div className={preview.counts.duplicates ? 'is-bad' : ''}><strong>{preview.counts.duplicates}</strong><span>Duplicates</span></div>
                <div><strong>{preview.counts.blankRowsSkipped}</strong><span>Blank rows skipped</span></div>
              </div>

              <Panel flush title="Row review">
                <div className="toolbar">
                  <Tabs
                    label="Row filter"
                    value={filter}
                    onChange={setFilter}
                    tabs={[
                      { id: 'problems', label: `Needs attention (${preview.counts.rejected + preview.counts.duplicates + preview.counts.withWarnings})` },
                      { id: 'all', label: `All rows (${preview.counts.totalRows})` },
                      { id: 'accepted', label: 'Accepted' },
                      { id: 'rejected', label: 'Rejected' },
                      { id: 'duplicate', label: 'Duplicates' }
                    ]}
                  />
                </div>
                <div className="table-wrap">
                  <table className="grid">
                    <thead><tr><th className="num">Row</th><th>Status</th><th>Employee ID</th><th>Name</th><th>Department / team</th><th>What to fix</th></tr></thead>
                    <tbody>
                      {rows.slice(0, ROWS_SHOWN).map((r) => (
                        <tr key={r.rowNumber}>
                          <td className="num">{r.rowNumber}</td>
                          <td><span className={`badge ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span></td>
                          <td className="ident">{r.values.employeeCode || '—'}</td>
                          <td>{r.values.fullName || '—'}</td>
                          <td>{[r.values.department, r.values.team].filter(Boolean).join(' / ') || '—'}</td>
                          <td>
                            {r.issues.length === 0 ? <span className="faint">Ready</span> : (
                              <ul className="issue-list">
                                {r.issues.map((i, idx) => (
                                  <li key={idx} className={`issue--${i.severity}`}>
                                    {i.field ? <strong>{IMPORT_FIELD_LABELS[i.field]}: </strong> : null}
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
                        Skip the {blocked} rejected and duplicate row(s)
                      </label>
                    </>
                  ) : (
                    <p className="muted">All {preview.counts.accepted} row(s) passed validation.</p>
                  )}
                  <div className="chips">
                    <Button variant="primary" disabled={!canCommit || busy} onClick={() => void commit()}>
                      {busy ? 'Importing…' : `Import ${preview.counts.accepted} employee${preview.counts.accepted === 1 ? '' : 's'}`}
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
