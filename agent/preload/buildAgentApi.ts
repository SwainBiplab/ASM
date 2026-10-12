import { AGENT_COMMAND_NAMES, agentChannelFor, type AgentApi, type AgentCommandName } from '../ipcContract'

/**
 * Builds the `window.agent` object from the allow-list in `ipcContract.ts` -- same shape as
 * `src/preload/index.ts`'s `buildApi()`. Pure and `electron`-free (the caller supplies `invoke`),
 * so the allow-list wiring is unit-testable without the Electron runtime; `index.ts` is the only
 * file that touches `contextBridge`/`ipcRenderer`, and has no logic of its own left to test.
 */
export function buildAgentApi(invoke: (channel: string, payload?: unknown) => Promise<unknown>): AgentApi {
  const api: Record<string, Record<string, (input?: unknown) => Promise<unknown>>> = {}
  for (const command of AGENT_COMMAND_NAMES as readonly AgentCommandName[]) {
    const [group, method] = command.split('.') as [string, string]
    const channel = agentChannelFor(command)
    api[group] ??= {}
    api[group][method] = (input?: unknown) => invoke(channel, input)
  }
  return api as unknown as AgentApi
}
