import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { COMMAND_NAMES, channelFor } from '@shared/api'
import type { Result } from '@shared/errors'
import { newCorrelationId } from '../app/ids'
import { isTrustedOrigin } from '../app/origin'
import type { Logger } from '../logging/logger'

type Dispatch = (command: string, payload: unknown) => Promise<Result<unknown>>

/**
 * Binds one ipcMain handler per allow-listed command. Each call must come from the
 * top-level frame of an application window served from a trusted origin.
 */
export function registerIpcHandlers(dispatch: Dispatch, allowedOrigins: ReadonlySet<string>, logger: Logger): void {
  for (const command of COMMAND_NAMES) {
    ipcMain.handle(channelFor(command), (event: IpcMainInvokeEvent, payload: unknown) => {
      const frame = event.senderFrame
      const isTopFrame = frame !== null && frame === event.sender.mainFrame
      if (!isTopFrame || !isTrustedOrigin(frame?.url, allowedOrigins)) {
        const correlationId = newCorrelationId()
        logger.warn('ipc', 'Rejected IPC from untrusted sender', { command, url: frame?.url, correlationId })
        return { ok: false, error: { code: 'FORBIDDEN_SENDER', message: 'Request rejected.', correlationId } }
      }
      return dispatch(command, payload)
    })
  }
}
