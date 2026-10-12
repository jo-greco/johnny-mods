import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RouteDecision, RouterStats } from '../types'

/**
 * model-router: quick questions go to Claude Haiku 5.5, everything else stays put.
 *
 * Each turn's prompt is classified once, at `turn.start`, by the engine's small
 * fast model. A turn judged a plain question that can be answered in prose has
 * its model requests (`turn.step`) renamed to Haiku, at low effort. Every doubt
 * resolves toward the person's own model:
 *
 *  - the classifier failing, or answering neither label, keeps the turn on it;
 *  - a long prompt, or a slash command, is never classified at all;
 *  - a subagent keeps the model it was spawned with;
 *  - a conversation past maxContextTokens is never switched (below);
 *  - and the moment Haiku reaches for a tool, the turn was not as simple as it
 *    looked, so its remaining steps go back to the person's model.
 *
 * WHY THE GATE IS TOKENS, AND WHY HAIKU ALONE. The prompt cache is per model,
 * so a routed turn sends the whole conversation to Haiku uncached. At list
 * prices that is still cheaper than the person's model reading its own cache:
 * Haiku 5.5 input is $0.10/M, against $0.20/M for an Opus 5.5 or Sonnet 5.5
 * cache read. But Haiku's input price steps to $0.50/M past 100K prompt tokens,
 * at which point the cached read wins, so 100K is the default gate. Sonnet 5.5
 * was dropped as a target: uncached at $2.00/M it is ten times an Opus cache
 * read, so it saved money only in the first few turns of a conversation.
 */

export const SIMPLE = 'quick question or chat, answered in prose'
export const COMPLEX = 'task needing tools, files, code or careful judgement'
export const CHEAP_MODEL = 'claude-haiku-5-5'

/** Past this, a prompt is real work by its length alone: not worth a classify call. */
export const LONG_PROMPT = 600

const decision = atom({ plugin: 'model-router', key: 'decision' } as const, {
  turnId: '',
  route: 'main',
  reason: 'no turn yet',
  escalated: false,
} as RouteDecision)
const stats = atom({ plugin: 'model-router', key: 'stats' } as const, {
  turns: 0,
  routed: 0,
  escalated: 0,
} as RouterStats)
const isEnabled = atom({ plugin: 'model-router', key: 'isEnabled' } as const, true)
const lastContextTokens = atom({ plugin: 'model-router', key: 'lastContextTokens' } as const, 0)

const short = (model: string) => model.replace(/^claude-/, '')
const thousands = (n: number) => `${Math.round(n / 1000)}K`

/** Which model a turn should run on, and the reason, judged once at its start. */
export async function decide(
  $: EngineInterface,
  text: string,
  maxContextTokens: number,
): Promise<Pick<RouteDecision, 'route' | 'reason'>> {
  if (!(await read($, isEnabled))) return { route: 'main', reason: 'the router is off' }

  const prompt = text.trim()
  if (prompt === '') return { route: 'main', reason: 'no prompt to judge (a continuation)' }
  // A slash command runs a skill or a workflow: real work whatever it says.
  if (prompt.startsWith('/')) return { route: 'main', reason: 'a slash command is real work' }
  if (prompt.length > LONG_PROMPT) return { route: 'main', reason: 'a long prompt is real work' }

  const context = await read($, lastContextTokens)
  // No reading yet. A brand-new session's first turn is small by definition,
  // but one resumed from a long transcript is not, and its size is unknown
  // until a response reports it. "I could not measure it" is not "it is small".
  if (context === 0 && (await $.session.turns()) > 1) {
    return { route: 'main', reason: 'the conversation size is not known yet (a resumed session)' }
  }
  if (context > maxContextTokens) {
    return {
      route: 'main',
      reason: `the conversation is ${thousands(context)} tokens, past the ${thousands(maxContextTokens)} where Haiku stops being cheaper`,
    }
  }
  if ((await $.session.model()) === CHEAP_MODEL) {
    return { route: 'main', reason: `the session already runs ${short(CHEAP_MODEL)}` }
  }

  let label: string | undefined
  try {
    label = await $.model.classify(prompt, [SIMPLE, COMPLEX])
  } catch {
    return { route: 'main', reason: 'the classifier did not answer' }
  }
  if (label === SIMPLE) return { route: 'cheap', reason: 'judged a quick question' }
  if (label === COMPLEX) return { route: 'main', reason: 'judged to need tools or care' }

  return { route: 'main', reason: 'the classifier was unsure' }
}

