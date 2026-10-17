import { useEffect, useState } from 'react'
import type { AssetCodeConfigView } from '@shared/api'
import { formatAssetCode } from '@shared/assets'
import { ApiError, call } from '../../api'
import { Button, ErrorAlert, Panel, SelectField, TextField, useToast } from '../../components/ui'

/** Super Admin control of the asset-code format. Existing codes never change. */
export function AssetCodeSettings({ canConfigure }: { canConfigure: boolean }) {
  const [config, setConfig] = useState<AssetCodeConfigView | null>(null)
  const [form, setForm] = useState({ prefix: '', separator: '-' as '-' | '/' | '', padding: '6', nextNumber: '1', reason: '' })
  const [error, setError] = useState<unknown>(null)
  const toast = useToast()
  const fields = error instanceof ApiError ? error.fieldErrors : {}

  const apply = (c: AssetCodeConfigView) => {
    setConfig(c)
    setForm({ prefix: c.prefix, separator: c.separator, padding: String(c.padding), nextNumber: String(c.nextNumber), reason: '' })
  }
  useEffect(() => {
    call('assets.getCodeConfig').then(apply, setError)
  }, [])

  const save = async () => {
    setError(null)
    try {
      apply(await call('assets.updateCodeConfig', { prefix: form.prefix.toUpperCase(), separator: form.separator, padding: Number(form.padding), nextNumber: Number(form.nextNumber), reason: form.reason }))
      toast.success('Asset code settings saved. New assets will use the new format; existing codes are unchanged.')
    } catch (err) {
      setError(err)
    }
  }

  if (!config) return <ErrorAlert error={error} />
  const preview = /^[A-Za-z][A-Za-z0-9]{0,9}$/.test(form.prefix) && Number(form.padding) >= 2 ? formatAssetCode({ prefix: form.prefix.toUpperCase(), separator: form.separator, padding: Number(form.padding) }, Number(form.nextNumber) || 1) : '—'
  return (
    <Panel title="Asset codes">
      <div className="stack">
        <p className="muted">
          Codes are issued automatically and in sequence. They never include category, department, location or employee details. Once
          issued, a code is permanent and is never reused. {config.issuedCount} asset{config.issuedCount === 1 ? '' : 's'} registered.
        </p>
        <ErrorAlert error={error} />
        <div className="form-grid">
          <TextField label="Prefix" value={form.prefix} disabled={!canConfigure} onChange={(e) => setForm({ ...form, prefix: e.target.value })} error={fields['prefix']} hint="1–10 letters or digits, e.g. AST" />
          <SelectField label="Separator" value={form.separator} disabled={!canConfigure} onChange={(v) => setForm({ ...form, separator: v as '-' | '/' | '' })} options={[{ value: '-', label: 'Hyphen (AST-000001)' }, { value: '/', label: 'Slash (AST/000001)' }, { value: '', label: 'None (AST000001)' }]} />
          <TextField label="Digits" value={form.padding} disabled={!canConfigure} inputMode="numeric" onChange={(e) => setForm({ ...form, padding: e.target.value })} error={fields['padding']} hint="2 to 10; numbers grow beyond this when needed" />
          <TextField label="Next number" value={form.nextNumber} disabled={!canConfigure} inputMode="numeric" onChange={(e) => setForm({ ...form, nextNumber: e.target.value })} error={fields['nextNumber']} hint={`Can only increase (currently ${config.nextNumber})`} />
          {canConfigure ? <TextField label="Reason for change" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} hint="Required. Recorded in the audit log." /> : null}
        </div>
        <p>Next code: <strong className="ident">{canConfigure ? preview : config.nextCodePreview}</strong></p>
        {canConfigure ? (
          <div className="form-actions"><Button variant="primary" disabled={!form.reason.trim()} onClick={() => void save()}>Save asset code settings</Button></div>
        ) : (
          <p className="faint">Only the Super Admin can change the asset code format.</p>
        )}
      </div>
    </Panel>
  )
}
