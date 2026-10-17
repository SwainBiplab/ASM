import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import type { ImportResult, ImportRowStatus, ReferenceImportPreview } from '@shared/api'
import { REFERENCE_IMPORT_FIELDS, REFERENCE_IMPORT_KIND_LABELS, type ReferenceImportKind } from '@shared/referenceImport'
import { call, formatBytes, uploadFile } from '../../api'
import { Alert, Button, ErrorAlert, PageHeader, Panel, SelectField, Tabs } from '../../components/ui'

type Filter = 'problems' | 'all' | ImportRowStatus

const STATUS_LABEL: Record<ImportRowStatus, string> = { accepted: 'Accepted', warning: 'Accepted with warning', rejected: 'Rejected', duplicate: 'Duplicate' }
const STATUS_CLASS: Record<ImportRowStatus, string> = { accepted: 'badge--ok', warning: 'badge--warn', rejected: 'badge--off', duplicate: 'badge--off' }
const ROWS_SHOWN = 300

/**
 * One generic CSV/Excel import wizard shared by all seven reference-data entities (categories,
 * models, suppliers, departments, teams, locations, workstations) -- a one-time bulk-setup
 * mechanism, modeled on the Employee/Asset importers but driven by `@shared/referenceImport`'s
 * field definitions instead of a bespoke wizard per entity. Parent references (category for a
 * model, department for a team, location for a workstation or a location's parent) resolve only
 * against records that already exist; they are never auto-created and never resolved against other
 * rows in the same file.
 */
export function ReferenceImport({ kind, onDone }: { kind: ReferenceImportKind; onDone: (message?: string) => void }) {
  const fields = REFERENCE_IMPORT_FIELDS[kind]
  const label = REFERENCE_IMPORT_KIND_LABELS[kind]
  const [preview, setPreview] = useState<ReferenceImportPreview | null>(null)
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
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    void run(async () => {
      if (preview) await call('referenceData.importCancel', { importId: preview.importId }).catch(() => undefined)
      setPreview(null)
      const p = await uploadFile<ReferenceImportPreview>('/api/v1/uploads/reference-import', file, { kind })
      setPreview(p)
      setSkipInvalid(false)
      setFilter(p.counts.rejected + p.counts.duplicates > 0 ? 'problems' : 'all')
    })
  }

  const remap = (mapping: ReferenceImportPreview['mapping']) =>
    preview && run(async () => setPreview(await call('referenceData.importPreview', { importId: preview.importId, mapping })))

  const commit = () =>
    preview && run(async () => setResult(await call('referenceData.importCommit', { importId: preview.importId, mapping: preview.mapping, skipInvalidRows: skipInvalid })))

  const cancel = async () => {
    if (preview) await call('referenceData.importCancel', { importId: preview.importId }).catch(() => undefined)
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
        title={`Import ${label} from CSV/Excel`}
        description={`Every row is checked before anything is saved. Existing ${label} are never overwritten, and the import either saves all accepted rows or nothing.`}
        actions={<Button onClick={() => void cancel()}>{result ? `Back to ${label}` : 'Cancel import'}</Button>}
      />
      <ol className="steps" aria-label="Import progress">
        {['Choose file', 'Map and review', 'Done'].map((l, i) => (
          <li key={l} aria-current={step === i + 1 ? 'step' : undefined}>
            {i + 1}. {l}
          </li>
        ))}
      </ol>
      <ErrorAlert error={error} />

      {result ? (
        <Panel title="Import complete">
          <div className="stack">
            <Alert tone="success">
              {result.imported} record{result.imported === 1 ? '' : 's'} imported.{result.skipped ? ` ${result.skipped} row(s) were skipped as you chose.` : ''}
            </Alert>
            <div className="chips">
              <Button variant="primary" onClick={() => onDone(`${result.imported} ${label} imported.`)}>View {label}</Button>
              <Button onClick={() => { setResult(null); setPreview(null) }}>Import another file</Button>
            </div>
          </div>
        </Panel>
      ) : null}

      <input ref={fileInput} type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden aria-label="Import file" data-testid="import-file" onChange={onFile} />
      {!result && !preview ? (
        <Panel title="Choose a CSV or Excel file">
          <div className="stack">
            <p className="muted">
              Use a UTF-8 CSV with a header row, or a single-sheet Excel workbook.{' '}
              {fields.filter((f) => f.required).map((f) => f.label).join(', ')} {fields.filter((f) => f.required).length === 1 ? 'is' : 'are'} required.
              Any reference to another record (category, department, location) must already exist; give it by name or code. Limit: 10,000 rows or 5 MB per file.
            </p>
            <div><Button variant="primary" disabled={busy} onClick={() => void choose()}>{busy ? 'Reading…' : 'Choose file'}</Button></div>
          </div>
        </Panel>
      ) : null}

      {!result && preview ? (
        <>
          <Panel title={`${preview.fileName} (${formatBytes(preview.fileBytes)})`} actions={<Button small onClick={() => void choose()}>Choose another file</Button>}>
            <div className="stack">
              <p className="muted">Match each field to a column in your file. Fields left as "Not in file" are left empty or use their default.</p>
              <div className="mapping-grid">
                {fields.map((f) => (
                  <SelectField
                    key={f.key}
                    label={`${f.label}${f.required ? ' (required)' : ''}`}
                    value={preview.mapping[f.key] === null || preview.mapping[f.key] === undefined ? '' : String(preview.mapping[f.key])}
                    placeholder="Not in file"
                    disabled={busy}
                    onChange={(v) => void remap({ ...preview.mapping, [f.key]: v === '' ? null : Number(v) })}
                    options={preview.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))}
                  />
                ))}
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
                    <thead><tr><th className="num">Row</th><th>Status</th><th>Values</th><th>What to fix</th></tr></thead>
                    <tbody>
                      {rows.slice(0, ROWS_SHOWN).map((r) => (
                        <tr key={r.rowNumber}>
                          <td className="num">{r.rowNumber}</td>
                          <td><span className={`badge ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span></td>
                          <td>{fields.map((f) => r.values[f.key]).filter(Boolean).join(', ') || '—'}</td>
                          <td>
                            {r.issues.length === 0 ? <span className="faint">Ready</span> : (
                              <ul className="issue-list">
                                {r.issues.map((i, idx) => (
                                  <li key={idx} className={`issue--${i.severity}`}>
                                    {i.field ? <strong>{fields.find((f) => f.key === i.field)?.label ?? i.field}: </strong> : null}
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
                      {busy ? 'Importing…' : `Import ${preview.counts.accepted} record${preview.counts.accepted === 1 ? '' : 's'}`}
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
