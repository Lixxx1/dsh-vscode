import { createHash, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { redactDshSecrets } from './runtime-output.js'

export class DshConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'DshConnectionError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only the local, root DSH endpoint may receive a launch token or cookie. */
export function dshLocalUrl(value: URL): URL {
  const url = new URL(value.href)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || url.username !== '' || url.password !== '' || url.pathname !== '/'
    || url.hash !== '' || url.port === '0') {
    throw new DshConnectionError('invalid-url', 'DSH must use an HTTP root URL on 127.0.0.1.')
  }
  const keys = [...url.searchParams.keys()]
  if (keys.some(key => key !== 'token') || keys.length > 1
    || (keys.length === 1 && !/^[A-Za-z0-9_-]+$/.test(url.searchParams.get('token') ?? ''))) {
    throw new DshConnectionError('invalid-url', 'DSH returned an invalid launch URL.')
  }
  return url
}

/**
 * Extension-host-owned HTTP/WebSocket carrier for DSH 0.1.2 Remotes.
 * Credentials are private fields, never part of runtime state or JSON output.
 * Redirects and automatic RPC retries are deliberately disabled.
 */
export class DshConnection {
  readonly #origin: string
  readonly #lifetime = new AbortController()
  readonly #sockets = new Set<WebSocket>()
  #cookie: string | undefined
  #launchUrl: URL | undefined
  #authenticating = false

  constructor(baseUrl: URL) {
    const url = dshLocalUrl(baseUrl)
    if (url.search !== '') throw new DshConnectionError('invalid-url', 'Authenticate the DSH launch URL explicitly.')
    this.#origin = url.origin
  }

  get baseUrl(): URL { return new URL(this.#origin) }
  get authenticated(): boolean { return this.#cookie !== undefined && !this.#lifetime.signal.aborted }

  /** Called only by the explicit Open in Browser action, never published to the Webview. */
  browserUrl(): URL {
    return new URL(this.#launchUrl?.href ?? this.#origin)
  }

  async authenticate(launchUrl: URL, signal?: AbortSignal): Promise<void> {
    const url = dshLocalUrl(launchUrl)
    if (url.origin !== this.#origin || !url.searchParams.has('token')) {
      throw new DshConnectionError('authentication-required', 'Reopen the URL printed by DSH, or restart its managed runtime.')
    }
    if (this.#authenticating) throw new DshConnectionError('authentication-pending', 'DSH authentication is already in progress.')
    this.#authenticating = true
    this.#cookie = undefined
    this.#launchUrl = undefined
    try {
      const response = await fetch(url, {
        method: 'GET', redirect: 'manual',
        signal: this.signal(10_000, signal),
      })
      try {
        if (response.status !== 303 || response.headers.get('location') !== '/') {
          throw new DshConnectionError('authentication-failed', 'DSH did not accept its launch token. Restart the runtime.', response.status)
        }
        const cookieName = `dsh-auth-${createHash('sha256').update(url.host).digest('base64url')}`
        const matches = response.headers.getSetCookie().filter(cookie => cookie.startsWith(`${cookieName}=`))
        const cookie = matches[0]?.split(';', 1)[0]
        if (matches.length !== 1 || cookie === undefined
          || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cookie.slice(cookieName.length + 1))
          || cookie.length > 4096) {
          throw new DshConnectionError('authentication-failed', 'DSH did not return a valid authentication cookie.')
        }
        this.#lifetime.signal.throwIfAborted()
        signal?.throwIfAborted()
        this.#cookie = cookie
        this.#launchUrl = url
      } finally {
        await response.body?.cancel()
      }
    } catch (error) {
      if (error instanceof DshConnectionError) throw error
      // Native fetch failures can include their request URL (and its token).
      throw new DshConnectionError('authentication-failed', 'Could not authenticate with DSH. Check the runtime and reconnect.')
    } finally {
      this.#authenticating = false
    }
  }

  async call<T>(endpoint: string, args: Record<string, unknown>, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    // Prevent URL traversal, query injection, and credential-bearing redirects.
    if (!/^(?:\$events|[A-Za-z][A-Za-z0-9]*)\/[A-Za-z][A-Za-z0-9]*$/.test(endpoint)) {
      throw new DshConnectionError('invalid-endpoint', 'Invalid DSH Remote endpoint.')
    }
    const rpcId = randomUUID()
    try {
      const response = await fetch(new URL(`/api/${endpoint}`, this.#origin), {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json', ...this.headers() },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: this.signal(timeoutMs, signal),
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 401 || response.status === 403) {
          this.#cookie = undefined
          throw new DshConnectionError('authentication-required', 'DSH authentication expired or was refused. Reconnect the runtime.', response.status)
        }
        throw new DshConnectionError('http-error', `DSH ${endpoint} failed: HTTP ${String(response.status)}.`, response.status)
      }
      let envelope: unknown
      try {
        envelope = await response.json()
      } catch (error) {
        if (error instanceof SyntaxError) throw new DshConnectionError('invalid-response', `DSH ${endpoint} returned invalid JSON.`)
        throw error
      }
      if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
        || !record(envelope.result) || typeof envelope.result.ok !== 'boolean') {
        throw new DshConnectionError('invalid-response', `Invalid DSH response for ${endpoint}.`)
      }
      const result = envelope.result
      if (result.ok === false) {
        const error = result.error
        if (!record(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
          throw new DshConnectionError('invalid-response', `Invalid DSH error for ${endpoint}.`)
        }
        throw new DshConnectionError(this.safe(error.code), this.safe(error.message))
      }
      return result.value as T
    } catch (error) {
      if (error instanceof DshConnectionError) throw error
      if (this.#lifetime.signal.aborted || signal?.aborted === true) {
        throw new DshConnectionError('cancelled', `DSH ${endpoint} was cancelled.`)
      }
      throw new DshConnectionError('transport-error', `DSH ${endpoint} did not complete. Check the connection before retrying.`)
    }
  }

  /** The stream multiplexer is the only credential-bearing WebSocket target. */
  openStreamSocket(): WebSocket {
    if (this.#lifetime.signal.aborted) throw new DshConnectionError('cancelled', 'The DSH connection has been disposed.')
    const url = new URL('/api/remote.mux', this.#origin)
    url.protocol = 'ws:'
    const socket = new WebSocket(url, {
      headers: this.headers(), followRedirects: false, handshakeTimeout: 10_000,
    })
    this.#sockets.add(socket)
    // Avoid an unhandled EventEmitter error if the owner disposes while connecting.
    socket.on('error', () => {})
    socket.once('close', () => { this.#sockets.delete(socket) })
    return socket
  }

  dispose(): void {
    this.#lifetime.abort()
    this.#cookie = undefined
    this.#launchUrl = undefined
    for (const socket of this.#sockets) socket.terminate()
    this.#sockets.clear()
  }

  private headers(): Record<string, string> {
    return this.#cookie === undefined ? {} : { cookie: this.#cookie }
  }

  private signal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(timeoutMs), ...(signal === undefined ? [] : [signal])])
  }

  private safe(value: string): string {
    return redactDshSecrets(value, [this.#launchUrl?.searchParams.get('token') ?? '', this.#cookie ?? '', this.#cookie?.split('=')[1] ?? ''])
  }
}
