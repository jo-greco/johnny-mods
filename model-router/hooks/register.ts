import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RouteDecision, RouterStats } from '../types'

/**
 * model-router: simple turns go to a cheaper model, everything else stays put.
 *
 * Each turn's prompt is classified once, at `turn.start`, by the engine's small
 * fast model. A turn judged a plain question that can be answered in prose has
 * its model requests (`turn.step`) renamed to the cheaper model. Every doubt
 * resolves toward the person's own model:
 *
 *  - the classifier failing, or answering neither label, keeps the turn on it;
 *  - a long prompt is never classified at all;
 *  - a subagent keeps the model it was spawned with;
 *  - a long conversation is never switched (see maxMessages in plugin.json);
 *  - and the moment the cheaper model reaches for a tool, the turn was not as
 *    simple as it looked, so its remaining steps go back to the person's model.
 */

export const SIMPLE = 'quick question or chat, answered in prose'
export const COMPLEX = 'task needing tools, files, code or careful judgement'

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
const lastMessageCount = atom({ plugin: 'model-router', key: 'lastMessageCount' } as const, 0)

const short = (model: string) => model.replace(/^claude-/, '')

/** Which model a turn should run on, and the reason, judged once at its start. */
export async function decide(
  $: EngineInterface,
  text: string,
  cheapModel: string,
  maxMessages: number,
): Promise<Pick<RouteDecision, 'route' | 'reason'>> {
  if (!(await read($, isEnabled))) return { route: 'main', reason: 'the router is off' }

  const prompt = text.trim()
  if (prompt === '') return { route: 'main', reason: 'no prompt to judge (a continuation)' }
  if (prompt.length > LONG_PROMPT) return { route: 'main', reason: 'a long prompt is real work' }
  if ((await read($, lastMessageCount)) > maxMessages) {
    return { route: 'main', reason: `the conversation is past ${maxMessages} messages` }
  }
  if ((await $.session.model()) === cheapModel) {
    return { route: 'main', reason: `the session already runs ${short(cheapModel)}` }
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
  const cheapModel = String(options.cheapModel ?? 'claude-haiku-5-5')
  const maxMessages = Number(options.maxMessages ?? 30)

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
    const choice = await decide($, e.text, cheapModel, maxMessages)
    await update($, decision, () => ({ turnId: e.turnId, ...choice, escalated: false }))
    await update($, stats, s => ({ ...s, turns: s.turns + 1 }))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // A subagent was spawned with the model it should have; not ours to move.
    if (e.agentId !== undefined) return yield* next(e)

    await update($, lastMessageCount, () => e.messageCount)

    const current = await read($, decision)
    const isRouted =
      current.turnId === e.turnId &&
      current.route === 'cheap' &&
      !current.escalated &&
      e.messageCount <= maxMessages &&
      e.model !== cheapModel
    if (!isRouted) return yield* next(e)

    $.ui.status(`router: ${short(cheapModel)}`)
    const result = yield* next({ ...e, model: cheapModel })
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
    const on_ = await read($, isEnabled)
    const lines = [
      on_
        ? `Model router is on: quick questions go to ${short(cheapModel)} while the conversation is under ${maxMessages} messages.`
        : 'Model router is off: every turn runs on your own model.',
      `This session: ${s.routed} of ${s.turns} turn(s) routed` +
        (s.escalated > 0 ? `, ${s.escalated} handed back after reaching for a tool.` : '.'),
    ]
    if (d.turnId !== '') {
      lines.push(
        `Last turn: ${d.route === 'cheap' ? short(cheapModel) : 'your model'}, ${d.reason}` +
          (d.escalated ? ', then handed back.' : '.'),
      )
    }

    return { text: lines.join('\n') }
  })
}
