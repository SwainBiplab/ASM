import { contextBridge, ipcRenderer } from 'electron'
import { COMMAND_NAMES, channelFor, type AppApi } from '@shared/api'

/**
 * Builds `window.api` from the allow-list in src/shared/api.ts. The renderer never
 * receives ipcRenderer itself, so it can only invoke these named commands; the main
 * process re-validates sender, payload and permissions for each call.
 */
function buildApi(): AppApi {
  const api: Record<string, Record<string, (input?: unknown) => Promise<unknown>>> = {}
  for (const command of COMMAND_NAMES) {
    const [group, method] = command.split('.') as [string, string]
    const channel = channelFor(command)
    api[group] ??= {}
    api[group][method] = (input?: unknown) => ipcRenderer.invoke(channel, input)
  }
  return api as unknown as AppApi
}

contextBridge.exposeInMainWorld('api', buildApi())
