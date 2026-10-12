import { z } from 'zod'
import { isoDateSchema } from './orgSchemas'
import { currencySchema, roleKeySchema, uuidSchema } from './schemas'
import { UNIT_DISPOSITIONS } from './procurement'

/** Input schemas for W6 procurement, approval, purchase-order, and goods-receipt commands (strict objects). */

const required = (max: number) => z.string().trim().min(1, 'Required').max(max, `Maximum ${max} characters`)
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maximum ${max} characters`)
    .nullable()
    .transform((v) => (v === '' || v === null ? null : v))
const moneyText = z.string().trim().min(1, 'Required').max(20)
const quantity = z.number().int().min(1).max(1_000_000)
const paging = { page: z.number().int().min(1).max(100000).default(1), pageSize: z.number().int().min(1).max(200).default(50) }

// ---------------------------------------------------------------- purchase requests

const requestItemSchema = z.strictObject({
  description: required(500),
  categoryId: uuidSchema.nullable(),
  modelId: uuidSchema.nullable(),
  quantity,
  estimatedUnitCost: moneyText
})
export type RequestItemInput = z.input<typeof requestItemSchema>

export const saveRequestDraftSchema = z.strictObject({
  requestId: uuidSchema.nullable(),
  departmentId: uuidSchema.nullable(),
  teamId: uuidSchema.nullable(),
  justification: required(2000),
  requiredByDate: isoDateSchema.nullable(),
  currency: currencySchema,
  items: z.array(requestItemSchema).min(1, 'Add at least one line item').max(100)
})
export type SaveRequestDraftInput = z.input<typeof saveRequestDraftSchema>

export const requestRefSchema = z.strictObject({ requestId: uuidSchema })

export const submitRequestSchema = z.strictObject({ requestId: uuidSchema })
export type SubmitRequestInput = z.input<typeof submitRequestSchema>

export const cancelRequestSchema = z.strictObject({ requestId: uuidSchema, reason: required(500) })
export type CancelRequestInput = z.input<typeof cancelRequestSchema>

export const requestListSchema = z.strictObject({
  status: z.enum(['draft', 'submitted', 'approved', 'rejected', 'cancelled', 'all']).default('all'),
  requesterUserId: uuidSchema.optional(),
  query: z.string().trim().max(100).optional(),
  ...paging
})
export type RequestListInput = z.input<typeof requestListSchema>

// ---------------------------------------------------------------- approvals

const approvalStepSchema = z
  .strictObject({ requiredRoleKey: roleKeySchema.nullable(), requiredUserId: uuidSchema.nullable() })
  .refine((v) => (v.requiredRoleKey === null) !== (v.requiredUserId === null), 'Choose exactly one of role or named approver')
export type ApprovalStepInput = z.input<typeof approvalStepSchema>

export const saveApprovalPolicySchema = z.strictObject({
  policyGroupId: uuidSchema.nullable(),
  transactionType: z.literal('purchase_request'),
  name: required(160),
  minAmount: moneyText.nullable(),
  currency: currencySchema.nullable(),
  preventSelfApproval: z.boolean().default(true),
  isActive: z.boolean().default(true),
  steps: z.array(approvalStepSchema).min(1, 'Add at least one approval step').max(10)
}).refine((v) => v.minAmount === null || v.currency !== null, { message: 'Currency is required when an amount threshold is set', path: ['currency'] })
export type SaveApprovalPolicyInput = z.input<typeof saveApprovalPolicySchema>

export const policyListSchema = z.strictObject({ transactionType: z.literal('purchase_request').optional() })
export type PolicyListInput = z.input<typeof policyListSchema>

export const decideApprovalSchema = z.strictObject({ instanceId: uuidSchema, decision: z.enum(['approved', 'rejected']), reason: optionalText(1000) })
export type DecideApprovalInput = z.input<typeof decideApprovalSchema>

export const approvalQueueSchema = z.strictObject({ ...paging })
export type ApprovalQueueInput = z.input<typeof approvalQueueSchema>

// ---------------------------------------------------------------- purchase orders

const orderItemSchema = z.strictObject({
  requestItemId: uuidSchema.nullable(),
  description: required(500),
  categoryId: uuidSchema,
  modelId: uuidSchema.nullable(),
  quantity,
  unitPrice: moneyText
})
export type OrderItemInput = z.input<typeof orderItemSchema>

export const createOrderSchema = z.strictObject({
  requestId: uuidSchema,
  supplierId: uuidSchema,
  currency: currencySchema,
  orderDate: isoDateSchema.nullable(),
  expectedDeliveryDate: isoDateSchema.nullable(),
  notes: optionalText(1000),
  items: z.array(orderItemSchema).min(1, 'Add at least one line item').max(100)
})
export type CreateOrderInput = z.input<typeof createOrderSchema>

export const amendOrderSchema = z.strictObject({
  poId: uuidSchema,
  expectedDeliveryDate: isoDateSchema.nullable(),
  notes: optionalText(1000),
  reason: required(500),
  items: z.array(z.strictObject({ poItemId: uuidSchema, quantity, unitPrice: moneyText })).max(100)
})
export type AmendOrderInput = z.input<typeof amendOrderSchema>

export const cancelOrderSchema = z.strictObject({ poId: uuidSchema, reason: required(500) })
export type CancelOrderInput = z.input<typeof cancelOrderSchema>

export const orderRefSchema = z.strictObject({ poId: uuidSchema })

export const orderListSchema = z.strictObject({
  status: z.enum(['open', 'partially_received', 'received', 'cancelled', 'all']).default('all'),
  supplierId: uuidSchema.optional(),
  query: z.string().trim().max(100).optional(),
  ...paging
})
export type OrderListInput = z.input<typeof orderListSchema>

// ---------------------------------------------------------------- goods receipt

const receiptUnitSchema = z.strictObject({ serialNumber: optionalText(120), disposition: z.enum(UNIT_DISPOSITIONS) })

const receiptItemSchema = z
  .strictObject({
    poItemId: uuidSchema,
    units: z.array(receiptUnitSchema).max(1000).optional(),
    bulkAcceptedQuantity: z.number().int().min(0).max(1_000_000).optional(),
    bulkDamagedQuantity: z.number().int().min(0).max(1_000_000).optional(),
    bulkRejectedQuantity: z.number().int().min(0).max(1_000_000).optional(),
    locationId: uuidSchema.nullable(),
    discrepancyNotes: optionalText(1000)
  })
  .refine((v) => !!v.units !== (v.bulkAcceptedQuantity !== undefined), 'Provide either per-unit entries or bulk quantities, not both')
export type ReceiptItemInput = z.input<typeof receiptItemSchema>

export const createReceiptSchema = z.strictObject({
  poId: uuidSchema,
  supplierReference: optionalText(160),
  notes: optionalText(1000),
  items: z.array(receiptItemSchema).min(1, 'Add at least one received line').max(100)
})
export type CreateReceiptInput = z.input<typeof createReceiptSchema>

export const resolveDiscrepancySchema = z.strictObject({ receiptItemId: uuidSchema, resolutionNotes: required(1000) })
export type ResolveDiscrepancyInput = z.input<typeof resolveDiscrepancySchema>

export const receiptRefSchema = z.strictObject({ receiptId: uuidSchema })

export const receiptListSchema = z.strictObject({ poId: uuidSchema.optional(), ...paging })
export type ReceiptListInput = z.input<typeof receiptListSchema>
