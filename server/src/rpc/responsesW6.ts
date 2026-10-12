import { z } from 'zod'
import type {
  ApprovalInstanceView,
  ApprovalPolicySummary,
  ApprovalQueueItem,
  GoodsReceiptDetail,
  GoodsReceiptItemView,
  GoodsReceiptSummary,
  PurchaseOrderAmendmentView,
  PurchaseOrderDetail,
  PurchaseOrderItemView,
  PurchaseOrderSummary,
  PurchaseRequestDetail,
  PurchaseRequestItemView,
  PurchaseRequestSummary
} from '@shared/api'
import { APPROVAL_DECISIONS, APPROVAL_INSTANCE_STATUSES, ORDER_STATUSES, RECEIPT_DISCREPANCY_STATUSES, REQUEST_STATUSES, UNIT_DISPOSITIONS } from '@shared/procurement'
import { dateOnly, iso, nullable, uuid } from './responses'
import { documentLinkOutput } from './responsesW2'

/** W6 output schemas (D34): checked against the shared DTOs; undeclared fields are stripped. */

const optText = nullable(z.string())
const optInt = nullable(z.number().int())

const requestItemOutput: z.ZodType<PurchaseRequestItemView> = z.object({
  id: uuid, lineNo: z.number().int(), description: z.string(), categoryId: nullable(uuid), categoryName: optText,
  modelId: nullable(uuid), modelName: optText, quantity: z.number().int(), estimatedUnitCostMinor: z.number().int(), lineTotalMinor: z.number().int()
})

const approvalStepOutput = z.object({
  stepOrder: z.number().int(), requiredRoleKey: optText, requiredRoleName: optText, requiredUserId: nullable(uuid), requiredUserName: optText,
  decision: nullable(z.enum(APPROVAL_DECISIONS)), decidedByName: optText, decidedAt: nullable(iso), reason: optText
})

const approvalInstanceOutput: z.ZodType<ApprovalInstanceView> = z.object({
  id: uuid, status: z.enum(APPROVAL_INSTANCE_STATUSES), currentStep: z.number().int(), totalSteps: z.number().int(),
  policyName: z.string(), policyVersion: z.number().int(), steps: z.array(approvalStepOutput)
})

const requestSummaryShape = {
  id: uuid, requestNumber: z.string(), requesterName: optText, departmentName: optText, teamName: optText, justification: z.string(),
  requiredByDate: nullable(dateOnly), currency: z.string(), totalMinor: z.number().int(), status: z.enum(REQUEST_STATUSES),
  submittedAt: nullable(iso), decidedAt: nullable(iso), createdAt: iso
}
export const requestSummaryOutput: z.ZodType<PurchaseRequestSummary> = z.object(requestSummaryShape)
export const requestDetailOutput: z.ZodType<PurchaseRequestDetail> = z.object({
  ...requestSummaryShape, cancelReason: optText, items: z.array(requestItemOutput), approval: nullable(approvalInstanceOutput), documents: z.array(documentLinkOutput)
})

const policyStepOutput = z.object({ stepOrder: z.number().int(), requiredRoleKey: optText, requiredRoleName: optText, requiredUserId: nullable(uuid), requiredUserName: optText })
export const approvalPolicyOutput: z.ZodType<ApprovalPolicySummary> = z.object({
  id: uuid, policyGroupId: uuid, version: z.number().int(), name: z.string(), transactionType: z.literal('purchase_request'),
  minAmountMinor: optInt, currency: optText, preventSelfApproval: z.boolean(), isActive: z.boolean(), isCurrent: z.boolean(), steps: z.array(policyStepOutput)
})

export const approvalQueueItemOutput: z.ZodType<ApprovalQueueItem> = z.object({
  instanceId: uuid, requestId: uuid, requestNumber: z.string(), requesterName: optText, justification: z.string(),
  totalMinor: z.number().int(), currency: z.string(), stepOrder: z.number().int(), submittedAt: nullable(iso)
})

const orderItemOutput: z.ZodType<PurchaseOrderItemView> = z.object({
  id: uuid, lineNo: z.number().int(), description: z.string(), categoryId: uuid, categoryName: z.string(), modelId: nullable(uuid),
  quantity: z.number().int(), unitPriceMinor: z.number().int(), lineTotalMinor: z.number().int(), receivedQuantity: z.number().int(), outstandingQuantity: z.number().int()
})
const amendmentOutput: z.ZodType<PurchaseOrderAmendmentView> = z.object({
  field: z.string(), oldValue: optText, newValue: optText, reason: z.string(), amendedByName: optText, amendedAt: iso
})
const orderSummaryShape = {
  id: uuid, poNumber: z.string(), supplierId: uuid, supplierName: z.string(), requestId: uuid, requestNumber: z.string(),
  currency: z.string(), totalMinor: z.number().int(), status: z.enum(ORDER_STATUSES), orderDate: nullable(dateOnly), expectedDeliveryDate: nullable(dateOnly), createdAt: iso
}
export const orderSummaryOutput: z.ZodType<PurchaseOrderSummary> = z.object(orderSummaryShape)
export const orderDetailOutput: z.ZodType<PurchaseOrderDetail> = z.object({
  ...orderSummaryShape, notes: optText, cancelReason: optText, items: z.array(orderItemOutput), amendments: z.array(amendmentOutput), documents: z.array(documentLinkOutput)
})

const receiptUnitOutput = z.object({ unitNo: z.number().int(), serialNumber: optText, disposition: z.enum(UNIT_DISPOSITIONS), assetId: nullable(uuid), assetCode: optText })
const receiptItemOutput: z.ZodType<GoodsReceiptItemView> = z.object({
  id: uuid, poItemId: uuid, description: z.string(), receivedQuantity: z.number().int(), acceptedQuantity: z.number().int(),
  damagedQuantity: z.number().int(), rejectedQuantity: z.number().int(), discrepancyStatus: z.enum(RECEIPT_DISCREPANCY_STATUSES),
  discrepancyNotes: optText, resolutionNotes: optText, units: z.array(receiptUnitOutput)
})
const receiptSummaryShape = {
  id: uuid, receiptNumber: z.string(), poId: uuid, poNumber: z.string(), receivedByName: optText, receivedAt: iso,
  supplierReference: optText, itemCount: z.number().int()
}
export const receiptSummaryOutput: z.ZodType<GoodsReceiptSummary> = z.object(receiptSummaryShape)
export const receiptDetailOutput: z.ZodType<GoodsReceiptDetail> = z.object({
  ...receiptSummaryShape, notes: optText, items: z.array(receiptItemOutput), documents: z.array(documentLinkOutput)
})
