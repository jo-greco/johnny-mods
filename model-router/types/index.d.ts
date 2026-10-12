/** What the router decided for one turn, and why, so `/route` can say it. */
export type RouteDecision = {
  turnId: string
  route: 'cheap' | 'main'
  reason: string
  /** The cheaper model reached for a tool, so the rest of the turn went back. */
  escalated: boolean
}

export type RouterStats = {
  turns: number
  routed: number
  escalated: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      decision: RouteDecision
      stats: RouterStats
      isEnabled: boolean
      /** The prompt size of the last main-loop request, in tokens, as the API reported it. */
      lastContextTokens: number
    }
  }
}
