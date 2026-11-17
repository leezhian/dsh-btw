# @local/dsh-btw — btw side chat

English | [中文](README.zh.md)

A DeepSeek Harness bundle that adds a ChatGPT-style temporary side conversation:
open it beside your work, use it, close it, and it is gone — the main session's
context is never touched.

## What you get

- **Two entries**: the `/btw` command (slash menu row with the plugin mark, a
  localized label, and the `btw` alias) and a card on the right panel's start
  page.
- **The host's own conversation UI**: the side chat renders through the same
  `SessionProvider` + `conversation.content` mount the shipped subagent chat
  uses — real attachments, permission switching, model switching, and send /
  stop. No "New Session" workspace picker: it opens directly with an empty
  context.
- **Structural isolation**: the side chat is an ordinary session (the main
  session's working directory, no workspace, no subagent, no catalog entry).
  Nothing flows back into the main conversation — no result delivery, no
  notices, no subagent-badge growth — and creating it costs zero model calls.
- **Disposable by design**: closing the tab cancels and archives the session
  (it disappears from every list); the next `/btw` starts fresh. Switching the
  main session keeps each session's own side chat alive; concurrent opens
  coalesce.
- **Graceful degradation**: if the native mount ever throws, an error boundary
  falls back to a self-contained panel (streaming chat, image attachments,
  localized permission / model switchers) — never a blank tab.

## Pieces

| File | Role |
|---|---|
| `client.js` | Tab + start-page card + `/btw` client command; per-main-session chat lifecycle (create / prompt / discard), native conversation mount with fallback |
| `index.js` | Host-side guard for legacy v0.3 btw subagent children only |
| `docs/DETAIL.md` | Usage, isolation guarantees, and limitations |

## Install

In the DeepSeek Harness Web GUI: **Plugins → Add plugin**, select this
directory (`dsh-btw/`). Requires the standard web client composition
(`dsh-client-ui-conversation`, `dsh-client-ui-sidebar-right`), which ships with
DSH 0.2.2-rc.3 and later.
