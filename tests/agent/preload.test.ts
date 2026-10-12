import { describe, expect, it, vi } from 'vitest'
import { buildAgentApi } from '../../agent/preload/buildAgentApi'
import { AGENT_CHANNEL_PREFIX } from '../../agent/ipcContract'

describe('agent preload allow-list', () => {
  it('exposes exactly the allow-listed commands, routed to their own channel and nothing else', async () => {
    const invoke = vi.fn(async (channel: string) => ({ channel }))
    const api = buildAgentApi(invoke)
    expect(await api.device.getLocalDevice()).toEqual({ channel: `${AGENT_CHANNEL_PREFIX}device.getLocalDevice` })
    expect(invoke).toHaveBeenCalledWith(`${AGENT_CHANNEL_PREFIX}device.getLocalDevice`, undefined)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
