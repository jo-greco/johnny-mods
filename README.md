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

One session hands work to another and gets the answer back.

- The model can do it itself with `handoff_send(to, task)` and
  `handoff_reply(id, result)`.
- `/handoff <session> <task>` does it from the prompt.
- `/handoffs` lists what is open, done or undelivered, both ways.
- The status line shows `relay: N in · M out open`.

Every handoff carries an id and the asking session's own id, so the answer finds
its way back. A send that does not arrive is marked `undelivered` and the
reason is shown, never left looking open.

**Limit, set by the engine rather than by this mod:** a cloud session (a
scheduled routine) can receive a handoff only while it is running, and cannot
send anything back. Routines report back through Notion instead.

## model-router

Each prompt is judged once by the engine's small, fast model. A quick question
answered in prose runs on a cheaper model; everything else stays on yours.

- The cheaper model is `claude-haiku-5-5` by default. `claude-sonnet-5-5` can be
  chosen in the config menu.
- A prompt over 600 characters, a failed or unsure classifier, and a subagent
  all keep your model.
- If the cheaper model reaches for a tool, the rest of that turn goes back to
  your model.
- Past 30 messages (configurable) nothing is routed. The prompt cache is per
  model, so a switch re-sends the whole conversation uncached, which can cost
  more than it saves.

`/route` shows what it did and why. `/route on` and `/route off` switch it;
that choice is remembered across sessions.

## Developing

Validate and test a mod from this folder:

```
claude plugin validate ./model-router
claude plugin test ./model-router
```

The model-router has 14 tests and the session-relay 13. The relay's
reply-routing test was checked by deliberately breaking the routing and
confirming it fails.
