/**
 * Host half of @kami232/dsh-btw (v0.7.1).
 *
 * The side chat is an ordinary session created and driven entirely by the
 * Client half; `/btw` is a CLIENT command contribution (no host descriptor,
 * no session-log records at all). The Host half only carries the
 * settlement-notice guard for LEGACY btw subagent children left by v0.3:
 * a restored continuable child loses its caller-delivery marking (framework
 * caveat in SubagentManager.restoreTarget) and would otherwise emit
 * "Background subagent … finished" notices into this conversation.
 */

export const inject = ['subagents', 'workspaceRegistry']

const BTW_LABEL = 'btw'

/**
 * Install the legacy settlement-notice guard.
 * @param ctx - context carrying the subagent seam and workspace registry.
 */
export function apply(ctx) {
  /** Durably catalogued legacy btw child ids below one parent (label 'btw'). */
  const legacyChildIds = async agentId => {
    const ids = new Set()
    try {
      for (const row of await ctx.subagents.listDescendants(agentId)) {
        if (row.kind === 'child' && row.label === BTW_LABEL) ids.add(row.id)
      }
    } catch { /* catalog unavailable in this profile */ }
    return ids
  }

  // The loop appends each step's claimed messages durably from the pre-step
  // decision, so rewriting `decision.messages` here removes a notice
  // completely — no model visibility, no durable event.
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision === undefined || decision === null || decision.kind === 'reject') return decision
    const messages = decision.messages
    if (!Array.isArray(messages) || messages.length === 0) return decision
    if (!messages.some(message =>
      message?.source?.kind === 'subagent-settled'
      && typeof message.source.senderSessionId === 'string')) return decision
    const ids = await legacyChildIds(payload.agent.id)
    if (ids.size === 0) return decision
    const filtered = messages.filter(message =>
      message?.source?.kind !== 'subagent-settled'
      || typeof message.source.senderSessionId !== 'string'
      || !ids.has(message.source.senderSessionId))
    if (filtered.length === messages.length) return decision
    return { ...decision, messages: filtered }
  }), 'dsh-btw: legacy settlement-notice guard')
}
