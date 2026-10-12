import type { Page } from '@shared/api'
import type {
  ApprovalInstanceView,
  ApprovalPolicySummary,
  ApprovalQueueItem,
  PurchaseRequestDetail,
  PurchaseRequestItemView,
  PurchaseRequestSummary
} from '@shared/api'
import {
  approvalQueueSchema,
  cancelRequestSchema,
  decideApprovalSchema,
  policyListSchema,
  requestListSchema,
  requestRefSchema,
  saveApprovalPolicySchema,
  saveRequestDraftSchema,
  submitRequestSchema,
  type ApprovalStepInput,
  type CancelRequestInput,
  type DecideApprovalInput,
  type PolicyListInput,
  type ApprovalQueueInput,
  type RequestListInput,
  type SaveApprovalPolicyInput,
  type SaveRequestDraftInput,
  type SubmitRequestInput
} from '@shared/procurementSchemas'
import { parseMoneyToMinor } from '@shared/assets'
import { AppError, assertPermission, newId, type OpContext } from '../core'
import { pgErrorCode, type Db, type SqlClient } from '../db/sql'
import type { DocumentStorage } from '../storage/storage'
import { conflict, invalid, likePattern, Params, requireRow } from './common'
import { listDocumentLinks } from './documents'
import { auditFrom, recordAudit } from './foundation'

/**
 * Purchase requests and the configurable approval engine (W6, TAS §12). An approval instance
 * always snapshots a specific `approval_policies` row (a specific version); editing the policy
 * later inserts a new version and flips `is_current`, but the old row is never mutated or
 * deleted, so an approval already in progress keeps working against exactly what it started
 * with (TAS §12.2).
 */

export async function nextW6Number(t: SqlClient, org: string, kind: 'request' | 'po' | 'receipt'): Promise<string> {
  const column = kind === 'request' ? 'next_request' : kind === 'po' ? 'next_po' : 'next_receipt'
  const prefix = kind === 'request' ? 'PR' : kind === 'po' ? 'PO' : 'GR'
  await t.exec('INSERT INTO w6_counters (organization_id) VALUES ($1) ON CONFLICT DO NOTHING', [org])
  const r = await t.one<{ n: number }>(`UPDATE w6_counters SET ${column} = ${column} + 1 WHERE organization_id = $1 RETURNING ${column} - 1 AS n`, [org])
  return `${prefix}-${String(r!.n).padStart(6, '0')}`
}

