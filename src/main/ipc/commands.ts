import {
  auditListInputSchema,
  backupRefInputSchema,
  changePasswordInputSchema,
  createUserInputSchema,
  loginInputSchema,
  resetPasswordInputSchema,
  restoreInputSchema,
  settingsUpdateInputSchema,
  setupInputSchema,
  unlockInputSchema,
  updateRolePermissionsInputSchema,
  updateUserInputSchema,
  voidInputSchema
} from '@shared/schemas'
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
import { copyFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  assetCodeConfigSchema,
  assetLookupSchema,
  assetSearchSchema,
  attachDocumentSchema,
  catalogListSchema,
  catalogSetActiveSchema,
  changeLifecycleSchema,
  createAssetSchema,
  createCategorySchema,
  createModelSchema,
  createSupplierSchema,
  documentRefSchema,
  labelRequestSchema,
  removeDocumentLinkSchema,
  updateAssetSchema,
  updateCategorySchema,
  updateModelSchema,
  updateSupplierSchema
} from '@shared/assetSchemas'
import type { AppContainer } from '../app/container'
import { AppError } from '../app/errors'
import { assertPermission } from '../auth/permissions'
import { sqliteVersion } from '../database/connection'
import { listAuditEvents } from '../services/audit'
import { getDashboardSummary } from '../services/dashboard'
import { getSettings, updateSettings } from '../services/settings'
import { completeSetup, getOrganizationName } from '../services/setup'
import { createEmployee, deactivateEmployee, getEmployee, reactivateEmployee, searchEmployees, updateEmployee } from '../services/employees'
import * as org from '../services/organization'
import * as catalog from '../services/catalog'
import * as assets from '../services/assets'
import { attachDocument, removeDocumentLink, resolveDocument } from '../services/documents'
import { generateLabels } from '../services/labels'
import { toCsv } from '../import/csvExport'
import { recordAudit } from '../services/audit'
import { createUser, listRoles, listUsers, resetUserPassword, updateRolePermissions, updateUser } from '../services/users'
import { requireOp, type CommandTable } from './dispatcher'

