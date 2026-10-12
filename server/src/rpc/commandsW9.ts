import {
  approveDeviceSchema,
  deviceListSchema,
  forceReclaimLeaseSchema,
  leaseListSchema,
  leaseRefSchema,
  requestDeviceEnrollmentSchema,
  requestLeaseSchema,
  revokeDeviceSchema
} from '@shared/offlineLeasesSchemas'
import { uploadOfflineMaintenanceRequestSchema, uploadOfflineObservationSchema } from '@shared/offlineSyncSchemas'
import type { ServerConfig } from '../config'
import { AppError, type OpContext } from '../core'
import * as offlineLeases from '../services/offlineLeases'
import * as offlineSync from '../services/offlineSync'
import type { DocumentStorage } from '../storage/storage'
import type { W9CommandName } from './commandNames'
import type { CommandDefinition, HandlerContext } from './dispatcher'
import { assetListItemOutput } from './responsesW2'
import { maintenanceUploadResultOutput, offlineLeaseOutput, syncDeviceOutput, uploadResultOutput } from './responsesW9'
import { z } from 'zod'

function op(ctx: HandlerContext): OpContext {
  if (!ctx.actor) throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
  return { correlationId: ctx.correlationId, actor: ctx.actor, ip: ctx.http.ip }
}

const session = 'session' as const
/** Every W9.2/W9.7 write is retry-safe: a repeated Idempotency-Key replays the first outcome (D36).
 *  For the W9.7 upload commands, the agent sends the local record's own id as the key (see
 *  `src/shared/offlineSyncSchemas.ts`), so a retry within 24h replays the cached response; the
 *  `offline_sync_uploads` table is the second, permanent layer for a retry after that TTL. */
const required = 'required' as const

export function buildW9Commands(config: ServerConfig, storage: DocumentStorage): { [K in W9CommandName]: CommandDefinition<K> } {
  return {
    'devices.requestEnrollment': { input: requestDeviceEnrollmentSchema, output: syncDeviceOutput, auth: session, idempotency: required, handler: (i, c) => offlineLeases.requestDeviceEnrollment(c.db, i, op(c)) },
    'devices.approve': { input: approveDeviceSchema, output: syncDeviceOutput, auth: session, idempotency: required, handler: (i, c) => offlineLeases.approveDevice(c.db, i, op(c)) },
    'devices.revoke': { input: revokeDeviceSchema, output: syncDeviceOutput, auth: session, idempotency: required, handler: (i, c) => offlineLeases.revokeDevice(c.db, i, op(c)) },
    'devices.list': { input: deviceListSchema, output: z.array(syncDeviceOutput), auth: session, handler: (i, c) => offlineLeases.listDevices(c.db, i, op(c)) },
    'leases.request': { input: requestLeaseSchema, output: offlineLeaseOutput, auth: session, idempotency: required, handler: (i, c) => offlineLeases.requestLease(c.db, i, op(c)) },
    'leases.release': { input: leaseRefSchema, output: offlineLeaseOutput, auth: session, idempotency: required, handler: (i, c) => offlineLeases.releaseLease(c.db, i, op(c)) },
    'leases.forceReclaim': { input: forceReclaimLeaseSchema, output: offlineLeaseOutput, auth: session, idempotency: required, handler: (i, c) => offlineLeases.forceReclaimLease(c.db, i, op(c)) },
    'leases.list': { input: leaseListSchema, output: z.array(offlineLeaseOutput), auth: session, handler: (i, c) => offlineLeases.listLeases(c.db, i, op(c)) },
    'leases.getScopedAssets': { input: leaseRefSchema, output: z.array(assetListItemOutput), auth: session, handler: (i, c) => offlineLeases.getLeaseScopedAssets(c.db, i, op(c)) },
    'offlineSync.uploadObservation': { input: uploadOfflineObservationSchema, output: uploadResultOutput, auth: session, idempotency: required, handler: (i, c) => offlineSync.uploadOfflineObservation(c.db, i, op(c), config) },
    'offlineSync.uploadMaintenanceRequest': { input: uploadOfflineMaintenanceRequestSchema, output: maintenanceUploadResultOutput, auth: session, idempotency: required, handler: (i, c) => offlineSync.uploadOfflineMaintenanceRequest(c.db, storage, i, op(c), config) }
  }
}
