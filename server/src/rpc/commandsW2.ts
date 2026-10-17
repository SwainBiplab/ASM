import { z } from 'zod'
import {
  assetCodeConfigSchema,
  assetImportCommitInputSchema,
  assetImportPreviewInputSchema,
  assetImportRefSchema,
  assetLookupSchema,
  assetSearchSchema,
  catalogListSchema,
  catalogSetActiveSchema,
  changeLifecycleSchema,
  createAssetSchema,
  createCategorySchema,
  createModelSchema,
  createSupplierSchema,
  labelRequestSchema,
  removeDocumentLinkSchema,
  updateAssetSchema,
  updateCategorySchema,
  updateModelSchema,
  updateSupplierSchema
} from '@shared/assetSchemas'
import {
  createDepartmentSchema,
  createEmployeeSchema,
  createLocationSchema,
  createPoolSchema,
  createTeamSchema,
  createWorkstationSchema,
  deactivateEmployeeSchema,
  employeeSearchSchema,
  idInputSchema,
  importCommitInputSchema,
  importPreviewInputSchema,
  importRefSchema,
  listInputSchema,
  reactivateEmployeeSchema,
  setActiveInputSchema,
  teamListInputSchema,
  updateDepartmentSchema,
  updateEmployeeSchema,
  updateLocationSchema,
  updatePoolSchema,
  updateTeamSchema,
  updateWorkstationSchema,
  workstationListInputSchema
} from '@shared/orgSchemas'
import { referenceImportCommitInputSchema, referenceImportPreviewInputSchema, referenceImportRefSchema } from '@shared/referenceImportSchemas'
import { voidInputSchema } from '@shared/schemas'
import { AppError, type OpContext } from '../core'
import type { DocumentStorage } from '../storage/storage'
import { cancelEmployeeImport, commitEmployeeImport, previewEmployeeImport } from '../imports/employeeImport'
import { cancelAssetImport, commitAssetImport, previewAssetImport } from '../imports/assetImport'
import { cancelReferenceImport, commitReferenceImport, previewReferenceImport } from '../imports/referenceImport'
import * as assets from '../services/assets'
import * as catalog from '../services/catalog'
import { removeDocumentLink } from '../services/documents'
import * as employees from '../services/employees'
import { generateLabels } from '../services/labels'
import * as org from '../services/organization'
import type { CommandDefinition, HandlerContext } from './dispatcher'
import { nullOutput, pageOf } from './responses'
import * as out from './responsesW2'

export { W2_COMMANDS } from './commandNames'
import type { W2CommandName } from './commandNames'

function op(ctx: HandlerContext): OpContext {
  if (!ctx.actor) throw new AppError('NOT_AUTHENTICATED', 'Please sign in.')
  return { correlationId: ctx.correlationId, actor: ctx.actor, ip: ctx.http.ip }
}

const session = 'session' as const
const optional = 'optional' as const

