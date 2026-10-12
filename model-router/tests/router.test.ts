import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { COMPLEX, SIMPLE } from '../hooks/register'

const MAIN = 'claude-opus-5-5'
const CHEAP = 'claude-haiku-5-5'

type Beneath = {
  label?: string | undefined | 'throws'
  sessionModel?: string
  toolUses?: { name: string; input: unknown }[]
}

/**
 * Stands in for the engine beneath the router: the classifier's answer, the
 * session's model, and a model step that records which model it was asked for.
 */
function engine(on: On, beneath: Beneath = {}) {
  const asked: string[] = []
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  // Reads answer { value }, as the engine's own do; a failed call is a deny.
  on('session.model', () => ({ value: beneath.sessionModel ?? MAIN }))
  on('model.classify', () =>
    beneath.label === 'throws'
      ? { deny: 'api-error 529' }
      : { value: 'label' in beneath ? (beneath.label as string | undefined) : SIMPLE },
  )
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('turn.step', async function* ($, e) {
    asked.push(e.model)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: beneath.toolUses ?? [],
      stopReason: beneath.toolUses?.length ? 'tool_use' : 'end_turn',
      usage: null,
    }
  })
  return asked
}

/** Runs one model step of a turn and reads its stream to the end. */
async function step(
  $: Engine,
  turnId: string,
  index: number,
  extra: { messageCount?: number; agentId?: string } = {},
) {
  const stream = $.turn.step({
    turnId,
    index,
    model: MAIN,
    messageCount: extra.messageCount ?? 4,
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
  })
  for await (const _ of stream) void _
  return stream.result
}

describe('routing a turn', () => {
  test('a quick question runs on the cheaper model', async ($, on) => {
    const asked = engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0)

    expect(asked).toEqual([CHEAP])
  })

  test('real work stays on your model', async ($, on) => {
    const asked = engine(on, { label: COMPLEX })
    await $.turn.start({ text: 'refactor the sync to batch its writes', turnId: 't1' })
    await step($, 't1', 0)

    expect(asked).toEqual([MAIN])
  })

  /**
   * Every doubt resolves toward the person's own model. A classifier that
   * fails, or answers neither label, must never be read as "simple".
   */
  test('a classifier that fails keeps the turn on your model', async ($, on) => {
    const asked = engine(on, { label: 'throws' })
    await $.turn.start({ text: 'what time is it in Tokyo?', turnId: 't1' })
    await step($, 't1', 0)

    expect(asked).toEqual([MAIN])
  })

  test('an unsure classifier keeps the turn on your model', async ($, on) => {
    const asked = engine(on, { label: undefined })
    await $.turn.start({ text: 'hmm', turnId: 't1' })
    await step($, 't1', 0)

    expect(asked).toEqual([MAIN])
  })

  test('a long prompt is never sent to the cheaper model', async ($, on) => {
    const asked = engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'x'.repeat(700), turnId: 't1' })
    await step($, 't1', 0)

    expect(asked).toEqual([MAIN])
  })

  test('a continuation with no prompt stays put', async ($, on) => {
    const asked = engine(on, { label: SIMPLE })
    await $.turn.start({ text: '', turnId: 't1' })
    await step($, 't1', 0)

    expect(asked).toEqual([MAIN])
  })
})

describe('what is never moved', () => {
  test('a subagent keeps the model it was spawned with', async ($, on) => {
    const asked = engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0, { agentId: 'agent-1' })

    expect(asked).toEqual([MAIN])
  })

  /**
   * The prompt cache is per model. Switching a long conversation re-sends all
   * of it, uncached, to the other model, which can cost more than it saves.
   */
  test('a long conversation is not switched', async ($, on) => {
    const asked = engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0, { messageCount: 200 })

    expect(asked).toEqual([MAIN])
  })

  test('a step from another turn is left alone', async ($, on) => {
    const asked = engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 'some-other-turn', 0)

    expect(asked).toEqual([MAIN])
  })
})

describe('handing a turn back', () => {
  /**
   * THE SAFETY VALVE. A turn judged simple that reaches for a tool was
   * misjudged: the rest of it goes back to the person's own model.
   */
  test('the cheaper model reaching for a tool hands the turn back', async ($, on) => {
    const asked = engine(on, {
      label: SIMPLE,
      toolUses: [{ name: 'Edit', input: { file_path: 'a.ts' } }],
    })
    await $.turn.start({ text: 'fix the typo in a.ts', turnId: 't1' })
    await step($, 't1', 0)
    await step($, 't1', 1)
    await step($, 't1', 2)

    expect(asked).toEqual([CHEAP, MAIN, MAIN])
  })

  test('the next turn is judged afresh after a hand-back', async ($, on) => {
    const asked = engine(on, { label: SIMPLE, toolUses: [{ name: 'Read', input: {} }] })
    await $.turn.start({ text: 'what is in a.ts?', turnId: 't1' })
    await step($, 't1', 0)
    await $.turn.start({ text: 'and what does it do?', turnId: 't2' })
    await step($, 't2', 0)

    expect(asked).toEqual([CHEAP, CHEAP])
  })
})

describe('/route', () => {
  test('/route off keeps every turn on your model', async ($, on) => {
    const asked = engine(on, { label: SIMPLE })
    await $.command.run({ command: 'route', args: 'off' })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0)

    expect(asked).toEqual([MAIN])
  })

  test('/route says what it did and why', async ($, on) => {
    engine(on, { label: SIMPLE })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0)
    const out = await $.command.run({ command: 'route', args: '' })

    expect(out.text).toMatch(/1 of 1 turn\(s\) routed/)
    expect(out.text).toMatch(/haiku-5-5, judged a quick question/)
  })

  test('a session already on the cheaper model is not "routed"', async ($, on) => {
    const asked = engine(on, { label: SIMPLE, sessionModel: CHEAP })
    await $.turn.start({ text: 'what does idempotent mean?', turnId: 't1' })
    await step($, 't1', 0)
    const out = await $.command.run({ command: 'route', args: '' })

    expect(asked).toEqual([MAIN])
    expect(out.text).toMatch(/already runs haiku-5-5/)
  })
})
