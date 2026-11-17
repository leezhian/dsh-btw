# @local/dsh-btw

A DeepSeek Harness bundle that adds a Codex-CLI-style `/btw`: a throwaway side
conversation in the right panel, isolated from the main session.

- **Host half** (`index.js`): registers the `/btw` human command. Its records
  are log-only, so the main session's model context is untouched.
- **Client half** (`client.js`): watches the on-screen session for `/btw`
  invocations, creates a scratch session via `sessions.create` (same cwd, no
  workspace → invisible in the sidebar), retains it, and renders it in a
  right-sidebar tab. Prompts go through the standard session prompt Remote.
  Discard cancels + archives the scratch session.

See `docs/DETAIL.md` for usage, isolation guarantees, and limitations.

## Install (not yet installed)

In the DeepSeek Harness Web GUI: **Plugins → Add plugin**, select this
directory (`dsh-btw/`). Or with the `plugin_manager` tool:
`install_bundle` with this absolute directory as `target`.

Requires the Desktop/Web profile with the standard web client packages
(`dsh-client-ui-conversation`, `dsh-client-ui-sidebar-right`), which ship with
DSH 0.2.2-rc.3 and later.