export function buildW2Commands(storage: DocumentStorage): { [K in W2CommandName]: CommandDefinition<K> } {
  return {
    // ---- organization
    'departments.list': { input: listInputSchema, output: z.array(out.departmentOutput), auth: session, handler: (i, c) => org.listDepartments(c.db, i, op(c)) },
    'departments.create': { input: createDepartmentSchema, output: out.departmentOutput, auth: session, idempotency: optional, handler: (i, c) => org.createDepartment(c.db, i, op(c)) },
    'departments.update': { input: updateDepartmentSchema, output: out.departmentOutput, auth: session, idempotency: optional, handler: (i, c) => org.updateDepartment(c.db, i, op(c)) },
    'departments.setActive': { input: setActiveInputSchema, output: out.departmentOutput, auth: session, idempotency: optional, handler: (i, c) => org.setDepartmentActive(c.db, i, op(c)) },
    'teams.list': { input: teamListInputSchema, output: z.array(out.teamOutput), auth: session, handler: (i, c) => org.listTeams(c.db, i, op(c)) },
    'teams.create': { input: createTeamSchema, output: out.teamOutput, auth: session, idempotency: optional, handler: (i, c) => org.createTeam(c.db, i, op(c)) },
    'teams.update': { input: updateTeamSchema, output: out.teamOutput, auth: session, idempotency: optional, handler: (i, c) => org.updateTeam(c.db, i, op(c)) },
    'teams.setActive': { input: setActiveInputSchema, output: out.teamOutput, auth: session, idempotency: optional, handler: (i, c) => org.setTeamActive(c.db, i, op(c)) },
    'locations.list': { input: listInputSchema, output: z.array(out.locationOutput), auth: session, handler: (i, c) => org.listLocations(c.db, i, op(c)) },
    'locations.create': { input: createLocationSchema, output: out.locationOutput, auth: session, idempotency: optional, handler: (i, c) => org.createLocation(c.db, i, op(c)) },
    'locations.update': { input: updateLocationSchema, output: out.locationOutput, auth: session, idempotency: optional, handler: (i, c) => org.updateLocation(c.db, i, op(c)) },
    'locations.setActive': { input: setActiveInputSchema, output: out.locationOutput, auth: session, idempotency: optional, handler: (i, c) => org.setLocationActive(c.db, i, op(c)) },
    'workstations.list': { input: workstationListInputSchema, output: z.array(out.workstationOutput), auth: session, handler: (i, c) => org.listWorkstations(c.db, i, op(c)) },
    'workstations.create': { input: createWorkstationSchema, output: out.workstationOutput, auth: session, idempotency: optional, handler: (i, c) => org.createWorkstation(c.db, i, op(c)) },
    'workstations.update': { input: updateWorkstationSchema, output: out.workstationOutput, auth: session, idempotency: optional, handler: (i, c) => org.updateWorkstation(c.db, i, op(c)) },
    'workstations.setActive': { input: setActiveInputSchema, output: out.workstationOutput, auth: session, idempotency: optional, handler: (i, c) => org.setWorkstationActive(c.db, i, op(c)) },
    'pools.list': { input: listInputSchema, output: z.array(out.poolOutput), auth: session, handler: (i, c) => org.listPools(c.db, i, op(c)) },
    'pools.create': { input: createPoolSchema, output: out.poolOutput, auth: session, idempotency: optional, handler: (i, c) => org.createPool(c.db, i, op(c)) },
    'pools.update': { input: updatePoolSchema, output: out.poolOutput, auth: session, idempotency: optional, handler: (i, c) => org.updatePool(c.db, i, op(c)) },
    'pools.setActive': { input: setActiveInputSchema, output: out.poolOutput, auth: session, idempotency: optional, handler: (i, c) => org.setPoolActive(c.db, i, op(c)) },

    // ---- employees
    'employees.search': { input: employeeSearchSchema, output: pageOf(out.employeeListItemOutput), auth: session, handler: (i, c) => employees.searchEmployees(c.db, i, op(c)) },
    'employees.get': { input: idInputSchema, output: out.employeeDetailOutput, auth: session, handler: (i, c) => employees.getEmployee(c.db, i.id, op(c)) },
    'employees.create': { input: createEmployeeSchema, output: out.employeeDetailOutput, auth: session, idempotency: optional, handler: (i, c) => employees.createEmployee(c.db, i, op(c)) },
    'employees.update': { input: updateEmployeeSchema, output: out.employeeDetailOutput, auth: session, idempotency: optional, handler: (i, c) => employees.updateEmployee(c.db, i, op(c)) },
    'employees.deactivate': { input: deactivateEmployeeSchema, output: out.employeeDetailOutput, auth: session, idempotency: optional, handler: (i, c) => employees.deactivateEmployee(c.db, i, op(c)) },
    'employees.reactivate': { input: reactivateEmployeeSchema, output: out.employeeDetailOutput, auth: session, idempotency: optional, handler: (i, c) => employees.reactivateEmployee(c.db, i, op(c)) },
    'employees.importPreview': { input: importPreviewInputSchema, output: out.importPreviewOutput, auth: session, handler: (i, c) => previewEmployeeImport(c.db, i, op(c)) },
    'employees.importCommit': { input: importCommitInputSchema, output: out.importResultOutput, auth: session, idempotency: 'required', handler: (i, c) => commitEmployeeImport(c.db, i, op(c)) },
    'employees.importCancel': {
      input: importRefSchema,
      output: nullOutput,
      auth: session,
      handler: async (i, c) => {
        await cancelEmployeeImport(c.db, i.importId, op(c))
        return null
      }
    },

    // ---- catalogue
    'categories.list': { input: catalogListSchema, output: z.array(out.categoryOutput), auth: session, handler: (i, c) => catalog.listCategories(c.db, i, op(c)) },
    'categories.create': { input: createCategorySchema, output: out.categoryOutput, auth: session, idempotency: optional, handler: (i, c) => catalog.createCategory(c.db, i, op(c)) },
    'categories.update': { input: updateCategorySchema, output: out.categoryOutput, auth: session, idempotency: optional, handler: (i, c) => catalog.updateCategory(c.db, i, op(c)) },
    'categories.setActive': { input: catalogSetActiveSchema, output: out.categoryOutput, auth: session, idempotency: optional, handler: (i, c) => catalog.setCategoryActive(c.db, i, op(c)) },
    'models.list': { input: catalogListSchema, output: z.array(out.modelOutput), auth: session, handler: (i, c) => catalog.listModels(c.db, i, op(c)) },
    'models.create': { input: createModelSchema, output: out.modelOutput, auth: session, idempotency: optional, handler: (i, c) => catalog.createModel(c.db, i, op(c)) },
    'models.update': { input: updateModelSchema, output: out.modelOutput, auth: session, idempotency: optional, handler: (i, c) => catalog.updateModel(c.db, i, op(c)) },
    'models.setActive': { input: catalogSetActiveSchema, output: out.modelOutput, auth: session, idempotency: optional, handler: (i, c) => catalog.setModelActive(c.db, i, op(c)) },
    'suppliers.list': { input: catalogListSchema, output: z.array(out.supplierOutput), auth: session, handler: (i, c) => catalog.listSuppliers(c.db, i, op(c)) },
    'suppliers.create': { input: createSupplierSchema, output: out.supplierOutput, auth: session, idempotency: optional, handler: (i, c) => catalog.createSupplier(c.db, i, op(c)) },
    'suppliers.update': { input: updateSupplierSchema, output: out.supplierOutput, auth: session, idempotency: optional, handler: (i, c) => catalog.updateSupplier(c.db, i, op(c)) },
    'suppliers.setActive': { input: catalogSetActiveSchema, output: out.supplierOutput, auth: session, idempotency: optional, handler: (i, c) => catalog.setSupplierActive(c.db, i, op(c)) },

    // ---- assets
    'assets.getCodeConfig': { input: voidInputSchema, output: out.assetCodeConfigOutput, auth: session, handler: (_i, c) => assets.getAssetCodeConfig(c.db, op(c)) },
    'assets.updateCodeConfig': { input: assetCodeConfigSchema, output: out.assetCodeConfigOutput, auth: session, idempotency: optional, handler: (i, c) => assets.updateAssetCodeConfig(c.db, i, op(c)) },
    'assets.search': { input: assetSearchSchema, output: pageOf(out.assetListItemOutput), auth: session, handler: (i, c) => assets.searchAssets(c.db, i, op(c)) },
    'assets.get': { input: idInputSchema, output: out.assetDetailOutput, auth: session, handler: (i, c) => assets.getAsset(c.db, storage, i.id, op(c)) },
    // A retried create must not register a second asset (D36).
    'assets.create': { input: createAssetSchema, output: out.assetDetailOutput, auth: session, idempotency: 'required', handler: (i, c) => assets.createAsset(c.db, storage, i, op(c)) },
    'assets.update': { input: updateAssetSchema, output: out.assetDetailOutput, auth: session, idempotency: optional, handler: (i, c) => assets.updateAsset(c.db, storage, i, op(c)) },
    'assets.changeLifecycle': { input: changeLifecycleSchema, output: out.assetDetailOutput, auth: session, idempotency: optional, handler: (i, c) => assets.changeLifecycle(c.db, storage, i, op(c)) },
    'assets.lookup': { input: assetLookupSchema, output: out.assetLookupOutput, auth: session, handler: (i, c) => assets.lookupAsset(c.db, i, op(c)) },
    'assets.generateLabels': { input: labelRequestSchema, output: z.array(out.assetLabelOutput), auth: session, handler: (i, c) => generateLabels(c.db, i, op(c)) },
    'assets.importPreview': { input: assetImportPreviewInputSchema, output: out.assetImportPreviewOutput, auth: session, handler: (i, c) => previewAssetImport(c.db, i, op(c)) },
    'assets.importCommit': { input: assetImportCommitInputSchema, output: out.importResultOutput, auth: session, idempotency: 'required', handler: (i, c) => commitAssetImport(c.db, i, op(c)) },
    'assets.importCancel': {
      input: assetImportRefSchema,
      output: nullOutput,
      auth: session,
      handler: async (i, c) => {
        await cancelAssetImport(c.db, i.importId, op(c))
        return null
      }
    },
    'referenceData.importPreview': { input: referenceImportPreviewInputSchema, output: out.referenceImportPreviewOutput, auth: session, handler: (i, c) => previewReferenceImport(c.db, i, op(c)) },
    'referenceData.importCommit': { input: referenceImportCommitInputSchema, output: out.importResultOutput, auth: session, idempotency: 'required', handler: (i, c) => commitReferenceImport(c.db, i, op(c)) },
    'referenceData.importCancel': {
      input: referenceImportRefSchema,
      output: nullOutput,
      auth: session,
      handler: async (i, c) => {
        await cancelReferenceImport(c.db, i.importId, op(c))
        return null
      }
    },

    // ---- documents (upload/download are HTTP routes, D35)
    'documents.removeLink': {
      input: removeDocumentLinkSchema,
      output: nullOutput,
      auth: session,
      idempotency: optional,
      handler: async (i, c) => {
        await removeDocumentLink(c.db, i, op(c))
        return null
      }
    }
  }
}
