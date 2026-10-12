import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { AGENT_COMMAND_NAMES, agentChannelFor, type AgentCommandName } from '../ipcContract'
import { isTrustedOrigin } from './origin'

export interface AgentLogger {
  warn(obj: object, msg?: string): void
}

type Dispatch = (command: AgentCommandName, payload: unknown) => Promise<unknown>

/** Binds one ipcMain handler per allow-listed agent command, same sender-validation discipline as `src/main/ipc/register.ts`. */
export function registerAgentIpcHandlers(dispatch: Dispatch, allowedOrigins: ReadonlySet<string>, logger: AgentLogger): void {
  for (const command of AGENT_COMMAND_NAMES) {
    ipcMain.handle(agentChannelFor(command), (event: IpcMainInvokeEvent, payload: unknown) => {
      const frame = event.senderFrame
      const isTopFrame = frame !== null && frame === event.sender.mainFrame
      if (!isTopFrame || !isTrustedOrigin(frame?.url, allowedOrigins)) {
        logger.warn({ command, url: frame?.url, correlationId: randomUUID() }, 'Rejected agent IPC from untrusted sender')
        throw new Error('Request rejected.')
      }
      return dispatch(command, payload)
    })
  }
}