/** Wires every allow-listed command to its schema, auth mode and service call. */
export function buildCommands(c: AppContainer): CommandTable {
  const db = () => c.dbm.db
  return {
    'system.getStartupState': { input: voidInputSchema, auth: 'public', handler: () => c.startup },
    'system.getInfo': {
      input: voidInputSchema,
      auth: 'session',
      handler: () => ({
        appVersion: c.meta.appVersion,
        environment: c.meta.environment,
        electronVersion: c.meta.versions.electron,
        chromeVersion: c.meta.versions.chrome,
        nodeVersion: c.meta.versions.node,
        sqliteVersion: sqliteVersion(db()),
        schemaVersion: c.dbm.schemaVersion(),
        platform: `${process.platform} ${process.arch}`,
        dataDirectory: c.paths.root,
        databasePath: c.paths.databaseFile,
        logDirectory: c.paths.logsDir,
        backupDirectory: c.paths.backupsDir,
        organizationName: getOrganizationName(db())
      })
    },
    'setup.complete': {
      input: setupInputSchema,
      auth: 'public',
      handler: async (input, ctx) => {
        const result = await completeSetup(db(), input, ctx.correlationId)
        c.refreshStartupStatus()
        return result
      }
    },
    'session.login': {
      input: loginInputSchema,
      auth: 'public',
      handler: (input, ctx) => {
        if (c.startup.status !== 'ready') throw new AppError('STATE_CONFLICT', 'Complete initial setup first.')
        return c.auth.login(input, ctx.correlationId)
      }
    },
    'session.logout': {
      input: voidInputSchema,
      auth: 'public',
      handler: (_i, ctx) => {
        if (c.dbm.isOpen) c.auth.logout(ctx.correlationId)
        else c.sessions.end()
        return null
      }
    },
    'session.getCurrent': { input: voidInputSchema, auth: 'public', handler: () => (c.dbm.isOpen ? c.auth.getCurrent() : null) },
    'session.touch': { input: voidInputSchema, auth: 'session', handler: () => null },
    'session.lock': {
      input: voidInputSchema,
      auth: 'locked',
      handler: () => {
        c.sessions.lock()
        return null
      }
    },
    'session.unlock': { input: unlockInputSchema, auth: 'locked', handler: (input, ctx) => c.auth.unlock(input, ctx.correlationId) },
    'session.changePassword': {
      input: changePasswordInputSchema,
      auth: 'session',
      handler: (input, ctx) => c.auth.changePassword(requireOp(ctx).actor.userId, input, ctx.correlationId)
    },
    'users.list': { input: voidInputSchema, auth: 'session', handler: (_i, ctx) => listUsers(db(), requireOp(ctx)) },
    'users.create': { input: createUserInputSchema, auth: 'session', handler: (input, ctx) => createUser(db(), input, requireOp(ctx)) },
    'users.update': { input: updateUserInputSchema, auth: 'session', handler: (input, ctx) => updateUser(db(), input, requireOp(ctx)) },
    'users.resetPassword': {
      input: resetPasswordInputSchema,
      auth: 'session',
      handler: async (input, ctx) => {
        await resetUserPassword(db(), input, requireOp(ctx))
        return null
      }
    },
    'roles.list': { input: voidInputSchema, auth: 'session', handler: (_i, ctx) => listRoles(db(), requireOp(ctx)) },
    'roles.updatePermissions': {
      input: updateRolePermissionsInputSchema,
      auth: 'session',
      handler: (input, ctx) => updateRolePermissions(db(), input, requireOp(ctx))
    },
    'audit.list': {
      input: auditListInputSchema,
      auth: 'session',
      handler: (input, ctx) => {
        assertPermission(requireOp(ctx).actor.permissions, 'audit_log.view')
        return listAuditEvents(db(), input)
      }
    },
    'settings.get': { input: voidInputSchema, auth: 'session', handler: () => getSettings(db()) },
    'settings.update': {
      input: settingsUpdateInputSchema,
      auth: 'session',
      handler: (input, ctx) => updateSettings(db(), input, requireOp(ctx))
    },
    'backup.create': { input: voidInputSchema, auth: 'session', handler: (_i, ctx) => c.backups.create(requireOp(ctx)) },
    'backup.list': { input: voidInputSchema, auth: 'session', handler: (_i, ctx) => c.backups.list(requireOp(ctx)) },
    'backup.validate': {
      input: backupRefInputSchema,
      auth: 'session',
      handler: (input, ctx) => c.backups.validate(input.backupId, requireOp(ctx))
    },
    'backup.restore': {
      input: restoreInputSchema,
      auth: 'session',
      handler: async (input, ctx) => {
        const op = requireOp(ctx)
        const me = db().prepare('SELECT username FROM users WHERE id = ?').get(op.actor.userId) as { username: string }
        const outcome = await c.backups.restore(input, op, me.username)
        // Restored data may contain different accounts; require a fresh sign-in.
        c.sessions.end()
        c.refreshStartupStatus()
        return outcome
      }
    },
    'dashboard.getSummary': {
      input: voidInputSchema,
      auth: 'session',
      touch: false,
      handler: async (_i, ctx) => {
        const backups = await c.backups.list()
        return getDashboardSummary(db(), backups[0] ?? null, assets.getAssetMetrics(db(), requireOp(ctx)))
      }
    },
    'departments.list': { input: listInputSchema, auth: 'session', handler: (i, ctx) => org.listDepartments(db(), i, requireOp(ctx)) },
    'departments.create': { input: createDepartmentSchema, auth: 'session', handler: (i, ctx) => org.createDepartment(db(), i, requireOp(ctx)) },
    'departments.update': { input: updateDepartmentSchema, auth: 'session', handler: (i, ctx) => org.updateDepartment(db(), i, requireOp(ctx)) },
    'departments.setActive': { input: setActiveInputSchema, auth: 'session', handler: (i, ctx) => org.setDepartmentActive(db(), i, requireOp(ctx)) },
    'teams.list': { input: teamListInputSchema, auth: 'session', handler: (i, ctx) => org.listTeams(db(), i, requireOp(ctx)) },
    'teams.create': { input: createTeamSchema, auth: 'session', handler: (i, ctx) => org.createTeam(db(), i, requireOp(ctx)) },
    'teams.update': { input: updateTeamSchema, auth: 'session', handler: (i, ctx) => org.updateTeam(db(), i, requireOp(ctx)) },
    'teams.setActive': { input: setActiveInputSchema, auth: 'session', handler: (i, ctx) => org.setTeamActive(db(), i, requireOp(ctx)) },
    'locations.list': { input: listInputSchema, auth: 'session', handler: (i, ctx) => org.listLocations(db(), i, requireOp(ctx)) },
    'locations.create': { input: createLocationSchema, auth: 'session', handler: (i, ctx) => org.createLocation(db(), i, requireOp(ctx)) },
    'locations.update': { input: updateLocationSchema, auth: 'session', handler: (i, ctx) => org.updateLocation(db(), i, requireOp(ctx)) },
    'locations.setActive': { input: setActiveInputSchema, auth: 'session', handler: (i, ctx) => org.setLocationActive(db(), i, requireOp(ctx)) },
    'workstations.list': { input: workstationListInputSchema, auth: 'session', handler: (i, ctx) => org.listWorkstations(db(), i, requireOp(ctx)) },
    'workstations.create': { input: createWorkstationSchema, auth: 'session', handler: (i, ctx) => org.createWorkstation(db(), i, requireOp(ctx)) },
    'workstations.update': { input: updateWorkstationSchema, auth: 'session', handler: (i, ctx) => org.updateWorkstation(db(), i, requireOp(ctx)) },
    'workstations.setActive': { input: setActiveInputSchema, auth: 'session', handler: (i, ctx) => org.setWorkstationActive(db(), i, requireOp(ctx)) },
    'pools.list': { input: listInputSchema, auth: 'session', handler: (i, ctx) => org.listPools(db(), i, requireOp(ctx)) },
    'pools.create': { input: createPoolSchema, auth: 'session', handler: (i, ctx) => org.createPool(db(), i, requireOp(ctx)) },
    'pools.update': { input: updatePoolSchema, auth: 'session', handler: (i, ctx) => org.updatePool(db(), i, requireOp(ctx)) },
    'pools.setActive': { input: setActiveInputSchema, auth: 'session', handler: (i, ctx) => org.setPoolActive(db(), i, requireOp(ctx)) },
    'employees.search': { input: employeeSearchSchema, auth: 'session', handler: (i, ctx) => searchEmployees(db(), i, requireOp(ctx)) },
    'employees.get': { input: idInputSchema, auth: 'session', handler: (i, ctx) => getEmployee(db(), i.id, requireOp(ctx)) },
    'employees.create': { input: createEmployeeSchema, auth: 'session', handler: (i, ctx) => createEmployee(db(), i, requireOp(ctx)) },
    'employees.update': { input: updateEmployeeSchema, auth: 'session', handler: (i, ctx) => updateEmployee(db(), i, requireOp(ctx)) },
    'employees.deactivate': { input: deactivateEmployeeSchema, auth: 'session', handler: (i, ctx) => deactivateEmployee(db(), i, requireOp(ctx)) },
    'employees.reactivate': { input: reactivateEmployeeSchema, auth: 'session', handler: (i, ctx) => reactivateEmployee(db(), i, requireOp(ctx)) },
    'employees.importSelectFile': {
      input: voidInputSchema,
      auth: 'session',
      handler: async (_i, ctx) => {
        const op = requireOp(ctx)
        assertPermission(op.actor.permissions, 'employees.import')
        const file = await c.pickImportFile()
        return file ? c.employeeImport.load(file.data, file.fileName, op) : null
      }
    },
    'employees.importPreview': { input: importPreviewInputSchema, auth: 'session', handler: (i, ctx) => c.employeeImport.preview(i, requireOp(ctx)) },
    'employees.importCommit': { input: importCommitInputSchema, auth: 'session', handler: (i, ctx) => c.employeeImport.commit(i, requireOp(ctx)) },
    'employees.importCancel': {
      input: importRefSchema,
      auth: 'session',
      handler: (i, ctx) => {
        c.employeeImport.cancel(i.importId, requireOp(ctx))
        return null
      }
    },
    'categories.list': { input: catalogListSchema, auth: 'session', handler: (i, ctx) => catalog.listCategories(db(), i, requireOp(ctx)) },
    'categories.create': { input: createCategorySchema, auth: 'session', handler: (i, ctx) => catalog.createCategory(db(), i, requireOp(ctx)) },
    'categories.update': { input: updateCategorySchema, auth: 'session', handler: (i, ctx) => catalog.updateCategory(db(), i, requireOp(ctx)) },
    'categories.setActive': { input: catalogSetActiveSchema, auth: 'session', handler: (i, ctx) => catalog.setCategoryActive(db(), i, requireOp(ctx)) },
    'models.list': { input: catalogListSchema, auth: 'session', handler: (i, ctx) => catalog.listModels(db(), i, requireOp(ctx)) },
    'models.create': { input: createModelSchema, auth: 'session', handler: (i, ctx) => catalog.createModel(db(), i, requireOp(ctx)) },
    'models.update': { input: updateModelSchema, auth: 'session', handler: (i, ctx) => catalog.updateModel(db(), i, requireOp(ctx)) },
    'models.setActive': { input: catalogSetActiveSchema, auth: 'session', handler: (i, ctx) => catalog.setModelActive(db(), i, requireOp(ctx)) },
    'suppliers.list': { input: catalogListSchema, auth: 'session', handler: (i, ctx) => catalog.listSuppliers(db(), i, requireOp(ctx)) },
    'suppliers.create': { input: createSupplierSchema, auth: 'session', handler: (i, ctx) => catalog.createSupplier(db(), i, requireOp(ctx)) },
    'suppliers.update': { input: updateSupplierSchema, auth: 'session', handler: (i, ctx) => catalog.updateSupplier(db(), i, requireOp(ctx)) },
    'suppliers.setActive': { input: catalogSetActiveSchema, auth: 'session', handler: (i, ctx) => catalog.setSupplierActive(db(), i, requireOp(ctx)) },
    'assets.getCodeConfig': { input: voidInputSchema, auth: 'session', handler: (_i, ctx) => assets.getAssetCodeConfig(db(), requireOp(ctx)) },
    'assets.updateCodeConfig': { input: assetCodeConfigSchema, auth: 'session', handler: (i, ctx) => assets.updateAssetCodeConfig(db(), i, requireOp(ctx)) },
    'assets.search': { input: assetSearchSchema, auth: 'session', handler: (i, ctx) => assets.searchAssets(db(), i, requireOp(ctx)) },
    'assets.get': { input: idInputSchema, auth: 'session', handler: (i, ctx) => assets.getAsset(db(), i.id, requireOp(ctx)) },
    'assets.create': { input: createAssetSchema, auth: 'session', handler: (i, ctx) => assets.createAsset(db(), i, requireOp(ctx)) },
    'assets.update': { input: updateAssetSchema, auth: 'session', handler: (i, ctx) => assets.updateAsset(db(), i, requireOp(ctx)) },
    'assets.changeLifecycle': { input: changeLifecycleSchema, auth: 'session', handler: (i, ctx) => assets.changeLifecycle(db(), i, requireOp(ctx)) },
    'assets.lookup': { input: assetLookupSchema, auth: 'session', handler: (i, ctx) => assets.lookupAsset(db(), i, requireOp(ctx)) },
    'assets.generateLabels': { input: labelRequestSchema, auth: 'session', handler: (i, ctx) => generateLabels(db(), i, requireOp(ctx)) },
    'assets.export': {
      input: assetSearchSchema,
      auth: 'session',
      handler: async (i, ctx) => {
        const op = requireOp(ctx)
        const data = assets.exportAssetRows(db(), i, op)
        const path = await c.pickSavePath(`assets-${new Date().toISOString().slice(0, 10)}.csv`)
        if (!path) return { saved: false, rowCount: data.rows.length, fileName: null }
        await writeFile(path, toCsv(data.headers, data.rows), 'utf8')
        // Exports are security-relevant: record who exported what, without the data itself.
        recordAudit(db(), {
          actorUserId: op.actor.userId,
          eventType: 'assets.exported',
          entityType: 'asset_export',
          correlationId: op.correlationId,
          summary: { rowCount: data.rows.length, includesCost: data.includesCost, filters: i as Record<string, unknown> }
        })
        return { saved: true, rowCount: data.rows.length, fileName: basename(path) }
      }
    },
    'documents.attach': {
      input: attachDocumentSchema,
      auth: 'session',
      handler: async (i, ctx) => {
        const op = requireOp(ctx)
        // Check permission before showing the file dialog.
        if (i.entityType === 'asset') assertPermission(op.actor.permissions, 'assets.update')
        const file = await c.pickDocumentFile()
        return file ? attachDocument(db(), file, i, op) : null
      }
    },
    'documents.removeLink': {
      input: removeDocumentLinkSchema,
      auth: 'session',
      handler: (i, ctx) => {
        removeDocumentLink(db(), i, requireOp(ctx))
        return null
      }
    },
    'documents.open': {
      input: documentRefSchema,
      auth: 'session',
      handler: async (i, ctx) => {
        const doc = resolveDocument(db(), i.documentId, requireOp(ctx))
        if (!doc.openable) throw new AppError('VALIDATION_ERROR', 'This file type cannot be opened directly. Save a copy instead.')
        await c.openPath(doc.path)
        return null
      }
    },
    'documents.saveCopy': {
      input: documentRefSchema,
      auth: 'session',
      handler: async (i, ctx) => {
        const doc = resolveDocument(db(), i.documentId, requireOp(ctx))
        const path = await c.pickSavePath(doc.originalName)
        if (!path) return { saved: false }
        await copyFile(doc.path, path)
        return { saved: true }
      }
    }
  }
}
