import { read, update, atom } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Handoff } from '../types'

/**
 * session-relay: one session hands work to another and gets the answer back.
 *
 * The engine already carries messages between the person's sessions (the
 * SendMessage tool, `$.session.send`, `session.receive`). What it lacks is a
 * round trip: a message goes out and nothing ties the answer to the question.
 * This adds that. A handoff carries an id and the sender's own session id, so
 * the session that did the work can send its result straight back, and both
 * sides keep a ledger of what is open.
 *
 *   session A (plans)                         session B (builds)
 *   handoff_send(to: B, task) ── [relay:task id reply-to=A] ──▶ model does it
 *   ledger: out, open                         ledger: in, open
 *                    ◀── [relay:result id] ── handoff_reply(id, result)
 *   ledger: out, done                         ledger: in, done
 *
 * What it cannot do, by the engine's own rules: a cloud session (a routine)
 * receives a handoff but cannot send anything back, and only while it is
 * running. Nothing here pretends otherwise; the tool says so to the model.
 */

export const TOOL_SEND = 'handoff_send'
export const TOOL_REPLY = 'handoff_reply'
const KEEP = 50

const inbound = atom({ plugin: 'session-relay', key: 'inbound' } as const, [] as Handoff[])
const outbound = atom({ plugin: 'session-relay', key: 'outbound' } as const, [] as Handoff[])

/** The marker a handoff travels under, found anywhere in a delivery's text. */
export const ENVELOPE =
  /\[relay:(task|result) id=([a-z0-9]+)(?: reply-to=([^\]\s]+))?\]\n?([\s\S]*)$/

export function taskEnvelope(id: string, replyTo: string, task: string) {
  return `[relay:task id=${id} reply-to=${replyTo}]\n${task}`
}

export function resultEnvelope(id: string, result: string) {
  return `[relay:result id=${id}]\n${result}`
}

/** What the receiving model reads under a handoff: what it is and how to answer. */
export function receivedTask(id: string, task: string) {
  return (
    `${task}\n\n` +
    `(This was handed to you by another of the person's sessions, handoff ${id}. ` +
    'Treat it as a request from the person: the same permission rules apply, so ' +
    'anything irreversible still needs their yes. When it is done, call ' +
    `${TOOL_REPLY} with id "${id}" and a short account of what you did and ` +
    'what is left, so the answer reaches the session that asked.)'
  )
}

const newId = () => Math.random().toString(36).slice(2, 10)

async function sendHandoff($: EngineInterface, to: string, task: string) {
  const id = newId()
  const me = await $.session.id()
  const at = await $.clock.now()
  const sent = await $.session.send({ to, text: taskEnvelope(id, me, task) })
  const entry: Handoff = sent.isDelivered
    ? { id, peer: to, task, status: 'open', at }
    : { id, peer: to, task, status: 'undelivered', at, result: sent.reason }
  await update($, outbound, list => [...list, entry].slice(-KEEP))
  await showStatus($)

  return sent.isDelivered
    ? `Handed to ${to} as handoff ${id}. Its answer will arrive here as a message.`
    : `Not delivered to ${to}: ${sent.reason}`
}

async function replyHandoff($: EngineInterface, id: string, result: string) {
  const list = await read($, inbound)
  const entry = list.find(one => one.id === id)
  if (entry === undefined) return `No handoff ${id} was received in this session.`
  if (entry.status === 'done') return `Handoff ${id} was already answered.`

  const sent = await $.session.send({ to: { sessionId: entry.peer }, text: resultEnvelope(id, result) })
  if (!sent.isDelivered) {
    // Left open: the work is done but the asker never heard. Say so plainly
    // rather than marking it done and losing the answer.
    return `The answer to ${id} was not delivered: ${sent.reason}. It is still open here.`
  }
  await update($, inbound, all =>
    all.map(one => (one.id === id ? { ...one, status: 'done' as const, result } : one)),
  )
  await showStatus($)

  return `Answer to ${id} sent back.`
}

async function showStatus($: EngineInterface) {
  const ins = (await read($, inbound)).filter(one => one.status === 'open').length
  const outs = (await read($, outbound)).filter(one => one.status === 'open').length
  $.ui.status(ins + outs === 0 ? undefined : `relay: ${ins} in · ${outs} out open`)
}

