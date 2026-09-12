import { dshLocalUrl } from './dsh-connection.js'

export type RuntimeTarget = { kind: 'managed' } | { kind: 'external'; launchUrl: URL }

export class ExistingRuntimeConnectionError extends Error {
  constructor(message = 'An existing DSH runtime on 127.0.0.1:3080 requires its launch URL. Connect to it or start a separate managed runtime.') {
    super(message)
    this.name = 'ExistingRuntimeConnectionError'
  }
}

/** Never echo a pasted URL: it contains the runtime's authentication token. */
export function existingRuntimeUrl(value: string): URL {
  try {
    if (value.length > 8192) throw new Error()
    const url = dshLocalUrl(new URL(value.trim()))
    if (!url.searchParams.has('token')) throw new Error()
    return url
  } catch {
    throw new Error('Paste the full launch URL printed by DSH: http://127.0.0.1:PORT/?token=…')
  }
}
