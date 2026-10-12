# johnny-mods

Two Claude Code mods: **session-relay** and **model-router**.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install session-relay --marketplace jo-greco/johnny-mods
/plugin install model-router --marketplace jo-greco/johnny-mods
```

Answer `y` to add the marketplace, then pick a scope (user is first). Each mod
is active in that session at once, and in every session started after.

To work on the mods themselves, clone this repository and install from the
clone instead (`claude plugin marketplace add <clone folder>`). A plugin
installed from a local folder is read straight from it, so an edit takes effect
with `/reload-plugins`: no reinstall, no new version.

## session-relay

One session hands work to another and gets the answer back: one session plans
while another builds.

- The model can do it itself with `handoff_send(to, task)` and
  `handoff_reply(id, result)`.
- `/handoff <session> <task>` does it from the prompt.
- `/handoffs` lists what is open, done or undelivered, both ways.
- The status line shows `relay: N in · M out open`.

Every handoff carries an id and the asking session's own id, so the answer finds
its way back. A send that does not arrive is marked `undelivered` and the
reason is shown, never left looking open. A handoff arriving in an idle session
starts a turn there by itself.

**Answering runs without a permission prompt.** The building session is often
the one nobody is watching, and a prompt on the reply would strand the finished
work there. The reply can only go back to the session that sent that handoff.
A rule you write that denies `handoff_reply` still wins, and so does an
organization's ceiling. *Sending* work out (`handoff_send`) stays under your
normal permission rules.

**Limits, set by the engine rather than by this mod:**

- A session cannot hand work to itself.
- A cloud session (a scheduled routine) receives a handoff only while it is
  running, and cannot send anything back.

## model-router

Each prompt is judged once by the engine's small, fast model. A quick question
answered in prose runs on **Claude Haiku 5.5** at low effort; everything else
stays on your model and its effort.

These keep your model:

- a failed or unsure classifier;
- a prompt over 600 characters, or a slash command;
- a subagent, which keeps whatever model it was given;
- a session resumed from a transcript, until a response has reported its size;
- a conversation past 100K tokens (configurable, as `maxContextTokens`).

If Haiku reaches for a tool, the turn was not as simple as it looked, and the
rest of it goes back to your model.

**Why 100K tokens, and why Haiku alone.** The prompt cache belongs to one
model, so a routed turn sends the whole conversation to Haiku uncached. At
list prices that is still cheaper than your model reading its own cache: Haiku
5.5 input is $0.10/M, against $0.20/M for an Opus 5.5 or Sonnet 5.5 cache read.
Haiku's input steps up to $0.50/M past 100K prompt tokens, where the cached read
wins, hence the default. Sonnet 5.5 is not offered as a target: uncached at
$2.00/M it is ten times an Opus cache read, so it saved money only in the first
few turns. These are API list prices; how a subscription's usage limits weigh
each model is not published, so treat the saving there as the likely direction
rather than a measured figure.

`/route` shows what it did and why, and the conversation's current size.
`/route on` and `/route off` switch it; that choice is remembered across
sessions.

## Developing

Validate and test a mod from this folder:

```
claude plugin validate ./model-router
claude plugin test ./model-router
```

The model-router has 20 tests and the session-relay 16. Its two key guards, the
relay's reply routing and the router's resumed-session gate, were checked by
deliberately breaking each and confirming the tests fail.

## License

MIT. See [LICENSE](LICENSE).
