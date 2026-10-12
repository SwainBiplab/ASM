import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AssetLookupResult } from '@shared/api'
import { call } from '../../api'
import { Alert, Button, ErrorAlert, PageHeader, Panel } from '../../components/ui'
import { LifecycleBadge, OperationalBadge } from './shared'

type Suffix = 'enter' | 'tab' | 'none'
/** With no scanner suffix, a burst of keystrokes followed by this pause counts as one scan. */
const IDLE_SUBMIT_MS = 150

/**
 * USB scanners act as keyboards: they "type" the code, usually followed by Enter or Tab.
 * This page keeps the scan field focused and resolves exact matches only. Nothing changes
 * until the user deliberately opens the asset and acts on it.
 */
export function ScanPage({ navigate }: { navigate: (route: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const idleTimer = useRef<number | undefined>(undefined)
  const [suffix, setSuffix] = useState<Suffix>('enter')
  const [text, setText] = useState('')
  const [result, setResult] = useState<(AssetLookupResult & { query: string }) | null>(null)
  const [recent, setRecent] = useState<Array<{ query: string; found: string | null }>>([])
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    call('settings.get').then((s) => setSuffix(s.scannerSuffix), () => undefined)
    inputRef.current?.focus()
  }, [])

  const submit = async (raw: string) => {
    window.clearTimeout(idleTimer.current)
    const query = raw.trim()
    setText('')
    inputRef.current?.focus()
    if (!query) return
    setError(null)
    try {
      const r = await call('assets.lookup', { query })
      setResult({ ...r, query })
      setRecent((list) => [{ query, found: r.matches.length === 1 ? r.matches[0]!.assetCode : null }, ...list].slice(0, 10))
    } catch (err) {
      setError(err)
      setResult(null)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || (e.key === 'Tab' && suffix === 'tab')) {
      e.preventDefault()
      void submit(text)
    }
  }
  const onChange = (value: string) => {
    setText(value)
    if (suffix === 'none') {
      window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => void submit(value), IDLE_SUBMIT_MS)
    }
  }

  return (
    <div className="stack scan-box">
      <PageHeader title="Scan or find an asset" description="Scan a label with a USB barcode scanner, or type an asset code or serial number. Matches must be exact." />
      <Panel>
        <div className="stack">
          <label className="field__label" htmlFor="scan-field">Asset code, serial number or QR label</label>
          <input
            id="scan-field"
            ref={inputRef}
            className="input scan-input"
            value={text}
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Scan now, or type and press Enter"
          />
          <div className="chips">
            <Button variant="primary" onClick={() => void submit(text)}>Find</Button>
            <span className="faint">Scanner suffix: {suffix === 'none' ? 'none (auto-detect pause)' : suffix === 'tab' ? 'Tab' : 'Enter'}. Change it in Settings.</span>
          </div>
        </div>
      </Panel>
      <ErrorAlert error={error} />
      {result ? (
        <Panel title={`Result for "${result.query}"`}>
          <div className="stack">
            <Alert tone={result.matches.length === 1 ? 'success' : result.matches.length > 1 ? 'warn' : 'error'}>{result.message}</Alert>
            {result.matches.map((m) => (
              <div className="panel panel__body scan-result" key={m.id}>
                <div className="chips">
                  <strong className="ident">{m.assetCode}</strong>
                  <LifecycleBadge status={m.lifecycleStatus} />
                  {m.lifecycleStatus === 'active' ? <OperationalBadge status={m.operationalStatus} /> : null}
                </div>
                <p className="muted">
                  {m.categoryName}: {[m.manufacturer, m.modelName].filter(Boolean).join(' ') || 'no model'}{m.serialNumber ? `, serial ${m.serialNumber}` : ''}
                </p>
                <p className="faint">{m.locationPath ?? 'Location not set'}</p>
                <div className="chips"><Button small onClick={() => navigate(`assets/${m.id}`)}>Open asset</Button></div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
      {recent.length ? (
        <Panel title="Recent scans">
          <ul className="history">
            {recent.map((r, i) => (
              <li key={i}><span className="ident">{r.query}</span> <span className="faint">{r.found ? `found ${r.found}` : 'no single match'}</span></li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  )
}
