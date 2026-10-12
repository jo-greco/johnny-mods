import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CHEAP_MODEL, COMPLEX, SIMPLE } from '../hooks/register'

const MAIN = 'claude-opus-5-5'

type Beneath = {
  label?: string | undefined | 'throws'
  sessionModel?: string
  toolUses?: { name: string; input: unknown }[]
  /** The prompt size the API reports for every step, in tokens. */
  contextTokens?: number
  /** User turns in the transcript: more than 1 with no size reading is a resumed session. */
  turns?: number
}

type Asked = { model: string; effort: unknown }

/**
 * Stands in for the engine beneath the router: the classifier's answer, the
 * session's model, and a model step that records which model and effort it was
 * asked for and reports the conversation's size as the API would.
 */
function engine(on: On, beneath: Beneath = {}) {
  const asked: Asked[] = []
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  // Reads answer { value }, as the engine's own do; a failed call is a deny.
  on('session.model', () => ({ value: beneath.sessionModel ?? MAIN }))
  on('session.turns', () => ({ value: beneath.turns ?? 1 }))
  on('model.classify', () =>
    beneath.label === 'throws'
      ? { deny: 'api-error 529' }
      : { value: 'label' in beneath ? (beneath.label as string | undefined) : SIMPLE },
  )
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('turn.step', async function* ($, e) {
    asked.push({ model: e.model, effort: e.effort })
    const size = beneath.contextTokens ?? 4_000
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: beneath.toolUses ?? [],
      stopReason: beneath.toolUses?.length ? 'tool_use' : 'end_turn',
      usage: {
        model: e.model,
        input_tokens: 200,
        output_tokens: 50,
        cache_read_input_tokens: size - 200,
        cache_creation_input_tokens: 0,
      },
    }
  })
  return { asked, models: () => asked.map(a => a.model) }
}

/** Runs one model step of a turn and reads its stream to the end. */
async function step($: Engine, turnId: string, index: number, extra: { agentId?: string } = {}) {
  const stream = $.turn.step({
    turnId,
    index,
    model: MAIN,
    effort: 'high',
    messageCount: 4,
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
  })
  for await (const _ of stream) void _
  return stream.result
}

describe('routing a turn', () => {
  test('a quick question runs on Haiku', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0)

    expect(models()).toEqual([CHEAP_MODEL])
  })

  test('a routed turn runs at low effort, an unrouted one keeps its own', async ($, on) => {
    const { asked } = engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0)
    await $.turn.start({ text: '/review the sync', turnId: 't2' })
    await step($, 't2', 0)

    expect(asked).toEqual([
      { model: CHEAP_MODEL, effort: 'low' },
      { model: MAIN, effort: 'high' },
    ])
  })

  test('real work stays on your model', async ($, on) => {
    const { models } = engine(on, { label: COMPLEX })
    await $.turn.start({ text: 'refactor the sync to batch its writes', turnId: 't1' })
    await step($, 't1', 0)

    expect(models()).toEqual([MAIN])
  })

  /**
   * Every doubt resolves toward the person's own model. A classifier that
   * fails, or answers neither label, must never be read as "simple".
   */
  test('a classifier that fails keeps the turn on your model', async ($, on) => {
    const { models } = engine(on, { label: 'throws' })
    await $.turn.start({ text: 'what time is it in Tokyo?', turnId: 't1' })
    await step($, 't1', 0)

    expect(models()).toEqual([MAIN])
  })

  test('an unsure classifier keeps the turn on your model', async ($, on) => {
    const { models } = engine(on, { label: undefined })
    await $.turn.start({ text: 'hmm', turnId: 't1' })
    await step($, 't1', 0)

    expect(models()).toEqual([MAIN])
  })

  test('a long prompt is never sent to Haiku', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'x'.repeat(700), turnId: 't1' })
    await step($, 't1', 0)

    expect(models()).toEqual([MAIN])
  })

  test('a slash command is real work, whatever the classifier says', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE })
    await $.turn.start({ text: '/plan the parser', turnId: 't1' })
    await step($, 't1', 0)

    expect(models()).toEqual([MAIN])
  })

  test('a continuation with no prompt stays put', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE })
    await $.turn.start({ text: '', turnId: 't1' })
    await step($, 't1', 0)

    expect(models()).toEqual([MAIN])
  })
})