async function actorHoldsRole(c: SqlClient, org: string, userId: string, roleKey: string): Promise<boolean> {
  const row = await c.one<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.organization_id = $2 AND r.key = $3) AS ok`,
    [userId, org, roleKey]
  )
  return !!row?.ok
}

// ---------------------------------------------------------------- purchase requests

const REQUEST_ITEM_COLUMNS = `i.id, i.line_no AS "lineNo", i.description, i.category_id AS "categoryId", cat.name AS "categoryName",
  i.model_id AS "modelId", m.model_name AS "modelName", i.quantity, i.estimated_unit_cost_minor AS "estimatedUnitCostMinor", i.line_total_minor AS "lineTotalMinor"`

async function loadItems(c: SqlClient, requestId: string): Promise<PurchaseRequestItemView[]> {
  return c.many<PurchaseRequestItemView>(
    `SELECT ${REQUEST_ITEM_COLUMNS} FROM purchase_request_items i
     LEFT JOIN asset_categories cat ON cat.id = i.category_id LEFT JOIN asset_models m ON m.id = i.model_id
     WHERE i.request_id = $1 ORDER BY i.line_no`,
    [requestId]
  )
}

async function loadApproval(c: SqlClient, instanceId: string | null): Promise<ApprovalInstanceView | null> {
  if (!instanceId) return null
  const instance = await c.one<{ id: string; status: ApprovalInstanceView['status']; currentStep: number; totalSteps: number; policyId: string; policyName: string; policyVersion: number }>(
    `SELECT ai.id, ai.status, ai.current_step AS "currentStep", ai.total_steps AS "totalSteps", ai.policy_id AS "policyId", p.name AS "policyName", p.version AS "policyVersion"
     FROM approval_instances ai JOIN approval_policies p ON p.id = ai.policy_id WHERE ai.id = $1`,
    [instanceId]
  )
  if (!instance) return null
  const steps = await c.many<{ stepOrder: number; requiredRoleKey: string | null; requiredRoleName: string | null; requiredUserId: string | null; requiredUserName: string | null }>(
    `SELECT s.step_order AS "stepOrder", s.required_role_key AS "requiredRoleKey", r.name AS "requiredRoleName",
            s.required_user_id AS "requiredUserId", u.display_name AS "requiredUserName"
     FROM approval_policy_steps s LEFT JOIN roles r ON r.organization_id = s.organization_id AND r.key = s.required_role_key
       LEFT JOIN users u ON u.id = s.required_user_id
     WHERE s.policy_id = $1 ORDER BY s.step_order`,
    [instance.policyId]
  )
  const decisions = await c.many<{ stepOrder: number; decision: 'approved' | 'rejected'; decidedByName: string | null; decidedAt: string; reason: string | null }>(
    `SELECT d.step_order AS "stepOrder", d.decision, u.display_name AS "decidedByName", d.decided_at AS "decidedAt", d.reason
     FROM approval_decisions d LEFT JOIN users u ON u.id = d.decided_by WHERE d.instance_id = $1`,
    [instanceId]
  )
  const byStep = new Map(decisions.map((d) => [d.stepOrder, d]))
  return {
    id: instance.id,
    status: instance.status,
    currentStep: instance.currentStep,
    totalSteps: instance.totalSteps,
    policyName: instance.policyName,
    policyVersion: instance.policyVersion,
    steps: steps.map((s) => {
      const d = byStep.get(s.stepOrder)
      return { ...s, decision: d?.decision ?? null, decidedByName: d?.decidedByName ?? null, decidedAt: d?.decidedAt ?? null, reason: d?.reason ?? null }
    })
  }
}

const REQUEST_SUMMARY_COLUMNS = `r.id, r.request_number AS "requestNumber", ru.display_name AS "requesterName", d.name AS "departmentName", tm.name AS "teamName",
  r.justification, r.required_by_date AS "requiredByDate", r.currency, r.status, r.submitted_at AS "submittedAt", r.decided_at AS "decidedAt", r.created_at AS "createdAt"`
const REQUEST_SUMMARY_FROM = `FROM purchase_requests r LEFT JOIN users ru ON ru.id = r.requester_user_id
  LEFT JOIN departments d ON d.id = r.department_id LEFT JOIN teams tm ON tm.id = r.team_id`

async function requestTotal(c: SqlClient, requestId: string): Promise<number> {
  const r = await c.one<{ t: string | null }>('SELECT SUM(line_total_minor)::bigint AS t FROM purchase_request_items WHERE request_id = $1', [requestId])
  return Number(r?.t ?? 0)
}

export async function listRequests(c: SqlClient, raw: RequestListInput, ctx: OpContext): Promise<Page<PurchaseRequestSummary>> {
  assertPermission(ctx.actor.permissions, 'procurement.view')
  const input = requestListSchema.parse(raw)
  const org = ctx.actor.organizationId
  const p = new Params()
  const org$ = p.add(org)
  let where = `r.organization_id = ${org$}`
  if (input.status !== 'all') where += ` AND r.status = ${p.add(input.status)}`
  if (input.requesterUserId) where += ` AND r.requester_user_id = ${p.add(input.requesterUserId)}`
  if (input.query) where += ` AND (r.request_number ILIKE ${p.add(likePattern(input.query))} ESCAPE '\\' OR r.justification ILIKE ${p.add(likePattern(input.query))} ESCAPE '\\')`
  const total = (await c.one<{ n: string }>(`SELECT COUNT(*) AS n ${REQUEST_SUMMARY_FROM} WHERE ${where}`, p.values))!.n
  const rows = await c.many<PurchaseRequestSummary>(
    `SELECT ${REQUEST_SUMMARY_COLUMNS}, COALESCE((SELECT SUM(line_total_minor) FROM purchase_request_items WHERE request_id = r.id), 0)::bigint AS "totalMinor"
     ${REQUEST_SUMMARY_FROM} WHERE ${where} ORDER BY r.created_at DESC LIMIT ${p.add(input.pageSize)} OFFSET ${p.add((input.page - 1) * input.pageSize)}`,
    p.values
  )
  return { items: rows.map((r) => ({ ...r, totalMinor: Number(r.totalMinor) })), total: Number(total), page: input.page, pageSize: input.pageSize }
}

export async function getRequest(c: SqlClient, storage: DocumentStorage, requestId: string, ctx: OpContext, afterWrite = false): Promise<PurchaseRequestDetail> {
  if (!afterWrite) assertPermission(ctx.actor.permissions, 'procurement.view')
  const row = await c.one<PurchaseRequestSummary & { approvalInstanceId: string | null; cancelReason: string | null }>(
    `SELECT ${REQUEST_SUMMARY_COLUMNS}, r.approval_instance_id AS "approvalInstanceId", r.cancel_reason AS "cancelReason" ${REQUEST_SUMMARY_FROM} WHERE r.id = $1 AND r.organization_id = $2`,
    [requestId, ctx.actor.organizationId]
  )
  const found = requireRow(row, 'Purchase request')
  const [items, approval, documents] = await Promise.all([
    loadItems(c, requestId),
    loadApproval(c, found.approvalInstanceId),
    listDocumentLinks(c, storage, ctx, 'purchase_request', requestId)
  ])
  const totalMinor = items.reduce((s, i) => s + i.lineTotalMinor, 0)
  return { ...found, totalMinor, items, approval, documents }
}

async function validateItems(c: SqlClient, org: string, currency: string, items: SaveRequestDraftInput['items']): Promise<{ categoryId: string | null; modelId: string | null; description: string; quantity: number; estimatedUnitCostMinor: number; lineTotalMinor: number }[]> {
  const out: { categoryId: string | null; modelId: string | null; description: string; quantity: number; estimatedUnitCostMinor: number; lineTotalMinor: number }[] = []
  for (const it of items) {
    if (it.categoryId) {
      const cat = await c.one<{ a: boolean }>('SELECT is_active AS a FROM asset_categories WHERE id = $1 AND organization_id = $2', [it.categoryId, org])
      if (!cat) invalid('categoryId', 'Category not found')
    }
    if (it.modelId) {
      const m = await c.one<{ c: string }>('SELECT category_id AS c FROM asset_models WHERE id = $1 AND organization_id = $2', [it.modelId, org])
      if (!m) invalid('modelId', 'Model not found')
      if (it.categoryId && m.c !== it.categoryId) invalid('modelId', 'The model belongs to a different category')
    }
    const unitCostMinor = parseMoneyToMinor(it.estimatedUnitCost, currency)
    if (unitCostMinor === null) invalid('estimatedUnitCost', `Enter an amount valid for ${currency}`)
    const lineTotalMinor = it.quantity * unitCostMinor!
    if (!Number.isSafeInteger(lineTotalMinor)) invalid('quantity', 'Quantity and cost combine to an amount too large to record')
    out.push({ categoryId: it.categoryId, modelId: it.modelId, description: it.description, quantity: it.quantity, estimatedUnitCostMinor: unitCostMinor!, lineTotalMinor })
  }
  return out
}

export async function saveRequestDraft(db: Db, storage: DocumentStorage, raw: SaveRequestDraftInput, ctx: OpContext): Promise<PurchaseRequestDetail> {
  assertPermission(ctx.actor.permissions, 'procurement.create')
  const input = saveRequestDraftSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const items = await validateItems(t, org, input.currency, input.items)
    if (input.departmentId) {
      const d = await t.one<{ a: boolean }>('SELECT is_active AS a FROM departments WHERE id = $1 AND organization_id = $2', [input.departmentId, org])
      if (!d) invalid('departmentId', 'Department not found')
    }
    if (input.teamId) {
      const tm = await t.one<{ a: boolean }>('SELECT is_active AS a FROM teams WHERE id = $1 AND organization_id = $2', [input.teamId, org])
      if (!tm) invalid('teamId', 'Team not found')
    }
    let requestId = input.requestId
    if (requestId) {
      const locked = await t.one<{ status: string; requesterUserId: string }>('SELECT status, requester_user_id AS "requesterUserId" FROM purchase_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE', [requestId, org])
      const found = requireRow(locked, 'Purchase request')
      if (found.status !== 'draft') conflict('Only a draft request can be edited. Submitted requests follow the amendment or resubmission workflow.')
      if (found.requesterUserId !== ctx.actor.userId) throw new AppError('PERMISSION_DENIED', 'You can only edit your own draft requests.')
      await t.exec('UPDATE purchase_requests SET department_id = $2, team_id = $3, justification = $4, required_by_date = $5, currency = $6, updated_at = now() WHERE id = $1', [
        requestId, input.departmentId, input.teamId, input.justification, input.requiredByDate, input.currency
      ])
      await t.exec('DELETE FROM purchase_request_items WHERE request_id = $1', [requestId])
    } else {
      requestId = newId()
      const number = await nextW6Number(t, org, 'request')
      await t.exec(
        `INSERT INTO purchase_requests (id, organization_id, request_number, requester_user_id, department_id, team_id, justification, required_by_date, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [requestId, org, number, ctx.actor.userId, input.departmentId, input.teamId, input.justification, input.requiredByDate, input.currency]
      )
    }
    let lineNo = 1
    for (const it of items) {
      await t.exec(
        `INSERT INTO purchase_request_items (id, organization_id, request_id, line_no, description, category_id, model_id, quantity, estimated_unit_cost_minor, line_total_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [newId(), org, requestId, lineNo++, it.description, it.categoryId, it.modelId, it.quantity, it.estimatedUnitCostMinor, it.lineTotalMinor]
      )
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: input.requestId ? 'procurement.request_updated' : 'procurement.request_created', entityType: 'purchase_request', entityId: requestId, summary: { itemCount: items.length } })
    return getRequest(t, storage, requestId, ctx, true)
  })
}

async function resolvePolicy(t: SqlClient, org: string, transactionType: string, amountMinor: number, currency: string): Promise<{ id: string; totalSteps: number } | null> {
  const rows = await t.many<{ id: string; minAmountMinor: number | null; currency: string | null; stepCount: string }>(
    `SELECT p.id, p.min_amount_minor AS "minAmountMinor", p.currency, (SELECT COUNT(*) FROM approval_policy_steps WHERE policy_id = p.id) AS "stepCount"
     FROM approval_policies p WHERE p.organization_id = $1 AND p.transaction_type = $2 AND p.is_current AND p.is_active`,
    [org, transactionType]
  )
  const applicable = rows.filter((r) => r.minAmountMinor === null || (r.currency === currency && amountMinor >= r.minAmountMinor))
  if (applicable.length === 0) return null
  applicable.sort((a, b) => (b.minAmountMinor ?? -1) - (a.minAmountMinor ?? -1))
  const chosen = applicable[0]!
  if (Number(chosen.stepCount) < 1) return null
  return { id: chosen.id, totalSteps: Number(chosen.stepCount) }
}

export async function submitRequest(db: Db, storage: DocumentStorage, raw: SubmitRequestInput, ctx: OpContext): Promise<PurchaseRequestDetail> {
  assertPermission(ctx.actor.permissions, 'procurement.submit')
  const input = submitRequestSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const locked = await t.one<{ status: string; requesterUserId: string; currency: string }>('SELECT status, requester_user_id AS "requesterUserId", currency FROM purchase_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE', [input.requestId, org])
    const found = requireRow(locked, 'Purchase request')
    if (found.requesterUserId !== ctx.actor.userId) throw new AppError('PERMISSION_DENIED', 'You can only submit your own requests.')
    if (found.status !== 'draft') conflict('Only a draft request can be submitted.')
    const itemCount = (await t.one<{ n: string }>('SELECT COUNT(*) AS n FROM purchase_request_items WHERE request_id = $1', [input.requestId]))!.n
    if (Number(itemCount) === 0) conflict('Add at least one line item before submitting.')
    const total = await requestTotal(t, input.requestId)
    const policy = await resolvePolicy(t, org, 'purchase_request', total, found.currency)
    if (!policy) conflict('No active approval policy covers this request. Configure an approval policy before submitting purchase requests.')
    const instanceId = newId()
    await t.exec(
      `INSERT INTO approval_instances (id, organization_id, entity_type, entity_id, policy_id, requester_user_id, total_steps) VALUES ($1, $2, 'purchase_request', $3, $4, $5, $6)`,
      [instanceId, org, input.requestId, policy.id, ctx.actor.userId, policy.totalSteps]
    )
    await t.exec('UPDATE purchase_requests SET status = \'submitted\', submitted_at = now(), approval_instance_id = $2, updated_at = now() WHERE id = $1', [input.requestId, instanceId])
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'procurement.request_submitted', entityType: 'purchase_request', entityId: input.requestId, summary: { policyId: policy.id, totalSteps: policy.totalSteps, totalMinor: total } })
    return getRequest(t, storage, input.requestId, ctx, true)
  })
}

export async function cancelRequest(db: Db, storage: DocumentStorage, raw: CancelRequestInput, ctx: OpContext): Promise<PurchaseRequestDetail> {
  const input = cancelRequestSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const locked = await t.one<{ status: string; requesterUserId: string; approvalInstanceId: string | null }>(
      'SELECT status, requester_user_id AS "requesterUserId", approval_instance_id AS "approvalInstanceId" FROM purchase_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [input.requestId, org]
    )
    const found = requireRow(locked, 'Purchase request')
    const isOwner = found.requesterUserId === ctx.actor.userId
    if (isOwner) assertPermission(ctx.actor.permissions, 'procurement.create')
    else assertPermission(ctx.actor.permissions, 'procurement.approve')
    if (found.status !== 'draft' && found.status !== 'submitted') conflict(`A ${found.status} request cannot be cancelled.`)
    await t.exec('UPDATE purchase_requests SET status = \'cancelled\', cancel_reason = $2, decided_at = now(), updated_at = now() WHERE id = $1', [input.requestId, input.reason])
    if (found.approvalInstanceId) {
      await t.exec('UPDATE approval_instances SET status = \'cancelled\', decided_at = now() WHERE id = $1 AND status = \'pending\'', [found.approvalInstanceId])
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'procurement.request_cancelled', entityType: 'purchase_request', entityId: input.requestId, reason: input.reason })
    return getRequest(t, storage, input.requestId, ctx, true)
  })
}

// ---------------------------------------------------------------- approval policy administration

async function loadPolicySummary(c: SqlClient, policyId: string): Promise<ApprovalPolicySummary> {
  const p = requireRow(
    await c.one<Omit<ApprovalPolicySummary, 'steps'>>(
      `SELECT id, policy_group_id AS "policyGroupId", version, transaction_type AS "transactionType", name, min_amount_minor AS "minAmountMinor",
              currency, prevent_self_approval AS "preventSelfApproval", is_active AS "isActive", is_current AS "isCurrent"
       FROM approval_policies WHERE id = $1`,
      [policyId]
    ),
    'Approval policy'
  )
  const steps = await c.many<ApprovalPolicySummary['steps'][number]>(
    `SELECT s.step_order AS "stepOrder", s.required_role_key AS "requiredRoleKey", r.name AS "requiredRoleName",
            s.required_user_id AS "requiredUserId", u.display_name AS "requiredUserName"
     FROM approval_policy_steps s LEFT JOIN roles r ON r.organization_id = s.organization_id AND r.key = s.required_role_key
       LEFT JOIN users u ON u.id = s.required_user_id WHERE s.policy_id = $1 ORDER BY s.step_order`,
    [policyId]
  )
  return { ...p, minAmountMinor: p.minAmountMinor === null ? null : Number(p.minAmountMinor), steps }
}

async function validateSteps(c: SqlClient, org: string, steps: ApprovalStepInput[]): Promise<void> {
  for (const s of steps) {
    if (s.requiredRoleKey) {
      const r = await c.one<{ id: string }>('SELECT id FROM roles WHERE organization_id = $1 AND key = $2', [org, s.requiredRoleKey])
      if (!r) invalid('requiredRoleKey', `Role "${s.requiredRoleKey}" not found`)
    }
    if (s.requiredUserId) {
      const u = await c.one<{ a: boolean }>('SELECT is_active AS a FROM users WHERE id = $1 AND organization_id = $2', [s.requiredUserId, org])
      if (!u) invalid('requiredUserId', 'User not found')
      if (!u.a) invalid('requiredUserId', 'User is deactivated')
    }
  }
}

export async function saveApprovalPolicy(db: Db, raw: SaveApprovalPolicyInput, ctx: OpContext): Promise<ApprovalPolicySummary> {
  assertPermission(ctx.actor.permissions, 'approvals.configure')
  const input = saveApprovalPolicySchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    await validateSteps(t, org, input.steps)
    const minAmountMinor = input.minAmount === null ? null : parseMoneyToMinor(input.minAmount, input.currency!)
    if (input.minAmount !== null && minAmountMinor === null) invalid('minAmount', `Enter an amount valid for ${input.currency}`)
    const policyGroupId = input.policyGroupId ?? newId()
    let version = 1
    if (input.policyGroupId) {
      const prev = await t.one<{ v: number }>('SELECT version AS v FROM approval_policies WHERE policy_group_id = $1 AND organization_id = $2 AND is_current FOR UPDATE', [input.policyGroupId, org])
      if (!prev) invalid('policyGroupId', 'Policy not found')
      version = prev.v + 1
      await t.exec('UPDATE approval_policies SET is_current = false WHERE policy_group_id = $1 AND organization_id = $2 AND is_current', [input.policyGroupId, org])
    }
    const id = newId()
    await t.exec(
      `INSERT INTO approval_policies (id, organization_id, policy_group_id, version, transaction_type, name, min_amount_minor, currency, prevent_self_approval, is_active, is_current, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11)`,
      [id, org, policyGroupId, version, input.transactionType, input.name, minAmountMinor, input.currency, input.preventSelfApproval, input.isActive, ctx.actor.userId]
    )
    let stepOrder = 1
    for (const s of input.steps) {
      await t.exec('INSERT INTO approval_policy_steps (id, organization_id, policy_id, step_order, required_role_key, required_user_id) VALUES ($1, $2, $3, $4, $5, $6)', [
        newId(), org, id, stepOrder++, s.requiredRoleKey, s.requiredUserId
      ])
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: 'approvals.policy_saved', entityType: 'approval_policy', entityId: id, summary: { policyGroupId, version, stepCount: input.steps.length } })
    return loadPolicySummary(t, id)
  })
}

export async function listApprovalPolicies(c: SqlClient, raw: PolicyListInput, ctx: OpContext): Promise<ApprovalPolicySummary[]> {
  assertPermission(ctx.actor.permissions, 'approvals.configure')
  const input = policyListSchema.parse(raw)
  const org = ctx.actor.organizationId
  const rows = await c.many<{ id: string }>(
    `SELECT id FROM approval_policies WHERE organization_id = $1 ${input.transactionType ? 'AND transaction_type = $2' : ''} ORDER BY transaction_type, policy_group_id, version DESC`,
    input.transactionType ? [org, input.transactionType] : [org]
  )
  const out: ApprovalPolicySummary[] = []
  for (const r of rows) out.push(await loadPolicySummary(c, r.id))
  return out
}

// ---------------------------------------------------------------- approval decisions

export async function decideApproval(db: Db, storage: DocumentStorage, raw: DecideApprovalInput, ctx: OpContext): Promise<PurchaseRequestDetail> {
  assertPermission(ctx.actor.permissions, 'procurement.approve')
  const input = decideApprovalSchema.parse(raw)
  const org = ctx.actor.organizationId
  return db.tx(async (t) => {
    const instance = await t.one<{ id: string; status: string; currentStep: number; totalSteps: number; policyId: string; requesterUserId: string; entityId: string; preventSelfApproval: boolean }>(
      `SELECT ai.id, ai.status, ai.current_step AS "currentStep", ai.total_steps AS "totalSteps", ai.policy_id AS "policyId",
              ai.requester_user_id AS "requesterUserId", ai.entity_id AS "entityId", p.prevent_self_approval AS "preventSelfApproval"
       FROM approval_instances ai JOIN approval_policies p ON p.id = ai.policy_id WHERE ai.id = $1 AND ai.organization_id = $2 FOR UPDATE OF ai`,
      [input.instanceId, org]
    )
    const found = requireRow(instance, 'Approval instance')
    if (found.status !== 'pending') conflict('This approval has already been decided or cancelled.')
    if (found.preventSelfApproval && found.requesterUserId === ctx.actor.userId) {
      throw new AppError('PERMISSION_DENIED', 'You cannot approve your own request.')
    }
    const step = requireRow(
      await t.one<{ requiredRoleKey: string | null; requiredUserId: string | null }>(
        'SELECT required_role_key AS "requiredRoleKey", required_user_id AS "requiredUserId" FROM approval_policy_steps WHERE policy_id = $1 AND step_order = $2',
        [found.policyId, found.currentStep]
      ),
      'Approval step'
    )
    const eligible = step.requiredUserId ? step.requiredUserId === ctx.actor.userId : await actorHoldsRole(t, org, ctx.actor.userId, step.requiredRoleKey!)
    if (!eligible) throw new AppError('PERMISSION_DENIED', 'You are not the required approver for the current step.')
    try {
      await t.exec('INSERT INTO approval_decisions (id, organization_id, instance_id, step_order, decided_by, decision, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
        newId(), org, input.instanceId, found.currentStep, ctx.actor.userId, input.decision, input.reason
      ])
    } catch (err) {
      if (pgErrorCode(err) === '23505') conflict('This step was already decided by another request just now.')
      throw err
    }
    if (input.decision === 'rejected') {
      await t.exec('UPDATE approval_instances SET status = \'rejected\', decided_at = now() WHERE id = $1', [input.instanceId])
      await t.exec('UPDATE purchase_requests SET status = \'rejected\', decided_at = now(), updated_at = now() WHERE id = $1', [found.entityId])
    } else if (found.currentStep >= found.totalSteps) {
      await t.exec('UPDATE approval_instances SET status = \'approved\', decided_at = now() WHERE id = $1', [input.instanceId])
      await t.exec('UPDATE purchase_requests SET status = \'approved\', decided_at = now(), updated_at = now() WHERE id = $1', [found.entityId])
    } else {
      await t.exec('UPDATE approval_instances SET current_step = current_step + 1 WHERE id = $1', [input.instanceId])
    }
    await recordAudit(t, { ...auditFrom(ctx), eventType: `procurement.approval_${input.decision}`, entityType: 'purchase_request', entityId: found.entityId, reason: input.reason, summary: { instanceId: input.instanceId, stepOrder: found.currentStep } })
    return getRequest(t, storage, found.entityId, ctx, true)
  })
}

export async function listApprovalQueue(c: SqlClient, raw: ApprovalQueueInput, ctx: OpContext): Promise<Page<ApprovalQueueItem>> {
  assertPermission(ctx.actor.permissions, 'procurement.approve')
  const input = approvalQueueSchema.parse(raw)
  const org = ctx.actor.organizationId
  const rows = await c.many<ApprovalQueueItem & { requiredRoleKey: string | null; requiredUserId: string | null; preventSelfApproval: boolean; requesterUserId: string }>(
    `SELECT ai.id AS "instanceId", r.id AS "requestId", r.request_number AS "requestNumber", ru.display_name AS "requesterName", r.justification,
            COALESCE((SELECT SUM(line_total_minor) FROM purchase_request_items WHERE request_id = r.id), 0)::bigint AS "totalMinor",
            r.currency, ai.current_step AS "stepOrder", r.submitted_at AS "submittedAt",
            s.required_role_key AS "requiredRoleKey", s.required_user_id AS "requiredUserId", p.prevent_self_approval AS "preventSelfApproval", ai.requester_user_id AS "requesterUserId"
     FROM approval_instances ai
     JOIN purchase_requests r ON r.id = ai.entity_id
     LEFT JOIN users ru ON ru.id = r.requester_user_id
     JOIN approval_policy_steps s ON s.policy_id = ai.policy_id AND s.step_order = ai.current_step
     JOIN approval_policies p ON p.id = ai.policy_id
     WHERE ai.organization_id = $1 AND ai.status = 'pending'
     ORDER BY ai.created_at`,
    [org]
  )
  const eligible: ApprovalQueueItem[] = []
  for (const r of rows) {
    if (r.preventSelfApproval && r.requesterUserId === ctx.actor.userId) continue
    const match = r.requiredUserId ? r.requiredUserId === ctx.actor.userId : await actorHoldsRole(c, org, ctx.actor.userId, r.requiredRoleKey!)
    if (match) eligible.push({ instanceId: r.instanceId, requestId: r.requestId, requestNumber: r.requestNumber, requesterName: r.requesterName, justification: r.justification, totalMinor: Number(r.totalMinor), currency: r.currency, stepOrder: r.stepOrder, submittedAt: r.submittedAt })
  }
  const start = (input.page - 1) * input.pageSize
  return { items: eligible.slice(start, start + input.pageSize), total: eligible.length, page: input.page, pageSize: input.pageSize }
}
