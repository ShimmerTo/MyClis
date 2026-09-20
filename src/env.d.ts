import type { ClichildsApi } from '../shared/types'

declare global {
  interface Window {
    clichilds: ClichildsApi
  }
}

export {}
