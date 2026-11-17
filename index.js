/**
 * Host half of @local/dsh-btw (v0.7 — per-main-session temporary side chats).
 *
 * The side chat is an ordinary session created and driven entirely by the
 * Client half. The Host registers only:
 *
 * 1. the `/btw` human command (log-only records; the Client watches the
 *    command stream and opens the panel);
 * 2. a one-time-per-parent sweep that archives LEGACY btw subagent children
 *    left by v0.3 and earlier, draining the parent's subagent badge to zero;
 * 3. a settlement-notice guard covering those legacy children only — a
 *    restored continuable child loses its caller-delivery marking (framework
 *    caveat in SubagentManager.restoreTarget) and would otherwise emit
 *    "Background subagent … finished" notices into this conversation. Plain
 *    v0.4 sessions never produce such notices.
 */

export const inject = ['commands', 'subagents', 'workspaceRegistry']

const BTW_LABEL = 'btw'

/**
 * Register `/btw`, the legacy sweep, and the legacy notice guard.
 * @param ctx - context carrying the command registry and subagent seam.
 */
export function apply(ctx) {
  /** Parents whose legacy children were already archived this process. */
  const swept = new Set()

  const legacyChildIds = async agentId => {
    const ids = new Set()
    try {
      for (const row of await ctx.subagents.listDescendants(agentId)) {
        if (row.kind === 'child' && row.label === BTW_LABEL) ids.add(row.id)
      }
    } catch { /* catalog unavailable in this profile */ }
    return ids
  }

  ctx.effect(() => {
    const disposeCommand = ctx.commands.register({
      name: 'btw',
      description: 'Open a temporary side chat, isolated from this conversation',
      input: { hint: 'describe a quick side task (optional)' },
      handler: async invocation => {
        if (!swept.has(invocation.agent.id)) {
          swept.add(invocation.agent.id)
          void (async () => {
            for (const id of await legacyChildIds(invocation.agent.id)) {
              try {
                await ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
              } catch { /* already archived or removed */ }
            }
          })().catch(() => {})
        }
        return { kind: 'success', text: 'btw: side chat opened in the right panel.' }
      },
    })
    return disposeCommand
  }, 'dsh-btw: /btw command')

  // Legacy-only guard: rewrite the pre-step decision to drop settlement
  // notices from archived-era btw children. The loop appends each step's
  // claimed messages durably from this decision, so the notice is removed
  // completely — no model visibility, no durable event.
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision === undefined || decision === null || decision.kind === 'reject') return decision
    const messages = decision.messages
    if (!Array.isArray(messages) || messages.length === 0) return decision
    if (!messages.some(message =>
      message?.source?.kind === 'subagent-settled'
      && typeof message.source.senderSessionId === 'string')) return decision
    const ids = await legacyChildIds(payload.agent.id) // never throws
    if (ids.size === 0) return decision
    const filtered = messages.filter(message =>
      message?.source?.kind !== 'subagent-settled'
      || typeof message.source.senderSessionId !== 'string'
      || !ids.has(message.source.senderSessionId))
    if (filtered.length === messages.length) return decision
    return { ...decision, messages: filtered }
  }), 'dsh-btw: legacy settlement-notice guard')
}
