import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, shell, type BrowserWindow } from 'electron'
import { ALLOWED_DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from '@shared/assets'
import { IMPORT_MAX_BYTES } from '@shared/organization'
import type { PickedFile } from '../app/container'
import { AppError } from '../app/errors'

/** Native CSV picker. The size limit is checked before the file is read into memory. */
export async function pickCsvFile(win: BrowserWindow | null): Promise<PickedFile | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose an employee CSV file',
    properties: ['openFile'],
    filters: [
      { name: 'CSV files', extensions: ['csv'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const path = result.filePaths[0]
  if (result.canceled || !path) return null
  const info = await stat(path)
  if (info.size > IMPORT_MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', `The file is larger than ${IMPORT_MAX_BYTES / (1024 * 1024)} MB. Split it into smaller files.`)
  }
  return { fileName: basename(path), data: await readFile(path) }
}

/** Native picker for document attachments, limited to allow-listed types and size. */
export async function pickDocument(win: BrowserWindow | null): Promise<PickedFile | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Attach a document',
    properties: ['openFile'],
    filters: [{ name: 'Documents and images', extensions: Object.keys(ALLOWED_DOCUMENT_TYPES) }]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const path = result.filePaths[0]
  if (result.canceled || !path) return null
  const info = await stat(path)
  if (info.size > MAX_DOCUMENT_BYTES) {
    throw new AppError('VALIDATION_ERROR', `The file is larger than ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB.`)
  }
  return { fileName: basename(path), data: await readFile(path) }
}

/** Native save dialog; the renderer never chooses filesystem paths itself. */
export async function pickSavePath(win: BrowserWindow | null, defaultName: string): Promise<string | null> {
  const safeName = basename(defaultName).replace(/[<>:"|?*\u0000-\u001f]/g, '_') || 'export'
  const options: Electron.SaveDialogOptions = { title: 'Save file', defaultPath: safeName }
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

/** Opens an allow-listed stored document with the system's default viewer. */
export async function openWithSystem(path: string): Promise<void> {
  const error = await shell.openPath(path)
  if (error) throw new AppError('INTERNAL_ERROR', `The document could not be opened: ${error}`)
}
