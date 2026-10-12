import type { AppApi } from '../shared/api'

declare global {
  interface Window {
    readonly api: AppApi
  }
}

export {}
