import { toSVG } from 'bwip-js/node'
import type { AssetLabel } from '@shared/api'
import { qrPayloadFor } from '@shared/assets'
import { labelRequestSchema, type LabelRequestInput } from '@shared/assetSchemas'
import { AppError, assertPermission, type OpContext } from '../core'
import type { Db } from '../db/sql'
import { auditFrom, recordAudit } from './foundation'

const svgDataUrl = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`

/**
 * Label artwork (unchanged from the prototype): a QR code carrying only the opaque payload and
 * a Code 128 barcode of the asset code. Reprints keep the same identity; disposed assets get none.
 */
export async function generateLabels(db: Db, raw: LabelRequestInput, ctx: OpContext): Promise<AssetLabel[]> {
  assertPermission(ctx.actor.permissions, 'labels.print')
  const input = labelRequestSchema.parse(raw)
  const ids = [...new Set(input.assetIds)]
  const assets = await db.many<{ id: string; code: string; s: string }>(
    'SELECT id, asset_code AS code, lifecycle_status AS s FROM assets WHERE organization_id = $1 AND id = ANY($2::uuid[])',
    [ctx.actor.organizationId, ids]
  )
  if (assets.length !== ids.length) throw new AppError('NOT_FOUND', 'One of the selected assets no longer exists.')
  const disposed = assets.find((a) => a.s === 'disposed')
  if (disposed) throw new AppError('STATE_CONFLICT', `${disposed.code} is disposed; labels are not printed for disposed assets.`)
  const organizationName = (await db.one<{ n: string }>('SELECT display_name AS n FROM organizations WHERE id = $1', [ctx.actor.organizationId]))!.n
  const labels = assets.map((a) => ({
    assetId: a.id,
    assetCode: a.code,
    organizationName,
    qrDataUrl: svgDataUrl(toSVG({ bcid: 'qrcode', text: qrPayloadFor(a.id) })),
    barcodeDataUrl: svgDataUrl(toSVG({ bcid: 'code128', text: a.code, height: 9, includetext: false }))
  }))
  await db.tx(async (t) => {
    for (const a of assets) await recordAudit(t, { ...auditFrom(ctx), eventType: 'asset.label_generated', entityType: 'asset', entityId: a.id, summary: { assetCode: a.code } })
  })
  return labels
}
