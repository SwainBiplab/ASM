import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { ApiError } from '../api'

type ButtonVariant = 'default' | 'primary' | 'danger' | 'quiet'

export function Button({
  variant = 'default',
  small,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; small?: boolean }) {
  const cls = ['btn', variant !== 'default' && `btn--${variant}`, small && 'btn--small', className].filter(Boolean).join(' ')
  return <button type="button" className={cls} {...rest} />
}

export function TextField({
  label,
  hint,
  error,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | undefined }) {
  const id = useId()
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-msg` : undefined}
        {...rest}
      />
      {error ? (
        <span id={`${id}-msg`} className="field__error">
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-msg`} className="field__hint">
          {hint}
        </span>
      ) : null}
    </div>
  )
}

/** Shows the server's safe message (never internals) and, when given, a retry action. */
export function ErrorAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null
  const ref = error instanceof ApiError ? error.correlationId : null
  const message = error instanceof ApiError ? error.message : (error instanceof Error ? error.message : 'Something went wrong. Reload the page and try again.')
  return (
    <div className="alert alert--error" role="alert">
      {message}
      {ref && ref !== '-' ? <span className="alert__ref">Reference {ref}</span> : null}
      {onRetry ? (
        <>
          {' '}
          <Button small onClick={onRetry}>
            Try again
          </Button>
        </>
      ) : null}
    </div>
  )
}

export function Alert({ tone, children }: { tone: 'success' | 'warn' | 'info' | 'error'; children: ReactNode }) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="chips">{actions}</div> : null}
    </header>
  )
}

export function Panel({ title, actions, children, flush }: { title?: string; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="panel">
      {title || actions ? (
        <div className="panel__head">
          {title ? <h2>{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {flush ? children : <div className="panel__body">{children}</div>}
    </section>
  )
}

export function Dialog({
  title,
  children,
  footer,
  onClose
}: {
  title: string
  children: ReactNode
  footer: ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input, select, button')?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [onClose])
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="dialog__head">
          <h2 id={titleId}>{title}</h2>
        </div>
        <div className="dialog__body">{children}</div>
        <div className="dialog__foot">{footer}</div>
      </div>
    </div>
  )
}

export function TagMark({ subtitle }: { subtitle?: string }) {
  return (
    <span className="tag-mark">
      <span className="tag-mark__label">BPO AM</span>
      <span className="tag-mark__name">
        Asset Management
        {subtitle ? <span className="rail__org"> {subtitle}</span> : null}
      </span>
    </span>
  )
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
  error,
  disabled
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
  placeholder?: string
  hint?: string
  error?: string | undefined
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="select" value={value} disabled={disabled} aria-invalid={error ? true : undefined} onChange={(e) => onChange(e.target.value)}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  )
}

export function TextAreaField({ label, value, onChange, hint, error }: { label: string; value: string; onChange: (v: string) => void; hint?: string; error?: string | undefined }) {
  const id = useId()
  return (
    <div className="field field--wide">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <textarea id={id} className="input textarea" value={value} rows={3} onChange={(e) => onChange(e.target.value)} />
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: ReadonlyArray<{ id: T; label: string }>; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className="tabs__tab" onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function ActiveBadge({ active, inactiveLabel = 'Deactivated' }: { active: boolean; inactiveLabel?: string }) {
  return <span className={`badge ${active ? 'badge--ok' : 'badge--off'}`}>{active ? 'Active' : inactiveLabel}</span>
}

/** Asks for the mandatory reason when deactivating or reactivating a record. */
export function ReasonDialog({
  title,
  description,
  confirmLabel,
  danger,
  onConfirm,
  onClose
}: {
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
  onConfirm: (reason: string) => Promise<void>
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm(reason)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={busy || !reason.trim()} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">{description}</p>
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="Required. Recorded in the audit log." />
      </div>
    </Dialog>
  )
}