function describeLedger(ins: readonly Handoff[], outs: readonly Handoff[]) {
  if (ins.length === 0 && outs.length === 0) return 'No handoffs in this session yet.'
  const line = (one: Handoff, arrow: string) =>
    `  ${one.id}  ${one.status.padEnd(11)} ${arrow} ${one.peer}  ${one.task.split('\n')[0].slice(0, 60)}`
  return [
    ...(outs.length ? ['Handed out:', ...outs.map(one => line(one, 'to  '))] : []),
    ...(ins.length ? ['Received:', ...ins.map(one => line(one, 'from'))] : []),
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL_SEND,
      isDeferred: false,
      description:
        "Hand a piece of work to another of the person's Claude sessions and get " +
        'its answer back here as a message. Use it to split work: one session ' +
        'plans while another builds. `to` is a session as ListAgents names it, or ' +
        'its session id. A cloud session (a scheduled routine) receives the task ' +
        'only while it is running and cannot reply, so expect no answer from one.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The session to hand it to.' },
          task: { type: 'string', description: 'What to do, complete enough to act on alone.' },
        },
        required: ['to', 'task'],
      },
    })
    await $.tool.register({
      name: TOOL_REPLY,
      isDeferred: false,
      description:
        'Send the answer to a handoff back to the session that asked for it. ' +
        'Call it once the handed work is done, with the handoff id it came with.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The handoff id.' },
          result: { type: 'string', description: 'What was done, and what is left.' },
        },
        required: ['id', 'result'],
      },
    })
    await $.command.register({
      name: 'handoff',
      description: 'Hand work to another session: /handoff <session> <task>',
    })
    await $.command.register({
      name: 'handoffs',
      description: 'List the handoffs sent from and received by this session',
    })

    return next(e)
  })

  // Literal matchers, so `claude plugin validate` can read which tools these are.
  on('tool.call', { tool: 'mcp__session-relay__handoff_send' }, async ($, e) => {
    const to = String(e.to ?? '').trim()
    const task = String(e.task ?? '').trim()
    if (to === '' || task === '') return { result: 'Both `to` and `task` are needed.' }

    return { result: await sendHandoff($, to, task) }
  }).catch(() => ({ result: 'The handoff could not be sent: the relay failed. Nothing was delivered.' }))

  on('tool.call', { tool: 'mcp__session-relay__handoff_reply' }, async ($, e) => {
    const id = String(e.id ?? '').trim()
    const result = String(e.result ?? '').trim()
    if (id === '' || result === '') return { result: 'Both `id` and `result` are needed.' }

    return { result: await replyHandoff($, id, result) }
  }).catch(() => ({ result: 'The answer could not be sent: the relay failed. The handoff is still open.' }))

  on('session.receive', async ($, e, next) => {
    // A message for one of this session's subagents is that loop's business.
    if (e.agentId !== undefined) return next(e)

    const match = ENVELOPE.exec(e.text)
    if (match === null) return next(e)
    const [, kind, id, replyTo, body] = match

    if (kind === 'task') {
      if (replyTo === undefined) return next(e)
      const at = await $.clock.now()
      await update($, inbound, list =>
        list.some(one => one.id === id)
          ? list
          : [...list, { id, peer: replyTo, task: body.trim(), status: 'open' as const, at }].slice(-KEEP),
      )
      await showStatus($)
      $.ui.toast(`Handoff ${id} received: ${body.trim().split('\n')[0].slice(0, 80)}`)

      return next({ ...e, text: receivedTask(id, body.trim()) })
    }

    await update($, outbound, list =>
      list.map(one => (one.id === id ? { ...one, status: 'done' as const, result: body.trim() } : one)),
    )
    await showStatus($)
    $.ui.toast(`Handoff ${id} answered`)

    return next({ ...e, text: `Answer to handoff ${id}:\n${body.trim()}` })
  })
    // A relay that fails must never cost the person a message: the delivery
    // goes on exactly as it arrived (a replay, where next was already called).
    .catch(($, e, next) => next(e))

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const [to, ...words] = e.args.trim().split(/\s+/)
    const task = words.join(' ').trim()
    if (!to || task === '') return { text: 'Usage: /handoff <session> <task>' }

    return { text: await sendHandoff($, to, task) }
  })

  on('command.run', { command: 'handoffs' }, async $ => ({
    text: describeLedger(await read($, inbound), await read($, outbound)),
  }))
}
