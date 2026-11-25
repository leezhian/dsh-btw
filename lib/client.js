/**
 * Client half of dsh-btw (v0.7 — per-main-session temporary side chats).
 *
 * A temporary side chat, in the ChatGPT sense:
 * - `btw <question>` (or the sidebar-foot button) opens one side conversation;
 * - it is an ORDINARY session (main session's cwd, no workspace, no subagent,
 *   no catalog) — nothing can flow back into the main conversation, and the
 *   main session's subagent badge never grows;
 * - closing the tab discards it (cancel + archive → gone from every list);
 *   the next `btw` starts fresh;
 * - no opening question: the session is created with zero model calls and the
 *   first message is whatever the user types.
 */
window.__ModuleLoader__.load({
  id: '@kami232/dsh-btw',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useSyncExternalStore = React.useSyncExternalStore
    const { useEffect, useId, useMemo, useRef, useState, useCallback } = React

    const COMMAND_NAME = 'btw'
    const TAB_TYPE_ID = '@kami232/dsh-btw'
    const TAB_KIND = 'btw'
    const CHAT_SEAT = 'btw.chat.conversation'
    /** Retention label owned by the shipped sidebar-chat feature (honest stats). */
    const RETAIN_SOURCE = 'sidebarChat'
    const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    /** Remount-cancel window for close-to-discard (pane reshuffle protection). */
    const REMOUNT_CANCEL_WINDOW_MS = 300

    // ---------------------------------------------------------------- store --

    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          const merged = typeof next === 'function' ? next(snapshot) : next
          if (merged !== snapshot) { snapshot = merged; for (const l of listeners) l() }
        },
      }
    }

    function useSource(source, getSnapshot) {
      const getter = getSnapshot ?? (() => source?.getSnapshot?.())
      return useSyncExternalStore(
        useCallback(listener => source?.subscribe?.(listener) ?? (() => {}), [source]),
        getter,
        getter,
      )
    }

    function messageOf(error) {
      if (error === undefined || error === null) return 'unknown error'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string') return error.message
      try { return JSON.stringify(error) } catch { return String(error) }
    }

    // ----------------------------------------------------------- controller --

    let nextControllerInstanceId = 0

    class BtwController {
      constructor(ctx, { onDiscard } = {}) {
        this.ctx = ctx
        this.instanceId = ++nextControllerInstanceId
        this.onDiscard = onDiscard ?? null
        this.reference = null
        this.mainId = null
        this.mountGeneration = 0
        this.lifecycleGeneration = 0
        this.disposed = false
        this.ensuring = null
        this.discardTimer = null
        this.store = createStore({ phase: 'idle', childId: null, error: null })
      }

      get childId() { return this.store.getSnapshot().childId }

      binding() {
        const id = this.childId
        return id === null ? undefined : this.ctx.sessions.binding(id)
      }

      /** Mark this controller as starting creation before awaiting async steps. */
      beginCreating(mainId) {
        this.disposed = false
        this.mainId = mainId
        this.store.set({ phase: 'creating', childId: null, error: null })
      }

      /** Best-effort cancel, archive, and release of a side session. */
      async archiveAndRelease(id, reference) {
        if (id !== null && id !== undefined) {
          const binding = this.ctx.sessions.binding(id)
          // Durable marker: proves the discard path ran when reading the
          // session log afterwards, and names the row if archiving fails.
          try { await binding?.session.rename('btw-closed') } catch { /* best effort */ }
          try { await binding?.session.cancel() } catch { /* best effort */ }
          try { await this.ctx.workspaces.archiveSession(id, { stopActivity: true }) }
          catch (error) {
            console.error('dsh-btw: archiveSession failed', error)
          }
        }
        try { reference?.release() } catch { /* already released */ }
      }

      /** Create the side session beside one main session (no model call). */
      ensure(mainId) {
        if (this.disposed) return Promise.resolve(null)
        if (this.reference !== null && this.mainId === mainId) return Promise.resolve(this.reference)
        if (this.ensuring !== null && this.mainId === mainId) return this.ensuring
        const operation = (async () => {
          if (this.reference !== null) {
            const oldRef = this.reference
            const oldId = this.childId
            this.reference = null
            await this.archiveAndRelease(oldId, oldRef)
          }
          if (this.disposed) return null
          const gen = ++this.lifecycleGeneration
          this.store.set({ phase: 'creating', childId: null, error: null })
          // Remember the owner even on failure so retry() can rebuild.
          this.mainId = mainId
          let createdId = null
          let createdRef = null
          try {
            const cwd = this.ctx.sessions.list.getSnapshot().byId?.[mainId]?.cwd
            createdId = await this.ctx.sessions.create(
              typeof cwd === 'string' && cwd !== '' ? { cwd } : {})
            if (this.disposed || this.lifecycleGeneration !== gen) {
              await this.archiveAndRelease(createdId, null)
              return null
            }
            createdRef = this.ctx.sessions.retain(createdId, { source: RETAIN_SOURCE })
            await createdRef.ready
            if (this.disposed || this.lifecycleGeneration !== gen) {
              await this.archiveAndRelease(createdId, createdRef)
              return null
            }
            this.reference = createdRef
            this.mainId = mainId
            this.store.set({ phase: 'ready', childId: createdId, error: null })
            return createdRef
          } catch (error) {
            if (createdId !== null || createdRef !== null) {
              await this.archiveAndRelease(createdId, createdRef)
            }
            if (!this.disposed && this.lifecycleGeneration === gen) {
              this.store.set({ phase: 'failed', childId: null, error: messageOf(error) })
            }
            return null
          }
        })()
        this.ensuring = operation
        return operation.finally(() => {
          if (this.ensuring === operation) this.ensuring = null
        })
      }

      /** Retry a failed ensure for the same main session (coalesced via ensure). */
      retry() {
        if (this.disposed || this.mainId === null) return Promise.resolve(null)
        return this.ensure(this.mainId)
      }

      /** Send one message (text, optionally with image parts). */
      async prompt(text, images = []) {
        const trimmed = text.trim()
        if (trimmed === '' && images.length === 0) return
        const binding = this.binding()
        if (binding === undefined) return
        const content = []
        if (trimmed !== '') content.push({ type: 'text', text: trimmed })
        for (const image of images) {
          content.push({ type: 'image', mediaType: image.mediaType, data: image.data, name: image.name })
        }
        try {
          const result = await binding.session.prompt(content, 'queue')
          if (result !== undefined && result.ok === false) {
            this.store.set(s => ({ ...s, error: messageOf(result.error) }))
          }
        } catch (error) {
          this.store.set(s => ({ ...s, error: messageOf(error) }))
        }
      }

      /** Switch the side session's model and optional reasoning effort. */
      async selectModel(provider, model, reasoningEffort) {
        const id = this.childId
        if (id === null) return
        const request = { sessionId: id, provider, model }
        if (reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort
        try {
          const result = await this.ctx.remote.session.selectModel(request)
          if (result !== null && typeof result === 'object' && result.ok === false) {
            this.store.set(s => ({ ...s, error: messageOf(result.error) }))
          }
        } catch (error) {
          this.store.set(s => ({ ...s, error: messageOf(error) }))
        }
      }

      cancel() {
        const binding = this.binding()
        if (binding !== undefined) void binding.session.cancel().catch(() => {})
      }

      /** Discard on tab close or teardown: cancel in-flight creation, archive, release. */
      async discard() {
        this.clearDiscardTimer()
        this.disposed = true
        this.lifecycleGeneration += 1
        const ownerMainId = this.mainId
        const reference = this.reference
        const id = this.childId
        this.reference = null
        this.mainId = null
        this.store.set({ phase: 'idle', childId: null, error: null })
        if (ownerMainId !== null) this.onDiscard?.(ownerMainId, this)
        if (id === null && reference === null) return
        await this.archiveAndRelease(id, reference)
      }

      /**
       * Close signal, scoped by owner: the body unmounted. After a
       * remount-cancel window, check whether OUR main session's layout still
       * holds the btw tab — switching the main session leaves the tab record
       * in the original session's layout (keep alive), while a real close
       * removes exactly that record (discard). Scoping matters: the global
       * inventory also carries btw tabs persisted in OTHER sessions'
       * layouts, which must never keep this chat alive.
       */
      scheduleDiscardIfClosed() {
        const { phase, childId } = this.store.getSnapshot()
        if (this.disposed || (childId === null && phase !== 'creating' && phase !== 'failed')) return
        const ownerMainId = this.mainId
        if (ownerMainId === null) return
        this.mountGeneration += 1
        const generation = this.mountGeneration
        this.clearDiscardTimer()
        this.discardTimer = setTimeout(() => {
          this.discardTimer = null
          if (generation !== this.mountGeneration || this.disposed) return
          const stillOpen = this.ctx.sidebarRight.openTabs.getSnapshot()
            .some(tab => tab.kind === TAB_KIND && tab.sessionId === ownerMainId)
          if (stillOpen) return // session switch / pane hidden: keep the chat
          void this.discard()
        }, REMOUNT_CANCEL_WINDOW_MS)
      }

      /** Cancel a pending close-discard timer (remount or teardown). */
      clearDiscardTimer() {
        if (this.discardTimer !== null) {
          clearTimeout(this.discardTimer)
          this.discardTimer = null
        }
      }

      /** Mark a mount (cancels a pending discard scheduled by an unmount). */
      noteMounted() {
        this.mountGeneration += 1
        this.clearDiscardTimer()
      }
    }

    // ---------------------------------------------------------- chat folding --

    function textOfBlocks(blocks) {
      if (!Array.isArray(blocks)) return ''
      let out = ''
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') out += block.text
      }
      return out
    }

    function foldRows(eventWindow) {
      const rows = []
      for (const entry of eventWindow?.entries ?? []) {
        const event = entry?.event
        if (event === undefined) continue
        const data = event.data ?? {}
        switch (event.type) {
          case 'user/message': {
            if (data.source?.kind !== undefined && data.source.kind !== 'user') break
            const text = textOfBlocks(data.content)
            if (text !== '') rows.push({ key: `u${event.seq}`, kind: 'user', text })
            break
          }
          case 'assistant/message': {
            const text = textOfBlocks(data.message?.content)
            if (text !== '') {
              rows.push({
                key: `a${event.seq}`, kind: 'assistant', text,
                interrupted: data.interrupted === true,
              })
            }
            break
          }
          case 'assistant/live-chunk': {
            const chunk = data.chunk
            if (chunk?.type === 'text-delta') {
              const text = typeof chunk.text === 'string' ? chunk.text : ''
              if (text !== '') rows.push({ key: `l${event.seq}`, kind: 'stream', text })
            }
            break
          }
          case 'tool/call': {
            rows.push({ key: `t${event.seq}`, kind: 'tool', name: data.name ?? 'tool' })
            break
          }
          default:
            break
        }
      }
      return rows
    }

    // -------------------------------------------------------------- styles --

    const CSS = `
.btw-panel { display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 1.5; }
.btw-flow { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 8px; overscroll-behavior: contain; }
.btw-row-user { align-self: flex-end; max-width: 88%; padding: 6px 10px;
  border-radius: 10px; background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base); white-space: pre-wrap; word-break: break-word; }
.btw-row-assistant { align-self: flex-start; max-width: 95%; padding: 6px 10px;
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  white-space: pre-wrap; word-break: break-word; }
.btw-row-stream { align-self: flex-start; max-width: 95%; padding: 6px 10px;
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
  border: 1px dashed var(--dsw-alias-border-l2); opacity: .92;
  white-space: pre-wrap; word-break: break-word; }
.btw-row-tool { align-self: flex-start; color: var(--dsw-alias-label-secondary);
  font-size: 12px; padding: 0 4px; }
.btw-row-interrupted { font-style: italic; }
.btw-empty { margin: auto; text-align: center; color: var(--dsw-alias-label-secondary);
  display: flex; flex-direction: column; gap: 6px; padding: 24px; }
.btw-empty-title { font-weight: 600; color: var(--dsw-alias-label-primary); }
.btw-error { color: var(--dsw-alias-state-error-primary); padding: 4px 12px; }
.btw-composer { border: 1px solid var(--dsw-alias-border-l1); padding: 10px 12px 8px;
  background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column;
  gap: 4px; border-radius: 14px; margin: 0 10px 10px; }
.btw-attachments { display: flex; flex-wrap: wrap; gap: 6px; }
.btw-attachment { position: relative; }
.btw-attachment img { height: 44px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2); display: block; }
.btw-attachment-remove { position: absolute; top: -6px; right: -6px; width: 16px;
  height: 16px; border-radius: 50%; border: none; cursor: pointer; font-size: 11px;
  line-height: 1; background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary); box-shadow: 0 1px 3px var(--dsw-alias-border-l2); }
.btw-input { resize: none; border: none; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; min-height: 48px;
  max-height: 160px; padding: 2px 2px 6px; }
.btw-input:focus { outline: none; }
.btw-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: .85; }
.btw-actions { display: flex; gap: 8px; align-items: center; }
.btw-chip { position: relative; }
.btw-chip-button { background: none; border: none; cursor: pointer; font: inherit;
  font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 5px 8px;
  border-radius: 8px; max-width: 190px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
.btw-chip-button:hover { color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); }
.btw-chip-chevron { flex: none; opacity: .7; }
.btw-chip-sub { opacity: .65; margin-left: 4px; }
.btw-menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 10;
  min-width: 200px; max-height: 300px; overflow-y: auto;
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px; padding: 5px; box-shadow: 0 6px 18px rgb(0 0 0 / .22); }
.btw-menu-right { left: auto; right: 0; }
.btw-menu-item { display: flex; width: 100%; align-items: center; gap: 8px;
  text-align: left; background: none; border: none; cursor: pointer; font: inherit;
  font-size: 12.5px; color: var(--dsw-alias-label-primary); padding: 7px 9px;
  border-radius: 6px; }
.btw-menu-item:hover { background: var(--dsw-alias-bg-layer-2); }
.btw-menu-item[aria-checked="true"] { font-weight: 500; }
.btw-menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.btw-menu-value { color: var(--dsw-alias-label-secondary); }
.btw-menu-row-chevron { flex: none; opacity: .55; transform: rotate(-90deg); }
.btw-menu-section { font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary); padding: 6px 8px 2px; }
.btw-menu-backdrop { position: fixed; inset: 0; z-index: 9; }
.btw-exp { flex: none; font-size: 9px; letter-spacing: .06em; opacity: .55;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; padding: 0 3px; }
.btw-attach { background: none; border: none; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-size: 17px; line-height: 1;
  width: 28px; height: 28px; border-radius: 50%; padding: 0;
  display: flex; align-items: center; justify-content: center; }
.btw-attach:hover { color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); }
.btw-attach[disabled] { opacity: .4; cursor: default; }
.btw-spacer { flex: 1; }
.btw-send { width: 32px; height: 32px; border-radius: 50%; border: none;
  cursor: pointer; background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base); display: flex; align-items: center;
  justify-content: center; padding: 0; flex: none; }
.btw-send[disabled] { opacity: .45; cursor: default; }
.btw-send svg { display: block; }
.btw-tab-title { display: inline-flex; align-items: center; gap: 6px; }
.btw-native { position: absolute; inset: 0; display: flex;
  width: 100%; height: 100%; min-width: 0; min-height: 0; }
.btw-dot { width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-brand-primary); }
`

    // ----------------------------------------------------------- components --

    function Styles() {
      return h('style', null, CSS)
    }

    function FlowRow({ row }) {
      if (row.kind === 'user') return h('div', { className: 'btw-row-user' }, row.text)
      if (row.kind === 'assistant') {
        return h('div', {
          className: row.interrupted ? 'btw-row-assistant btw-row-interrupted' : 'btw-row-assistant',
        }, row.interrupted ? row.text + ' ⏹' : row.text)
      }
      if (row.kind === 'stream') return h('div', { className: 'btw-row-stream' }, row.text)
      if (row.kind === 'tool') return h('div', { className: 'btw-row-tool' }, '⚙ ' + row.name)
      return null
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
    }

    /** Small popover menu anchored above its trigger chip. */
    function ChipMenu({ onClose, rightAligned, children }) {
      useEffect(() => {
        const onKey = event => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(React.Fragment, null,
        h('div', { className: 'btw-menu-backdrop', onClick: onClose }),
        h('div', {
          className: rightAligned ? 'btw-menu btw-menu-right' : 'btw-menu',
          role: 'menu',
        }, children))
    }

    /** Monochrome 16px outline mark (DSH regular 1px stroke) for tab title and /btw menu. */
    function BtwIcon({ size = 16, className }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1, strokeLinejoin: 'round',
        className, 'aria-hidden': true, style: { flex: 'none' },
      },
        h('path', { d: 'M10.5 6.5V4C10.5 3.17 9.83 2.5 9 2.5H3C2.17 2.5 1.5 3.17 1.5 4V8C1.5 8.83 2.17 9.5 3 9.5V11.35L5.1 9.5H5.5' }),
        h('path', { d: 'M7 6.5H13C13.83 6.5 14.5 7.17 14.5 8V11C14.5 11.83 13.83 12.5 13 12.5V14.25L10.9 12.5H7C6.17 12.5 5.5 11.83 5.5 11V8C5.5 7.17 6.17 6.5 7 6.5Z' }))
    }

    /** Colored 36px DSH plugin artwork (matches icon.svg) for the right-sidebar guide card. */
    function BtwArtwork({ size = 36, className }) {
      const uid = typeof useId === 'function' ? useId().replace(/[^a-zA-Z0-9_-]/g, '') : 'btw'
      const gapId = `btw-gap-${uid}`
      const mainId = `btw-main-${uid}`
      const sideId = `btw-side-${uid}`
      return h('svg', {
        width: size, height: size, viewBox: '0 0 36 36', fill: 'none',
        className, 'aria-hidden': true, style: { flex: 'none' },
      },
        h('g', { mask: `url(#${gapId})` },
          h('path', {
            d: 'M9.8 7.5H20.7C22.25 7.5 23.5 8.75 23.5 10.3V16.7C23.5 18.25 22.25 19.5 20.7 19.5H13.8L10.3 22.85C10.02 23.12 9.55 22.92 9.55 22.53V19.5C8.14 19.37 7 18.17 7 16.7V10.3C7 8.75 8.25 7.5 9.8 7.5Z',
            fill: `url(#${mainId})`, fillOpacity: 0.86,
          })),
        h('path', {
          d: 'M17.3 14H26.2C27.75 14 29 15.25 29 16.8V22.2C29 23.67 27.86 24.87 26.45 25V28.03C26.45 28.42 25.98 28.62 25.7 28.35L22.2 25H17.3C15.75 25 14.5 23.75 14.5 22.2V16.8C14.5 15.25 15.75 14 17.3 14Z',
          fill: `url(#${sideId})`,
        }),
        h('path', {
          d: 'M18.2 18H25.3M18.2 21H23',
          stroke: '#FFFFFF', strokeWidth: 1.65, strokeLinecap: 'round',
        }),
        h('defs', null,
          h('mask', { id: gapId, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 36, height: 36 },
            h('rect', { width: 36, height: 36, fill: '#FFFFFF' }),
            h('rect', { x: 13.1, y: 12.6, width: 17.3, height: 13.8, rx: 4.2, fill: '#000000' })),
          h('linearGradient', { id: mainId, x1: 15.25, y1: 7.5, x2: 15.25, y2: 23.2, gradientUnits: 'userSpaceOnUse' },
            h('stop', { stopColor: '#69B9FF' }),
            h('stop', { offset: 1, stopColor: '#324DE2' })),
          h('linearGradient', { id: sideId, x1: 21.75, y1: 14, x2: 21.75, y2: 28.5, gradientUnits: 'userSpaceOnUse' },
            h('stop', { stopColor: '#5FE5BE' }),
            h('stop', { offset: 1, stopColor: '#229EA9' }))))
    }

    /** Downward chevron, baseline-aligned inside a chip button. */
    function Chevron({ open }) {
      return h('svg', {
        className: 'btw-chip-chevron', width: 10, height: 10,
        viewBox: '0 0 10 10', 'aria-hidden': true,
        style: open ? { transform: 'rotate(180deg)' } : undefined,
      },
        h('path', {
          d: 'M2 3.5L5 6.5L8 3.5', stroke: 'currentColor', strokeWidth: 1.4,
          strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none',
        }))
    }

    /** Shield glyph with the preset's inner mark (read/write/full/auto). */
    function ShieldGlyph({ value }) {
      const stroke = { stroke: 'currentColor', strokeWidth: 1.2, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }
      let inner = null
      if (value === 'read-only') {
        inner = h('path', { d: 'M3.9 6.2L5.1 7.4L8.1 4.5', ...stroke })
      } else if (value === 'workspace-write') {
        inner = h('path', { d: 'M4.1 7.9L7.9 4.1', ...stroke })
      } else if (value === 'danger-full-access') {
        inner = h(React.Fragment, null,
          h('path', { d: 'M6 3.8V6.4', ...stroke }),
          h('circle', { cx: 6, cy: 8.2, r: 0.7, fill: 'currentColor', stroke: 'none' }))
      } else if (value === 'auto') {
        inner = h('path', { d: 'M4 8.4L6 4.1L8 8.4M4.8 6.9H7.2', ...stroke })
      }
      return h('svg', {
        width: 14, height: 15, viewBox: '0 0 12 13', 'aria-hidden': true,
        style: { flex: 'none' },
      },
        h('path', {
          d: 'M6 1.2L10.6 2.9V6.2C10.6 9.4 6 11.8 6 11.8C6 11.8 1.4 9.4 1.4 6.2V2.9Z',
          ...stroke, strokeWidth: 1.3,
        }),
        inner)
    }

    /** Selected checkmark for menu rows. */
    function CheckMark() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, style: { flex: 'none' } },
        h('path', {
          d: 'M2.5 6.5L5 9L9.5 3.5', stroke: 'currentColor', strokeWidth: 1.6,
          fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    /** Right-pointing chevron for submenu rows. */
    function ChevronRight() {
      return h('svg', {
        className: 'btw-menu-row-chevron', width: 10, height: 10,
        viewBox: '0 0 10 10', 'aria-hidden': true,
      },
        h('path', {
          d: 'M2 3.5L5 6.5L8 3.5', stroke: 'currentColor', strokeWidth: 1.4,
          strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none',
        }))
    }

    // Parse `current preset X (available: a, b)` / `preset X` from the
    // /permission command's result text.
    function parsePermissionText(text) {
      if (typeof text !== 'string') return null
      const current = /current preset (\S+) \(available: ([^)]*)\)/.exec(text)
      if (current !== null) {
        return { current: current[1], options: current[2].split(',').map(s => s.trim()).filter(s => s !== '') }
      }
      const set = /^preset (\S+)$/.exec(text.trim())
      if (set !== null) return { current: set[1], options: null }
      return null
    }

    /** Latest /permission result folded from the child session's events. */
    function latestPermission(eventWindow) {
      const names = new Map()
      let result = null
      for (const entry of eventWindow?.entries ?? []) {
        const event = entry?.event
        if (event === undefined) continue
        if (event.type === 'command/run' && event.data?.name === 'permission') {
          names.set(event.data.commandId, true)
        } else if (event.type === 'command/done' && names.has(event.data?.commandId)) {
          const parsed = parsePermissionText(event.data?.text)
          if (parsed !== null) {
            result = parsed.options === null ? { ...parsed, options: result?.options ?? null } : parsed
          }
        }
      }
      return result
    }

    /** Load a Remote Result-envelope catalog once the side session is ready. */
    function useRemoteCatalog(ready, fetcher, fallback) {
      const [data, setData] = useState(null)
      useEffect(() => {
        if (!ready || data !== null) return
        let cancelled = false
        try {
          const promise = fetcher()
          if (promise === undefined || promise === null) {
            setData(fallback)
            return
          }
          void promise.then(response => {
            if (cancelled) return
            if (response !== null && typeof response === 'object' && response.ok === true) {
              setData(response.value ?? fallback)
            } else {
              setData(fallback)
            }
          }).catch(() => { if (!cancelled) setData(fallback) })
        } catch {
          if (!cancelled) setData(fallback)
        }
        return () => { cancelled = true }
      }, [ready, data !== null])
      return data
    }

    function BtwBody({ controller, t, localizedPresetLabel }) {
      const state = useSource(controller.store)
      const binding = controller.binding()
      const eventWindow = useSource(binding?.eventSource)
      const sessionSnapshot = useSource(binding?.session)
      const rows = useMemo(() => foldRows(eventWindow), [eventWindow])
      const [draft, setDraft] = useState('')
      const [images, setImages] = useState([])
      const [menu, setMenu] = useState(null) // null | 'permission' | 'model' | 'models' | 'efforts'
      const flowRef = useRef(null)
      const pinnedRef = useRef(true)
      const fileRef = useRef(null)

      const running = sessionSnapshot?.running === true
      const pending = Array.isArray(sessionSnapshot?.pendingSubmissions)
        ? sessionSnapshot.pendingSubmissions : []
      const ready = state.phase === 'ready' && binding !== undefined
      const canSend = (draft.trim() !== '' || images.length > 0) && ready
      const isModelMenu = menu === 'model' || menu === 'models' || menu === 'efforts'

      // Load catalogs once the side session is ready so chips can echo
      // localized preset names and `model + effort` before opening menus.
      const permissionCatalog = useRemoteCatalog(
        ready, () => controller.ctx.remote?.permissionPresets?.catalog?.(), null)
      const models = useRemoteCatalog(
        ready, () => controller.ctx.remote?.session?.modelCatalog?.(), { groups: [] })

      // Current model selection. The client-side projection view is
      // `{ lastUsed, next }` (wire view of the modelSelection fold); a fresh
      // session has neither until a selection or request is recorded, so fall
      // back to the deployment default from the catalog — the same derivation
      // the shipped composer uses (`projected.next ?? catalog.default`).
      const modelSource = binding?.session?.projections?.faceOf('modelSelection')
      const modelProjection = useSource(modelSource)
      const modelSelection = modelProjection?.next ?? modelProjection?.lastUsed ?? models?.default ?? null
      const currentModel = typeof modelSelection?.model === 'string'
        ? modelSelection.model : undefined

      // Current permission preset from the session's `permissions` projection,
      // falling back to the /permission command fold.
      const permissionsSource = binding?.session?.projections?.faceOf('permissions')
      const permissionsState = useSource(permissionsSource)
      const permission = useMemo(() => latestPermission(eventWindow), [eventWindow])

      const presetValue = typeof permissionsState?.preset === 'string' && permissionsState.preset !== ''
        ? permissionsState.preset
        : permission?.current ?? null
      const catalogOptions = permissionCatalog?.options ?? null
      // Chip echo: localized label only; tooltip adds the raw preset value once.
      const presetChipLabel = value => {
        const option = (catalogOptions ?? []).find(option => option.value === value)
        return localizedPresetLabel(value, option?.name)
      }
      const presetTooltip = value => {
        const label = presetChipLabel(value)
        return label === value ? value : `${label} · ${value}`
      }
      const presetOptions = (catalogOptions ?? (permission?.options ?? []).map(value => ({ value, name: value })))

      // Current model echo with its reasoning-effort label, resolved from the
      // catalog (e.g. `GLM-5.3-Flash Max`).
      const currentModelEntry = useMemo(() => {
        if (currentModel === undefined) return undefined
        const group = (models?.groups ?? []).find(group => group.id === modelSelection?.provider)
        return (group?.models ?? []).find(model => model.id === currentModel)
      }, [currentModel, models, modelSelection])
      const currentEffortId = typeof modelSelection?.reasoningEffort === 'string'
        ? modelSelection.reasoningEffort
        : (currentModelEntry?.reasoning?.defaultEffort ?? null)
      const currentEffortName = useMemo(() => {
        if (currentEffortId === null) return null
        const effort = (currentModelEntry?.reasoning?.efforts ?? []).find(e => e.id === currentEffortId)
        return effort?.name ?? currentEffortId
      }, [currentEffortId, currentModelEntry])
      const modelEcho = useMemo(() => {
        if (currentModel === undefined) return t('model.loading')
        const name = currentModelEntry?.name ?? currentModel
        return currentEffortName !== null ? `${name} ${currentEffortName}` : name
      }, [currentModel, currentModelEntry, currentEffortName])

      const selectModel = async (provider, model, reasoningEffort) => {
        setMenu(null)
        await controller.selectModel(provider, model, reasoningEffort)
      }

      /**
       * Pick a model from the list. Clicking the model already in effect is a
       * no-op (the reasoning effort must not change when nothing switched);
       * switching to another model carries an explicit effort over when the
       * target model supports the same effort id.
       */
      const selectModelFromList = (provider, model) => {
        if (provider === modelSelection?.provider && model === currentModel) {
          setMenu(null)
          return
        }
        const explicitEffort = modelSelection?.reasoningEffort
        let effort = undefined
        if (typeof explicitEffort === 'string') {
          const group = (models?.groups ?? []).find(entry => entry.id === provider)
          const target = (group?.models ?? []).find(entry => entry.id === model)
          const supported = (target?.reasoning?.efforts ?? []).some(e => e.id === explicitEffort)
          if (supported) effort = explicitEffort
        }
        void selectModel(provider, model, effort)
      }

      const selectPermission = async preset => {
        setMenu(null)
        try { await binding.session.command(`/permission ${preset}`) } catch { /* next fold refreshes */ }
      }

      useEffect(() => {
        const flow = flowRef.current
        if (flow !== null && pinnedRef.current) flow.scrollTop = flow.scrollHeight
      }, [rows, pending])

      const onFlowScroll = () => {
        const flow = flowRef.current
        if (flow === null) return
        pinnedRef.current = flow.scrollHeight - flow.scrollTop - flow.clientHeight < 40
      }

      const submit = async () => {
        if (!canSend || running) return
        const text = draft
        const sent = images
        setDraft('')
        setImages([])
        pinnedRef.current = true
        await controller.prompt(text, sent)
      }

      const onPickImages = async files => {
        const next = []
        for (const file of files ?? []) {
          if (!IMAGE_TYPES.has(file.type)) continue
          const dataUrl = await readFileAsDataUrl(file)
          next.push({
            mediaType: file.type,
            data: dataUrl.slice(dataUrl.indexOf(',') + 1),
            name: file.name,
            previewUrl: dataUrl,
          })
        }
        if (next.length > 0) setImages(current => [...current, ...next])
      }

      const showEmpty = rows.length === 0 && pending.length === 0
      const failed = state.phase === 'failed'

      return h('div', { className: 'btw-panel' },
        h(Styles, null),
        h('div', {
          className: 'btw-flow', ref: flowRef, onScroll: onFlowScroll,
          'aria-live': 'polite',
        },
          failed
            ? h('div', { className: 'btw-empty' },
                h('div', { className: 'btw-empty-title' }, t('failed.title')),
                h('div', null, state.error ?? ''),
                h('button', {
                  className: 'btw-chip-button',
                  style: { border: '1px solid var(--dsw-alias-border-l2)' },
                  onClick: () => void controller.retry(),
                }, t('retry')))
            : showEmpty
            ? h('div', { className: 'btw-empty' },
                h('div', { className: 'btw-empty-title' }, t('empty.title')),
                h('div', null, t('empty.hint')))
            : [
                ...rows.map(row => h(FlowRow, { key: row.key, row })),
                ...pending.map(item => h(FlowRow, {
                  key: `p${item.requestId}`, row: { kind: 'user', text: item.text },
                })),
                running && rows.length > 0 && rows[rows.length - 1].kind !== 'stream'
                  ? h('div', { key: 'working', className: 'btw-row-tool' }, t('working'))
                  : null,
              ],
        ),
        state.error !== null ? h('div', { className: 'btw-error' }, state.error) : null,
        h('div', { className: 'btw-composer' },
          images.length > 0
            ? h('div', { className: 'btw-attachments' },
                images.map((image, index) => h('div', {
                  key: index, className: 'btw-attachment',
                },
                  h('img', { src: image.previewUrl, alt: image.name ?? '' }),
                  h('button', {
                    className: 'btw-attachment-remove',
                    'aria-label': t('attachment.remove'),
                    onClick: () => setImages(current => current.filter((_, i) => i !== index)),
                  }, '×'))),
              )
            : null,
          h('textarea', {
            className: 'btw-input',
            value: draft,
            placeholder: ready ? t('placeholder') : t('status.opening'),
            rows: 2,
            disabled: !ready,
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
              }
            },
          }),
          h('div', { className: 'btw-actions' },
            h('button', {
              className: 'btw-attach', title: t('attachment.add'),
              disabled: !ready,
              onClick: () => fileRef.current?.click(),
            }, '+'),
            ready
              ? h('div', { className: 'btw-chip' },
                  h('button', {
                    className: 'btw-chip-button',
                    title: presetValue !== null
                      ? presetTooltip(presetValue) : t('permission.title'),
                    onClick: () => setMenu(menu === 'permission' ? null : 'permission'),
                  }, '🛡 ', presetValue !== null ? presetChipLabel(presetValue) : t('permission.loading'), h(Chevron, { open: menu === 'permission' })),
                  menu === 'permission'
                    ? h(ChipMenu, { onClose: () => setMenu(null) },
                        presetOptions.map(option => h('button', {
                          key: option.value, className: 'btw-menu-item', role: 'menuitemradio',
                          'aria-checked': option.value === presetValue,
                          title: option.value,
                          onClick: () => void selectPermission(option.value),
                        },
                          h(ShieldGlyph, { value: option.value }),
                          h('span', { className: 'btw-menu-label' },
                            localizedPresetLabel(option.value, option.name)),
                          option.value === 'auto' ? h('span', { className: 'btw-exp' }, 'EXP') : null,
                          option.value === presetValue ? h(CheckMark) : null)),
                        presetOptions.length === 0
                          ? h('div', { className: 'btw-menu-section' }, t('permission.loading'))
                          : null)
                    : null)
              : null,
            h('div', { className: 'btw-spacer' }),
            ready
              ? h('div', { className: 'btw-chip' },
                  h('button', {
                    className: 'btw-chip-button',
                    title: t('model.title'),
                    onClick: () => setMenu(isModelMenu ? null : 'model'),
                  }, modelEcho, h(Chevron, { open: isModelMenu })),
                  isModelMenu
                    ? h(ChipMenu, { onClose: () => setMenu(null), rightAligned: true },
                        menu === 'model'
                          ? [
                              h('button', {
                                key: 'model-row', className: 'btw-menu-item',
                                onClick: () => setMenu('models'),
                              },
                                h('span', { className: 'btw-menu-label' }, t('model.row')),
                                h('span', { className: 'btw-menu-value' }, currentModel ?? t('model.loading')),
                                h(ChevronRight)),
                              h('button', {
                                key: 'effort-row', className: 'btw-menu-item',
                                onClick: () => setMenu('efforts'),
                              },
                                h('span', { className: 'btw-menu-label' }, t('effort.row')),
                                h('span', { className: 'btw-menu-value' }, currentEffortName ?? t('model.loading')),
                                h(ChevronRight)),
                            ]
                          : [
                              menu === 'models'
                                ? (models === null
                                    ? h('div', { className: 'btw-menu-section' }, t('model.loading'))
                                    : (models.groups ?? []).map(group => h(React.Fragment, { key: group.id },
                                        h('div', { className: 'btw-menu-section' }, group.id),
                                        (group.models ?? []).map(model => h('button', {
                                          key: group.id + '/' + (model.id ?? model),
                                          className: 'btw-menu-item', role: 'menuitemradio',
                                          'aria-checked': (model.id ?? model) === currentModel
                                            && group.id === modelSelection?.provider,
                                          onClick: () => selectModelFromList(group.id, model.id ?? model),
                                        },
                                          h('span', { className: 'btw-menu-label' }, model.name ?? model.id ?? String(model)),
                                          (model.id ?? model) === currentModel && group.id === modelSelection?.provider ? h(CheckMark) : null)))))
                                : [
                                    // Default row: submit without an explicit effort.
                                    h('button', {
                                      key: 'effort-default', className: 'btw-menu-item', role: 'menuitemradio',
                                      'aria-checked': modelSelection?.reasoningEffort === undefined,
                                      onClick: () => void selectModel(modelSelection?.provider, currentModel),
                                    },
                                      h('span', { className: 'btw-menu-label' }, t('effort.default')),
                                      modelSelection?.reasoningEffort === undefined ? h(CheckMark) : null),
                                    ...(currentModelEntry?.reasoning?.efforts ?? []).map(effort => h('button', {
                                      key: effort.id, className: 'btw-menu-item', role: 'menuitemradio',
                                      'aria-checked': effort.id === currentEffortId
                                        && modelSelection?.reasoningEffort !== undefined,
                                      onClick: () => void selectModel(modelSelection?.provider, currentModel, effort.id),
                                    },
                                      h('span', { className: 'btw-menu-label' }, effort.name),
                                      effort.id === currentEffortId && modelSelection?.reasoningEffort !== undefined
                                        ? h(CheckMark) : null)),
                                  ],
                            ])
                    : null)
              : null,
            running
              ? h('button', {
                  className: 'btw-send', title: t('stop'),
                  onClick: () => controller.cancel(),
                },
                  h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true },
                    h('rect', { x: 1.5, y: 1.5, width: 9, height: 9, rx: 2, fill: 'currentColor' })))
              : h('button', {
                  className: 'btw-send', title: t('send'),
                  disabled: !canSend,
                  onClick: () => void submit(),
                },
                  h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
                    h('path', {
                      d: 'M8 13V3.5M8 3.5L3.8 7.7M8 3.5L12.2 7.7',
                      stroke: 'currentColor', strokeWidth: 1.8,
                      strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none',
                    }))),
          ),
          h('input', {
            ref: fileRef, type: 'file', accept: [...IMAGE_TYPES].join(','),
            multiple: true, style: { display: 'none' },
            onChange: event => {
              void onPickImages(event.target.files)
              event.target.value = ''
            },
          }),
        ),
      )
    }

    function BtwTitle({ sessionId, controllerStore, t }) {
      const controllers = useSource(controllerStore)
      const controller = sessionId !== undefined ? controllers.get(sessionId) : undefined
      useSource(controller?.store)
      const binding = controller?.binding()
      const snapshot = useSource(binding?.session)
      const running = snapshot?.running === true
      return h('span', { className: 'btw-tab-title' },
        h(BtwIcon, { size: 16 }),
        t('tab.title'),
        running ? h('span', { className: 'btw-dot' }) : null)
    }

    // ------------------------------------------------ native conversation --
    //
    // The primary tab body mounts the host's own Conversation for the child
    // session, through the same framework-standard props the shipped
    // subagent chat uses (blueprint:
    // @deepseek-ai/dsh-client-ui-subagent/src/client/sidebar-chat): the tab
    // seat declares a session-scoped child seat, SessionProvider binds the
    // retained session, and the `conversation.content` factory renders the
    // real composer — attachments, permission and model switchers included.
    // The hand-built panel above stays as the error-boundary fallback.

    /** Fixed Chat view selection (blueprint: FixedChatConversationView). */
    const FixedChatView = props => props.renderSlot('conversation.session', { view: 'chat' })

    /** Session-scoped conversation host (blueprint: ConversationSlotPanel). */
    const ConversationHost = ({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) => {
      const session = useSession(value => value)
      const conversation = useConversation(value => value)
      const activeNow = conversation.activeTargets.size > 0
        || (!session.blank && !session.awaitingFirstTurn)
        || session.running
      // Never enter the hero phase: the side chat's session already has its
      // working directory, so the "New Session" workspace/preset screen would
      // only add an irrelevant choice. Render the conversation directly —
      // empty context, composer ready.
      const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
      const settling = !activeNow && session.openState === 'loading' && summaryBlank !== true
      const phase = settling ? 'settling' : 'active'
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero: false }, {
        slots: { views: FixedChatView },
      })
    }

    /** Executes renderSlot INSIDE ChatTabBoundary so synchronous errors degrade cleanly. */
    function NativeSlotMount({ SessionProvider, reference, renderSlot }) {
      return h('div', { className: 'btw-native', 'data-btw-native': '' },
        h(SessionProvider, { session: reference },
          renderSlot(CHAT_SEAT, {})))
    }

    /** Degrades to the hand-built panel if the native mount throws. */
    class ChatTabBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('dsh-btw: native conversation mount failed, falling back', error)
      }

      render() {
        const { controller, t, localizedPresetLabel, children } = this.props
        if (this.state.failed) {
          return h(BtwBody, { key: controller.instanceId, controller, t, localizedPresetLabel })
        }
        return children
      }
    }

    /**
     * Tab body: the native conversation mount, with the hand-built panel as
     * fallback (also used while the session is still being created, or when
     * framework props are absent). Owns the close-to-discard unmount signal
     * for both paths, and keeps all Hooks unconditional across renders.
     */
    function NativeChatTab(props) {
      const {
        sessionId, controllerStore, openAt, isZombieTab, sweepZombies,
        t, localizedPresetLabel, SessionProvider, renderSlot, useTabInfo,
      } = props
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : undefined
      const tabId = tabInfo?.tab?.id
      const controllers = useSource(controllerStore)
      const controller = sessionId !== undefined ? controllers.get(sessionId) : undefined
      const state = useSource(controller?.store)
      const zombie = sessionId !== undefined && isZombieTab(sessionId, tabId)

      // Persisted post-restart zombie tabs are closed immediately rather than
      // revived; freshly opened tabs (e.g. from the right-sidebar guide card)
      // lazily create their side chat session.
      useEffect(() => {
        if (sessionId === undefined) return
        if (zombie) {
          sweepZombies()
          return
        }
        if (controller === undefined) void openAt(sessionId, { openTab: false })
      }, [zombie, controller, sessionId, openAt, sweepZombies])

      useEffect(() => {
        if (controller === undefined) return
        controller.noteMounted()
        return () => { controller.scheduleDiscardIfClosed() }
      }, [controller])

      if (zombie || controller === undefined) return null
      const reference = controller.reference
      if (state?.phase !== 'ready' || reference === null || reference === undefined
        || typeof SessionProvider !== 'function' || typeof renderSlot !== 'function') {
        // Creating, failed, or missing framework props: the hand-built panel
        // serves as its own complete interface (keyed per controller so
        // drafts and state never bleed across sessions).
        return h(BtwBody, { key: controller.instanceId, controller, t, localizedPresetLabel })
      }
      return h(ChatTabBoundary, { key: controller.instanceId, controller, t, localizedPresetLabel },
        // Styles must mount on the native path too: .btw-native's layout
        // lives in this stylesheet, which the fallback panel used to own.
        h(Styles, null),
        h(NativeSlotMount, { SessionProvider, reference, renderSlot }))
    }

    // ---------------------------------------------------------------- apply --

    return {
      inject: ['slots', 'sessions', 'locale', 'uiSession', 'remote', 'remote.session',
        'remote.permissionPresets', 'commandUi', 'sidebarRight', 'sidebarRightTabs',
        'workspaces'],
      apply(ctx) {
        const dictionaries = {
          zh: {
            'tab.title': '侧边聊天',
            'guide.description': '临时侧边聊天：与当前会话互不干扰的空白对话',
            'command.label': '侧边聊天',
            'command.description': '打开一个与当前会话隔离的临时侧边聊天',
            'empty.title': '侧边聊天',
            'empty.hint': '侧边聊天是临时聊天，关闭应用后会消失',
            'placeholder': '发消息或创建任务，/ 调用指令，@ 文件或对话',
            'send': '发送',
            'stop': '停止',
            'working': '…',
            'status.opening': '正在打开侧边聊天…',
            'attachment.add': '添加图片',
            'attachment.remove': '移除附件',
            'permission.title': '切换权限',
            'permission.auto': '自动审查',
            'permission.loading': '权限…',
            'model.title': '切换模型',
            'model.loading': '模型…',
            'model.row': '模型',
            'effort.row': '推理等级',
            'effort.default': '默认',
            'failed.title': '无法打开侧边聊天',
            'retry': '重试',
          },
          en: {
            'tab.title': 'Side chat',
            'guide.description': 'A throwaway side chat isolated from this session',
            'command.label': 'Side chat',
            'command.description': 'Open a temporary side chat isolated from this conversation',
            'empty.title': 'Side chat',
            'empty.hint': 'The side chat is temporary and disappears when the app closes.',
            'placeholder': 'Message or create a task, / commands, @ files or conversations',
            'send': 'Send',
            'stop': 'Stop',
            'working': '…',
            'status.opening': 'Opening side chat…',
            'attachment.add': 'Attach images',
            'attachment.remove': 'Remove attachment',
            'permission.title': 'Switch permission preset',
            'permission.auto': 'Auto review',
            'permission.loading': 'permission…',
            'model.title': 'Switch model',
            'model.loading': 'models…',
            'model.row': 'Model',
            'effort.row': 'Reasoning',
            'effort.default': 'Default',
            'failed.title': 'Could not open the side chat',
            'retry': 'Retry',
          },
        }
        ctx.effect(() => {
          const disposers = Object.entries(dictionaries)
            .map(([locale, dict]) => ctx.locale.register('btw', locale, dict))
          return () => { for (const dispose of disposers) dispose() }
        }, 'dsh-btw: locale')
        const t = ctx.locale.bind('btw')

        const currentMainSessionId = () => ctx.uiSession.adapter.current.getSnapshot()?.key

        // `/btw` as a CLIENT command contribution: the menu row gets the
        // localized label (the name `btw` renders beside it as the alias),
        // the plugin mark, and a localized description — and a bare
        // invocation submits nothing to the main session (perfect isolation).
        ctx.effect(() => ctx.commandUi.register({
          name: COMMAND_NAME,
          label: () => t('command.label'),
          description: () => t('command.description'),
          icon: iconProps => h(BtwIcon, { size: typeof iconProps?.size === 'number' ? iconProps.size : 16 }),
          available: () => true,
          ui: { kind: 'action', run: () => { void open() } },
        }), 'dsh-btw: /btw client contribution')
        /** Shipped permission dictionary (registered by ui-permission-presets). */
        let tPermission = null
        try { tPermission = ctx.locale.bind('permission.access') } catch { /* package absent */ }
        const PERMISSION_LABEL_KEYS = new Map([
          ['read-only', 'preset.readOnly'],
          ['workspace-write', 'preset.workspaceWrite'],
          ['danger-full-access', 'preset.fullAccess'],
        ])
        const PERMISSION_DEFAULT_LABELS = {
          'preset.readOnly': 'Read Only',
          'preset.workspaceWrite': 'Workspace Write',
          'preset.fullAccess': 'Full access',
        }
        /**
         * Locale-aware preset label, mirroring the shipped
         * `displayPermissionPreset`: the dictionary wins when the host name is
         * the default English label or the raw value; a host-configured
         * custom name is preserved as-is.
         */
        const localizedPresetLabel = (value, name) => {
          if (value === 'auto') {
            return tPermission !== null ? tPermission('auto.label') : t('permission.auto')
          }
          const key = PERMISSION_LABEL_KEYS.get(value)
          if (key !== undefined && tPermission !== null
            && (name === value || name === PERMISSION_DEFAULT_LABELS[key])) {
            return tPermission(key)
          }
          return name ?? value
        }

        /** One live side chat per MAIN SESSION — reactive so UI updates cleanly. */
        const controllerStore = createStore(new Map()) // mainId -> BtwController
        const getController = mainId => controllerStore.getSnapshot().get(mainId)
        const setController = (mainId, controller) => {
          controllerStore.set(prev => {
            const next = new Map(prev)
            next.set(mainId, controller)
            return next
          })
        }
        const deleteControllerIfSame = (mainId, controller) => {
          controllerStore.set(prev => {
            if (prev.get(mainId) !== controller) return prev
            const next = new Map(prev)
            next.delete(mainId)
            return next
          })
        }

        /** Coalesce concurrent opens per main session (double /btw races). */
        const inflight = new Map() // mainId -> Promise
        ctx.effect(() => () => {
          const live = [...controllerStore.getSnapshot().values()]
          controllerStore.set(new Map())
          inflight.clear()
          for (const controller of live) void controller.discard()
        }, 'dsh-btw: controller teardown')

        // Snapshot persisted post-restart zombie tabs BEFORE any user action.
        // Only these pre-existing tabs are swept; fresh tabs opened via the
        // Start/Guide card or `/btw` after startup are never closed by sweep.
        const zombieKey = (sessionId, tabId) => `${sessionId}\0${tabId}`
        const zombieTabKeys = new Set()
        for (const tab of ctx.sidebarRight.openTabs.getSnapshot()) {
          if (tab.kind === TAB_KIND) zombieTabKeys.add(zombieKey(tab.sessionId, tab.tabId))
        }
        const clearZombiesFor = sessionId => {
          const prefix = `${sessionId}\0`
          for (const key of [...zombieTabKeys]) {
            if (key.startsWith(prefix)) zombieTabKeys.delete(key)
          }
        }
        const isZombieTab = (sessionId, tabId) => {
          if (zombieTabKeys.size === 0) return false
          if (tabId !== undefined) return zombieTabKeys.has(zombieKey(sessionId, tabId))
          const prefix = `${sessionId}\0`
          for (const key of zombieTabKeys) {
            if (key.startsWith(prefix)) return true
          }
          return false
        }
        const sweepZombies = () => {
          if (zombieTabKeys.size === 0) return
          const present = new Set()
          for (const tab of ctx.sidebarRight.openTabs.getSnapshot()) {
            if (tab.kind !== TAB_KIND) continue
            const key = zombieKey(tab.sessionId, tab.tabId)
            present.add(key)
            if (!zombieTabKeys.has(key)) continue
            if (getController(tab.sessionId) !== undefined) {
              zombieTabKeys.delete(key)
              continue
            }
            try { ctx.sidebarRight.closeIn(tab.sessionId, tab.tabId) }
            catch { /* session not yet adopted or already closed */ }
          }
          for (const key of [...zombieTabKeys]) {
            if (!present.has(key)) zombieTabKeys.delete(key)
          }
        }

        ctx.effect(() => {
          sweepZombies()
          const deferSweep = () => {
            sweepZombies()
            if (typeof queueMicrotask === 'function') queueMicrotask(sweepZombies)
          }
          const disposers = [
            ctx.sidebarRight.openTabs.subscribe(sweepZombies),
          ]
          if (typeof ctx.uiSession?.adapter?.current?.subscribe === 'function') {
            disposers.push(ctx.uiSession.adapter.current.subscribe(deferSweep))
          }
          if (typeof ctx.sidebarRight.mounted?.subscribe === 'function') {
            disposers.push(ctx.sidebarRight.mounted.subscribe(deferSweep))
          }
          return () => { for (const dispose of disposers) dispose() }
        }, 'dsh-btw: zombie tab sweep')

        // Direct close hook from DSH sidebarRight: immediately discards the
        // side chat when the user closes the tab (and deletes its controller
        // entry so reopening via the Start/Guide card starts fresh).
        if (typeof ctx.sidebarRight.registerCloseHandler === 'function') {
          ctx.effect(() => ctx.sidebarRight.registerCloseHandler(TAB_KIND, sessionId => {
            const controller = getController(sessionId)
            if (controller !== undefined) void controller.discard()
          }), 'dsh-btw: close handler')
        }

        /**
         * Open a FRESH side chat for one main session: register a new
         * controller immediately, open the tab synchronously if still on that
         * session (preventing cross-session openTab races), discard any
         * previous side chat, and create the new session. Concurrent opens for
         * the same main session coalesce onto one operation.
         */
        const openAt = async (mainId, { openTab = true } = {}) => {
          if (mainId === undefined) return
          const running = inflight.get(mainId)
          if (running !== undefined) return running
          clearZombiesFor(mainId)
          const previous = getController(mainId)
          const controller = new BtwController(ctx, { onDiscard: deleteControllerIfSame })
          controller.beginCreating(mainId)
          setController(mainId, controller)
          if (openTab && currentMainSessionId() === mainId) {
            try { ctx.sidebarRight.openTab(TAB_KIND) } catch { /* no on-screen session */ }
          }
          const operation = (async () => {
            if (previous !== undefined) await previous.discard()
            if (controller.disposed) return
            await controller.ensure(mainId)
          })()
          inflight.set(mainId, operation)
          try { await operation } finally { inflight.delete(mainId) }
        }

        const open = () => openAt(currentMainSessionId(), { openTab: true })

        // Tab type + body + title. The keyed seats dispatch by registration id.
        /** IconProps adapter for the guide card (matches DSH colored guide artworks). */
        const GuideIcon = iconProps => h(BtwArtwork, {
          size: typeof iconProps?.size === 'number' ? iconProps.size : 26,
          className: iconProps?.className,
        })

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_TYPE_ID,
          kind: TAB_KIND,
          title: () => t('tab.title'),
          guide: [{
            id: 'btw', order: 30,
            title: () => t('tab.title'),
            description: () => t('guide.description'),
            icon: GuideIcon,
          }],
        }), 'dsh-btw: tab type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: TAB_TYPE_ID, locale: 'btw',
          // Declaring the session-scoped child seat is what makes the runtime
          // inject renderSlot + SessionProvider into this entry (scoped-slots
          // standardKit: `if (entry.children !== undefined)`).
          children: { [CHAT_SEAT]: { kind: 'single', scope: 'session' } },
        }, props => h(NativeChatTab, {
          ...props, controllerStore, openAt, isZombieTab, sweepZombies, t, localizedPresetLabel,
        }))), 'dsh-btw: tab body')

        ctx.effect(() => ctx.slots.inject(CHAT_SEAT, () => ctx.slots.register({
          name: CHAT_SEAT,
        }, ConversationHost)), 'dsh-btw: native conversation host')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title', key: TAB_TYPE_ID,
        }, props => h(BtwTitle, { ...props, controllerStore, t }))), 'dsh-btw: tab title')
      },
    }
  },
})