describe('the size gate', () => {
  /**
   * The prompt cache is per model, so a routed turn re-sends the conversation
   * uncached. Haiku is still cheaper than a cache read until its own input price
   * steps up at 100K tokens; past that, the person's model wins.
   */
  test('once a conversation is past 100K tokens, nothing more is switched', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE, contextTokens: 150_000 })
    // The first turn has no reading yet; its own step reports 150K.
    await $.turn.start({ text: 'what is a parser?', turnId: 't1' })
    await step($, 't1', 0)
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't2' })
    await step($, 't2', 0)
    const out = await $.command.run({ command: 'route', args: '' })

    expect(models()).toEqual([CHEAP_MODEL, MAIN])
    expect(out.text).toMatch(/150K tokens, past the 100K/)
  })

  /**
   * THE BLIND SPOT. A session resumed from a long transcript has no reading
   * until a response reports one. Unknown size must not be read as small.
   */
  test('a resumed session of unknown size stays on your model', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE, turns: 40 })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0)
    const out = await $.command.run({ command: 'route', args: '' })

    expect(models()).toEqual([MAIN])
    expect(out.text).toMatch(/size is not known yet/)
  })

  test('once a resumed session reports a small size, it can be routed', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE, turns: 40, contextTokens: 20_000 })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0)
    await $.turn.start({ text: 'and what is a monoid?', turnId: 't2' })
    await step($, 't2', 0)

    expect(models()).toEqual([MAIN, CHEAP_MODEL])
  })

  test('a conversation under the gate is still routed', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE, contextTokens: 60_000 })
    await $.turn.start({ text: 'refactor the sync', turnId: 't1' })
    await step($, 't1', 0)
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't2' })
    await step($, 't2', 0)

    expect(models()).toEqual([CHEAP_MODEL, CHEAP_MODEL])
  })

  test('the gate can be set lower', { options: { maxContextTokens: 20_000 } }, async ($, on) => {
    const { models } = engine(on, { label: SIMPLE, contextTokens: 30_000 })
    await $.turn.start({ text: 'refactor the sync', turnId: 't1' })
    await step($, 't1', 0)
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't2' })
    await step($, 't2', 0)

    expect(models()).toEqual([CHEAP_MODEL, MAIN])
  })
})

describe('what is never moved', () => {
  test('a subagent keeps the model it was spawned with', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0, { agentId: 'agent-1' })

    expect(models()).toEqual([MAIN])
  })

  test('a step from another turn is left alone', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 'some-other-turn', 0)

    expect(models()).toEqual([MAIN])
  })
})

describe('handing a turn back', () => {
  /**
   * THE SAFETY VALVE. A turn judged simple that reaches for a tool was
   * misjudged: the rest of it goes back to the person's own model.
   */
  test('Haiku reaching for a tool hands the turn back', async ($, on) => {
    const { asked } = engine(on, {
      label: SIMPLE,
      toolUses: [{ name: 'Edit', input: { file_path: 'a.ts' } }],
    })
    await $.turn.start({ text: 'fix the typo in a.ts', turnId: 't1' })
    await step($, 't1', 0)
    await step($, 't1', 1)
    await step($, 't1', 2)

    expect(asked).toEqual([
      { model: CHEAP_MODEL, effort: 'low' },
      { model: MAIN, effort: 'high' },
      { model: MAIN, effort: 'high' },
    ])
  })

  test('the next turn is judged afresh after a hand-back', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE, toolUses: [{ name: 'Read', input: {} }] })
    await $.turn.start({ text: 'what is in a.ts?', turnId: 't1' })
    await step($, 't1', 0)
    await $.turn.start({ text: 'and what does it do?', turnId: 't2' })
    await step($, 't2', 0)

    expect(models()).toEqual([CHEAP_MODEL, CHEAP_MODEL])
  })
})

describe('/route', () => {
  test('/route off keeps every turn on your model', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE })
    await $.command.run({ command: 'route', args: 'off' })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0)

    expect(models()).toEqual([MAIN])
  })

  test('/route says what it did and why', async ($, on) => {
    engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0)
    const out = await $.command.run({ command: 'route', args: '' })

    expect(out.text).toMatch(/1 of 1 turn\(s\) routed/)
    expect(out.text).toMatch(/haiku-5-5, judged a quick question/)
    expect(out.text).toMatch(/under 100K tokens \(now 4K\)/)
  })

  test('a session already on Haiku is not "routed"', async ($, on) => {
    const { models } = engine(on, { label: SIMPLE, sessionModel: CHEAP_MODEL })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0)
    const out = await $.command.run({ command: 'route', args: '' })

    expect(models()).toEqual([MAIN])
    expect(out.text).toMatch(/already runs haiku-5-5/)
  })
})
