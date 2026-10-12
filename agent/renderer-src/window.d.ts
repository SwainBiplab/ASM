import type { AgentApi } from '../ipcContract'

declare global {
  interface Window {
    agent: AgentApi
  }
}

export {}
