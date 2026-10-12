import type { Database as DB } from 'better-sqlite3'
import { toSVG } from 'bwip-js/node'
import type { AssetLabel } from '@shared/api'
import { qrPayloadFor } from '@shared/assets'
import { labelRequestSchema, type LabelRequestInput } from '@shared/assetSchemas'
import { AppError } from '../app/errors'
import { assertPermission } from '../auth/permissions'
import { recordAudit } from './audit'
import type { OpContext } from './context'
import { getOrganizationName } from './setup'

const svgDataUrl = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`

/**
 * Builds printable label artwork: a QR code with the opaque payload (no personal or financial
 * data) and a Code 128 barcode of the human-readable asset code. Reprints keep the same identity.
 */
export function generateLabels(db: DB, raw: LabelRequestInput, ctx: OpContext): AssetLabel[] {
  assertPermission(ctx.actor.permissions, 'labels.print')
  const input = labelRequestSchema.parse(raw)
  const ids = [...new Set(input.assetIds)]
  const stmt = db.prepare('SELECT id, asset_code AS code, lifecycle_status AS s FROM assets WHERE id = ?')
  const assets = ids.map((id) => {
    const a = stmt.get(id) as { id: string; code: string; s: string } | undefined
    if (!a) throw new AppError('NOT_FOUND', 'One of the selected assets no longer exists.')
    if (a.s === 'disposed') throw new AppError('STATE_CONFLICT', `${a.code} is disposed; labels are not printed for disposed assets.`)
    return a
  })
  const organizationName = getOrganizationName(db)
  const labels = assets.map((a) => ({
    assetId: a.id,
    assetCode: a.code,
    organizationName,
    qrDataUrl: svgDataUrl(toSVG({ bcid: 'qrcode', text: qrPayloadFor(a.id) })),
    barcodeDataUrl: svgDataUrl(toSVG({ bcid: 'code128', text: a.code, height: 9, includetext: false }))
  }))
  db.transaction(() => {
    for (const a of assets) {
      recordAudit(db, { actorUserId: ctx.actor.userId, eventType: 'asset.label_generated', entityType: 'asset', entityId: a.id, correlationId: ctx.correlationId, summary: { assetCode: a.code } })
    }
  })()
  return labels
}
