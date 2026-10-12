import { useEffect, useState } from 'react'
import type { AssetLabel, WarrantyState } from '@shared/api'
import { CONDITION_LABELS, LIFECYCLE_LABELS, OPERATIONAL_LABELS, type AssetCondition, type LifecycleStatus, type OperationalStatus } from '@shared/assets'
import { call } from '../../api'
import { Button, ErrorAlert } from '../../components/ui'

export function LifecycleBadge({ status }: { status: LifecycleStatus }) {
  const cls = status === 'active' ? 'badge--ok' : status === 'retired' ? 'badge--warn' : 'badge--off'
  return <span className={`badge ${cls}`}>{LIFECYCLE_LABELS[status]}</span>
}

export function OperationalBadge({ status }: { status: OperationalStatus }) {
  const cls = status === 'ready' ? 'badge--ok' : status === 'non_operational' ? 'badge--off' : 'badge--warn'
  return <span className={`badge ${cls}`}>{OPERATIONAL_LABELS[status]}</span>
}

export const conditionLabel = (c: AssetCondition): string => CONDITION_LABELS[c]

export function WarrantyNote({ end, state }: { end: string | null; state: WarrantyState }) {
  if (!end) return <span className="faint">No warranty recorded</span>
  const text = { active: 'In warranty', expiring: 'Expiring soon', expired: 'Expired', none: '' }[state]
  return (
    <>
      {end} <span className={`badge ${state === 'active' ? 'badge--ok' : state === 'expiring' ? 'badge--warn' : 'badge--off'}`}>{text}</span>
    </>
  )
}

/**
 * Printable label sheet. Artwork comes from the main process (assets.generateLabels);
 * printing uses the system dialog so any office or label printer can be chosen.
 */
export function LabelSheet({ assetIds, onClose }: { assetIds: string[]; onClose: () => void }) {
  const [labels, setLabels] = useState<AssetLabel[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    call('assets.generateLabels', { assetIds }).then(setLabels, setError)
  }, [assetIds])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="label-overlay" role="dialog" aria-modal="true" aria-label="Asset labels">
      <div className="label-overlay__bar no-print">
        <strong>{labels ? `${labels.length} label${labels.length === 1 ? '' : 's'}` : 'Preparing labels…'}</strong>
        <span className="faint">Each label shows the asset code, a QR code and a barcode. Print on label stock or plain paper.</span>
        <span className="chips">
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!labels} onClick={() => window.print()}>Print</Button>
        </span>
      </div>
      <ErrorAlert error={error} />
      <div className="label-sheet print-area">
        {labels?.map((l) => (
          <div className="asset-label" key={l.assetId}>
            <img className="asset-label__qr" src={l.qrDataUrl} alt={`QR code for ${l.assetCode}`} />
            <div className="asset-label__text">
              <span className="asset-label__org">{l.organizationName}</span>
              <span className="asset-label__code">{l.assetCode}</span>
              <img className="asset-label__barcode" src={l.barcodeDataUrl} alt={`Barcode for ${l.assetCode}`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