export const register: Register = (on, options) => {
  const maxContextTokens = Number(options.maxContextTokens ?? 100_000)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Model router: show what it did, or turn it on or off (/route on, /route off)',
    })
    // The on/off choice outlives the session; the rest is per session.
    const saved = await $.store.get('isEnabled')
    if (typeof saved === 'boolean') await update($, isEnabled, () => saved)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const choice = await decide($, e.text, maxContextTokens)
    await update($, decision, () => ({ turnId: e.turnId, ...choice, escalated: false }))
    await update($, stats, s => ({ ...s, turns: s.turns + 1 }))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // A subagent was spawned with the model it should have; not ours to move.
    if (e.agentId !== undefined) return yield* next(e)

    const current = await read($, decision)
    const isRouted =
      current.turnId === e.turnId &&
      current.route === 'cheap' &&
      !current.escalated &&
      e.model !== CHEAP_MODEL &&
      (await read($, lastContextTokens)) <= maxContextTokens

    if (isRouted) $.ui.status(`router: ${short(CHEAP_MODEL)}`)
    // Low effort on a routed turn: it was judged simple, and lower effort means
    // fewer tokens and a shorter answer. A step that is not routed keeps the
    // person's own model and effort, untouched.
    const result = isRouted
      ? yield* next({ ...e, model: CHEAP_MODEL, effort: 'low' })
      : yield* next(e)

    // How big the conversation is, as the API itself reported it: everything the
    // request sent, cached or not. The next turn's gate reads this.
    if (result.usage !== null) {
      const u = result.usage
      const size = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, lastContextTokens, () => size)
    }
    if (!isRouted) return result

    if (e.index === 0) await update($, stats, s => ({ ...s, routed: s.routed + 1 }))

    // A simple turn answers in prose. One that reaches for a tool was misjudged:
    // let that call run as any call does (the permission checks are the same)
    // and give every later step of the turn back to the person's model.
    if (result.toolUses.length > 0) {
      await update($, decision, d => ({ ...d, escalated: true }))
      await update($, stats, s => ({ ...s, escalated: s.escalated + 1 }))
      $.ui.status(`router: back to ${short(e.model)}`)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    $.ui.status(undefined)

    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      const value = arg === 'on'
      await update($, isEnabled, () => value)
      await $.store.set('isEnabled', value)

      return { text: `Model router ${arg}.` }
    }
    if (arg !== '') return { text: 'Usage: /route, /route on, /route off' }

    const s = await read($, stats)
    const d = await read($, decision)
    const isOn = await read($, isEnabled)
    const context = await read($, lastContextTokens)
    const lines = [
      isOn
        ? `Model router is on: quick questions go to ${short(CHEAP_MODEL)} while the conversation is under ${thousands(maxContextTokens)} tokens (now ${thousands(context)}).`
        : 'Model router is off: every turn runs on your own model.',
      `This session: ${s.routed} of ${s.turns} turn(s) routed` +
        (s.escalated > 0 ? `, ${s.escalated} handed back after reaching for a tool.` : '.'),
    ]
    if (d.turnId !== '') {
      lines.push(
        `Last turn: ${d.route === 'cheap' ? short(CHEAP_MODEL) : 'your model'}, ${d.reason}` +
          (d.escalated ? ', then handed back.' : '.'),
      )
    }

    return { text: lines.join('\n') }
  })
}
