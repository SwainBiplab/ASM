import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type JsQR from 'jsqr'
import type { AssetLookupResult } from '@shared/api'
import { call } from '../../api'
import { Alert, Button, ErrorAlert, PageHeader, Panel } from '../../components/ui'
import { LifecycleBadge, OperationalBadge } from './shared'

type Suffix = 'enter' | 'tab' | 'none'
/** With no scanner suffix, a burst of keystrokes followed by this pause counts as one scan. */
const IDLE_SUBMIT_MS = 150
/** How often a video frame is sampled for a QR code. Faster than this gains nothing visible. */
const DETECT_INTERVAL_MS = 200

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

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const detectTimerRef = useRef<number | undefined>(undefined)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  /**
   * TAS §8.2/U5's "controlled capability check": camera scanning only ever appears where the
   * camera API exists. QR decoding itself is done with `jsqr` (pure JS, works wherever a canvas
   * does) rather than the native Barcode Detection API, which in practice is absent from most
   * desktop Chrome installs and all of Firefox/Safari -- relying on it left the feature invisible
   * almost everywhere, defeating the point of a "controlled" check rather than an effectively-off one.
   */
  const cameraSupported = useMemo(() => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia, [])

  useEffect(() => {
    call('settings.get').then((s) => setSuffix(s.scannerSuffix), () => undefined)
    inputRef.current?.focus()
  }, [])

  const stopCamera = () => {
    if (detectTimerRef.current !== undefined) window.clearInterval(detectTimerRef.current)
    detectTimerRef.current = undefined
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setCameraOpen(false)
  }

  useEffect(() => stopCamera, [])

  // `jsqr` (~130 KB) is only ever needed by someone who actually opens the camera, so it's a
  // dynamic import rather than a static one -- everyone else's initial page load stays lighter.
  const jsQRRef = useRef<typeof JsQR | null>(null)

  const startCamera = async () => {
    setCameraError(null)
    setError(null)
    try {
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }),
        jsQRRef.current ? Promise.resolve() : import('jsqr').then((m) => { jsQRRef.current = m.default })
      ])
      streamRef.current = stream
      setCameraOpen(true)
    } catch {
      setCameraError('Camera access was denied or is unavailable. Use a USB scanner or type the code below.')
    }
  }

  // Runs only after React has committed the <video>/<canvas> elements (cameraOpen just became
  // true), unlike a manually scheduled requestAnimationFrame racing that commit -- which could fire
  // first and find the refs still null, silently leaving the camera "open" with nothing scanning.
  useEffect(() => {
    if (!cameraOpen) return
    const video = videoRef.current
    const canvas = canvasRef.current
    const stream = streamRef.current
    const jsQR = jsQRRef.current
    if (!video || !canvas || !stream || !jsQR) return
    video.srcObject = stream
    void video.play()
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return

    const tick = () => {
      // Frames arrive before the video reports real dimensions; skip those rather than draw a 0x0 image.
      if (video.readyState < video.HAVE_CURRENT_DATA || video.videoWidth === 0) return
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      let code: ReturnType<typeof jsQR> = null
      try {
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
        code = jsQR(frame.data, frame.width, frame.height)
      } catch {
        /* a transient read error on one frame is not fatal; the next tick tries again */
      }
      if (code) {
        const value = code.data
        stopCamera()
        setText(value)
        void submit(value)
      }
    }
    detectTimerRef.current = window.setInterval(tick, DETECT_INTERVAL_MS)
    return () => window.clearInterval(detectTimerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOpen])

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
            {cameraSupported && !cameraOpen ? <Button onClick={() => void startCamera()}>📷 Scan with camera</Button> : null}
            {cameraOpen ? <Button onClick={stopCamera}>Stop camera</Button> : null}
            <span className="faint">Scanner suffix: {suffix === 'none' ? 'none (auto-detect pause)' : suffix === 'tab' ? 'Tab' : 'Enter'}. Change it in Settings.</span>
          </div>
          {!cameraSupported && !cameraOpen ? (
            <p className="faint">Camera scanning isn't available on this browser or device; use a USB scanner or type the code above.</p>
          ) : null}
          {cameraError ? <Alert tone="error">{cameraError}</Alert> : null}
          {cameraOpen ? (
            <div className="scan-camera">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video ref={videoRef} className="scan-camera__video" muted playsInline aria-label="Camera preview for QR scanning" />
              <canvas ref={canvasRef} hidden aria-hidden="true" />
              <p className="faint">Point the camera at an asset's QR label. Nothing changes until you confirm an action on the asset.</p>
            </div>
          ) : null}
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
