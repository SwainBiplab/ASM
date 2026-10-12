import { contextBridge, ipcRenderer } from 'electron'
import { buildAgentApi } from './buildAgentApi'

contextBridge.exposeInMainWorld('agent', buildAgentApi((channel, payload) => ipcRenderer.invoke(channel, payload)))
