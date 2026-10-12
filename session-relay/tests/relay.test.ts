import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { resultEnvelope, taskEnvelope } from '../hooks/register'

const ME = 'session-planner'
const PEER = 'session-builder'

type Sent = { to: unknown; text: string }

/**
 * Stands in for the engine beneath the relay: this session's id, the clock,
 * and the channel between sessions, which records every send and answers
 * with whatever delivery outcome the test asks for.
 */
function engine(on: On, outcome: { isDelivered: true } | { isDelivered: false; reason: string } = { isDelivered: true }) {
  const sent: Sent[] = []
  const queued: string[] = []
  on('session.id', () => ({ value: ME }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('session.send', ($, e) => (sent.push({ to: e.to, text: e.text }), outcome))
  on('session.receive', ($, e) => (queued.push(e.text), { text: e.text }))
  return { sent, queued }
}

const SEND = 'mcp__session-relay__handoff_send' as const
const REPLY = 'mcp__session-relay__handoff_reply' as const

describe('handing work out (the asking session)', () => {
  test('a handoff carries an id and the way back', async ($, on) => {
    const { sent } = engine(on)
    const out = await $.tool.call({ tool: SEND, to: 'builder', task: 'build the parser' })

    expect(sent.length).toBe(1)
    expect(sent[0].to).toBe('builder')
    expect(sent[0].text).toMatch(new RegExp(`^\\[relay:task id=[a-z0-9]+ reply-to=${ME}\\]\\nbuild the parser$`))
    expect(String(out.result)).toMatch(/Handed to builder as handoff/)
  })

  test('the answer arriving closes the handoff and reaches the model', async ($, on) => {
    const { sent, queued } = engine(on)
    await $.tool.call({ tool: SEND, to: 'builder', task: 'build the parser' })
    const id = /id=([a-z0-9]+)/.exec(sent[0].text)![1]

    await $.session.receive({ origin: { kind: 'peer' }, text: resultEnvelope(id, 'Parser built, 12 tests pass.') })
    const ledger = await $.command.run({ command: 'handoffs', args: '' })

    expect(queued[0]).toBe(`Answer to handoff ${id}:\nParser built, 12 tests pass.`)
    expect(ledger.text).toMatch(new RegExp(`${id}\\s+done`))
  })

  /**
   * Silent failure is the default this project keeps finding. A send that
   * did not land must say so, to the model and in the ledger.
   */
  test('a handoff that was not delivered says so, and is not left "open"', async ($, on) => {
    engine(on, { isDelivered: false, reason: 'nobody is named builder' })
    const out = await $.tool.call({ tool: SEND, to: 'builder', task: 'build the parser' })
    const ledger = await $.command.run({ command: 'handoffs', args: '' })

    expect(String(out.result)).toMatch(/Not delivered to builder: nobody is named builder/)
    expect(ledger.text).toMatch(/undelivered/)
    expect(ledger.text).not.toMatch(/\bopen\b/)
  })

  test('/handoff does the same from the prompt', async ($, on) => {
    const { sent } = engine(on)
    const out = await $.command.run({ command: 'handoff', args: 'builder  write the tests for the parser' })

    expect(sent[0].to).toBe('builder')
    expect(sent[0].text).toMatch(/\nwrite the tests for the parser$/)
    expect(out.text).toMatch(/Handed to builder/)
  })

  test('/handoff with nothing to hand says how to use it', async ($, on) => {
    const { sent } = engine(on)
    const out = await $.command.run({ command: 'handoff', args: 'builder' })

    expect(sent.length).toBe(0)
    expect(out.text).toMatch(/Usage/)
  })
})

describe('doing handed work (the receiving session)', () => {
  test('a received task reaches the model with its id and how to answer', async ($, on) => {
    const { queued } = engine(on)
    await $.session.receive({ origin: { kind: 'peer' }, text: taskEnvelope('abc123', PEER, 'build the parser') })

    expect(queued[0]).toMatch(/^build the parser/)
    expect(queued[0]).toMatch(/handoff abc123/)
    expect(queued[0]).toMatch(/handoff_reply with id "abc123"/)
    // The person's rules still hold for work another session asked for.
    expect(queued[0]).toMatch(/irreversible still needs their yes/)
  })

  test('the reply goes back to the session that asked, not anyone else', async ($, on) => {
    const { sent } = engine(on)
    await $.session.receive({ origin: { kind: 'peer' }, text: taskEnvelope('abc123', PEER, 'build the parser') })
    const out = await $.tool.call({ tool: REPLY, id: 'abc123', result: 'Built; tests pass.' })

    expect(sent.length).toBe(1)
    expect(JSON.stringify(sent[0].to)).toContain(PEER)
    expect(sent[0].text).toBe('[relay:result id=abc123]\nBuilt; tests pass.')
    expect(String(out.result)).toMatch(/sent back/)
  })

  test('a reply that is not delivered leaves the handoff open', async ($, on) => {
    const { sent } = engine(on, { isDelivered: false, reason: 'that session is not running' })
    await $.session.receive({ origin: { kind: 'peer' }, text: taskEnvelope('abc123', PEER, 'build it') })
    const out = await $.tool.call({ tool: REPLY, id: 'abc123', result: 'Built.' })
    const ledger = await $.command.run({ command: 'handoffs', args: '' })

    expect(sent.length).toBe(1)
    expect(String(out.result)).toMatch(/not delivered: that session is not running\. It is still open/)
    expect(ledger.text).toMatch(/abc123\s+open/)
  })

  test('replying to a handoff never received sends nothing', async ($, on) => {
    const { sent } = engine(on)
    const out = await $.tool.call({ tool: REPLY, id: 'nope', result: 'Built.' })

    expect(sent.length).toBe(0)
    expect(String(out.result)).toMatch(/No handoff nope was received/)
  })

  test('a handoff answered twice is only sent once', async ($, on) => {
    const { sent } = engine(on)
    await $.session.receive({ origin: { kind: 'peer' }, text: taskEnvelope('abc123', PEER, 'build it') })
    await $.tool.call({ tool: REPLY, id: 'abc123', result: 'Built.' })
    const again = await $.tool.call({ tool: REPLY, id: 'abc123', result: 'Built again.' })

    expect(sent.length).toBe(1)
    expect(String(again.result)).toMatch(/already answered/)
  })

  test('the same task delivered twice is one entry in the ledger', async ($, on) => {
    engine(on)
    const delivery = { origin: { kind: 'peer' as const }, text: taskEnvelope('abc123', PEER, 'build it') }
    await $.session.receive(delivery)
    await $.session.receive(delivery)
    const ledger = await $.command.run({ command: 'handoffs', args: '' })

    expect((ledger.text ?? '').match(/abc123/g)?.length).toBe(1)
  })
})

describe('what it leaves alone', () => {
  test('an ordinary message between sessions passes through untouched', async ($, on) => {
    const { queued } = engine(on)
    await $.session.receive({ origin: { kind: 'peer' }, text: 'Are you free to look at the sync?' })

    expect(queued).toEqual(['Are you free to look at the sync?'])
  })

  test("a message for one of this session's subagents is that loop's own", async ($, on) => {
    const { queued } = engine(on)
    const text = taskEnvelope('abc123', PEER, 'build it')
    await $.session.receive({ origin: { kind: 'coordinator' }, text, agentId: 'agent-1' })
    const ledger = await $.command.run({ command: 'handoffs', args: '' })

    expect(queued).toEqual([text])
    expect(ledger.text).toMatch(/No handoffs/)
  })
})
