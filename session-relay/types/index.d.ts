/**
 * One piece of work passed between two sessions.
 *
 * `peer` is the other session's address: the one it went to (outbound), or
 * the session id the sender wrote into the envelope so the answer can find its
 * way back (inbound).
 */
export type Handoff = {
  id: string
  peer: string
  task: string
  status: 'open' | 'done' | 'undelivered'
  /** Epoch milliseconds when it was sent or received. */
  at: number
  /** The answer, once there is one; the reason, when it never arrived. */
  result?: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-relay': {
      inbound: Handoff[]
      outbound: Handoff[]
    }
  }
}
