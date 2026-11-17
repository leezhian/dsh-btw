/**
 * Client half of @local/dsh-btw (v0.7 — per-main-session temporary side chats).
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
  id: '@local/dsh-btw',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useSyncExternalStore = React.useSyncExternalStore
    const { useEffect, useMemo, useRef, useState, useCallback } = React

    const COMMAND_NAME = 'btw'
    const TAB_TYPE_ID = '@local/dsh-btw'
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

    class BtwController {
      constructor(ctx) {
        this.ctx = ctx
        this.reference = null
        this.mainId = null
        this.mountGeneration = 0
        this.discardTimer = null
        this.store = createStore({ phase: 'idle', childId: null, error: null })
      }

      get childId() { return this.store.getSnapshot().childId }

      binding() {
        const id = this.childId
        return id === null ? undefined : this.ctx.sessions.binding(id)
      }

      /** Create the side session beside one main session (no model call). */
      async ensure(mainId) {
        if (this.reference !== null && this.mainId === mainId) return this.reference
        if (this.reference !== null) {
          try { this.reference.release() } catch { /* already released */ }
          this.reference = null
        }
        this.store.set({ phase: 'creating', childId: null, error: null })
        // Remember the owner even on failure so retry() can rebuild.
        this.mainId = mainId
        try {
          const cwd = this.ctx.sessions.list.getSnapshot().byId?.[mainId]?.cwd
          const childId = await this.ctx.sessions.create(
            typeof cwd === 'string' && cwd !== '' ? { cwd } : {})
          const reference = this.ctx.sessions.retain(childId, { source: RETAIN_SOURCE })
          await reference.ready
          this.reference = reference
          this.mainId = mainId
          this.store.set({ phase: 'ready', childId, error: null })
          return reference
        } catch (error) {
          this.store.set({ phase: 'failed', childId: null, error: messageOf(error) })
          return null
        }
      }

      /** Retry a failed ensure for the same main session. */
      retry() {
        if (this.mainId === null) return Promise.resolve(null)
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

      cancel() {
        const binding = this.binding()
        if (binding !== undefined) void binding.session.cancel().catch(() => {})
      }

      /** Discard on tab close: mark, cancel, archive, release. */
      async discard() {
        this.clearDiscardTimer()
        const reference = this.reference
        const id = this.childId
        this.reference = null
        this.mainId = null
        this.store.set({ phase: 'idle', childId: null, error: null })
        if (id === null) return
        const binding = this.ctx.sessions.binding(id)
        // Durable marker: proves the discard path ran when reading the
        // session log afterwards, and names the row if archiving fails.
        try { await binding?.session.rename('btw-closed') } catch { /* best effort */ }
        try { await binding?.session.cancel() } catch { /* best effort */ }
        try { await this.ctx.workspaces.archiveSession(id, { stopActivity: true }) }
        catch (error) {
          console.error('dsh-btw: archiveSession failed', error)
        }
        try { reference?.release() } catch { /* already released */ }
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
        if (this.childId === null) return
        const ownerMainId = this.mainId
        if (ownerMainId === null) return
        this.mountGeneration += 1
        const generation = this.mountGeneration
        this.clearDiscardTimer()
        this.discardTimer = setTimeout(() => {
          this.discardTimer = null
          if (generation !== this.mountGeneration) return // remounted meanwhile
          const stillOpen = this.ctx.sidebarRight.openTabs.getSnapshot()
            .some(tab => tab.kind === 'btw' && tab.sessionId === ownerMainId)
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
.btw-row-button { background: none; border: none; cursor: pointer; padding: 3px;
  border-radius: 5px; color: var(--dsw-alias-label-secondary);
  display: inline-flex; align-items: center; }
.btw-row-button:hover { color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); }
.btw-open-button:hover { color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); }
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

    /** The plugin's mark: message-circle-plus (matches icon.svg), themed. */
    function BtwIcon({ size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { flex: 'none' },
      },
        h('path', { d: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719' }),
        h('path', { d: 'M8 12h8' }),
        h('path', { d: 'M12 8v8' }))
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

    function BtwBody({ controller, t, localizedPresetLabel }) {
      const state = useSource(controller.store)
      const binding = controller.binding()
      const eventWindow = useSource(binding?.eventSource)
      const sessionSnapshot = useSource(binding?.session)
      const rows = useMemo(() => foldRows(eventWindow), [eventWindow])
      const [draft, setDraft] = useState('')
      const [images, setImages] = useState([])
      const [menu, setMenu] = useState(null) // null | 'permission' | 'model'
      const [models, setModels] = useState(null) // provider-grouped catalog
      const flowRef = useRef(null)
      const pinnedRef = useRef(true)
      const fileRef = useRef(null)

      const running = sessionSnapshot?.running === true
      const pending = Array.isArray(sessionSnapshot?.pendingSubmissions)
        ? sessionSnapshot.pendingSubmissions : []
      const ready = state.phase === 'ready' && binding !== undefined
      const canSend = (draft.trim() !== '' || images.length > 0) && ready

      // Tab-body unmount schedules a discard; a fresh mount cancels it (pane
      // reshuffles remount within the window). Real closes and main-session
      // switches do not remount, so the side chat is discarded either way.
      useEffect(() => {
        controller.noteMounted()
        return () => { controller.scheduleDiscardIfClosed() }
      }, [controller])

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

      // Permission catalog (localized preset names) via the process-level
      // Remote; the current preset comes from the session's `permissions`
      // projection, falling back to the /permission command fold.
      const permissionsSource = binding?.session?.projections?.faceOf('permissions')
      const permissionsState = useSource(permissionsSource)
      const permission = useMemo(() => latestPermission(eventWindow), [eventWindow])
      const [permissionCatalog, setPermissionCatalog] = useState(null)
      useEffect(() => {
        if (!ready || permissionCatalog !== null) return
        let cancelled = false
        try {
          const remotePermission = controller.ctx.remote?.permissionPresets
          void remotePermission?.catalog?.().then(response => {
            if (cancelled) return
            if (response !== null && typeof response === 'object' && response.ok === true) {
              setPermissionCatalog(response.value ?? null)
            } else {
              setPermissionCatalog(null)
            }
          }).catch(() => { if (!cancelled) setPermissionCatalog(null) })
        } catch {
          if (!cancelled) setPermissionCatalog(null)
        }
        return () => { cancelled = true }
      }, [ready, permissionCatalog !== null])

      const presetValue = typeof permissionsState?.preset === 'string' && permissionsState.preset !== ''
        ? permissionsState.preset
        : permission?.current ?? null
      const catalogOptions = permissionCatalog?.options ?? null
      // Bilingual display: locale-aware name with the raw preset value beside it.
      // Chip echo: localized label only; the raw preset value stays in the
      // hover tooltip. Menus keep the localized label as well.
      const presetChipLabel = value => {
        const option = (catalogOptions ?? []).find(option => option.value === value)
        return localizedPresetLabel(value, option?.name)
      }
      const presetLabelOf = value => {
        const label = presetChipLabel(value)
        return label === value ? value : `${label} ${value}`
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

      // Load the model catalog once the side session is ready, so the model
      // chip can echo `model + effort` immediately (the shipped composer shows
      // the effort label without opening the menu). The Remote returns a
      // Result envelope; the catalog lives at `value.groups`, each group an
      // `{ id, models: [{ id, name?, reasoning? }] }` provider entry.
      useEffect(() => {
        if (!ready || models !== null) return
        let cancelled = false
        try {
          void controller.ctx.remote.session.modelCatalog().then(response => {
            if (cancelled) return
            if (response !== null && typeof response === 'object' && response.ok === true) {
              setModels(response.value ?? { groups: [] })
            } else {
              setModels({ groups: [] })
            }
          }).catch(() => { if (!cancelled) setModels({ groups: [] }) })
        } catch {
          if (!cancelled) setModels({ groups: [] })
        }
        return () => { cancelled = true }
      }, [ready, models])

      const selectModel = async (provider, model, reasoningEffort) => {
        setMenu(null)
        const id = controller.childId
        if (id === null) return
        const request = { sessionId: id, provider, model }
        if (reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort
        try {
          const result = await controller.ctx.remote.session.selectModel(request)
          if (result !== null && typeof result === 'object' && result.ok === false) {
            controller.store.set(s => ({ ...s, error: messageOf(result.error) }))
          }
        } catch (error) {
          controller.store.set(s => ({ ...s, error: messageOf(error) }))
        }
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
                      ? `${presetLabelOf(presetValue)} · ${presetValue}` : t('permission.title'),
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
                    onClick: () => setMenu(menu === 'model' || menu === 'models' || menu === 'efforts' ? null : 'model'),
                  }, modelEcho, h(Chevron, { open: menu !== null && menu !== 'permission' })),
                  menu !== null && menu !== 'permission'
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

    function BtwTitle({ sessionId, controllers, t }) {
      const controller = controllers.get(sessionId)
      const binding = controller?.binding()
      const snapshot = useSource(binding?.session)
      const running = snapshot?.running === true
      return h('span', { className: 'btw-tab-title' },
        h(BtwIcon, { size: 13 }),
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
        if (this.state.failed) return h(BtwBody, { controller, t, localizedPresetLabel })
        return children
      }
    }

    /**
     * Tab body: the native conversation mount, with the hand-built panel as
     * fallback (also used while the session is still being created, or when
     * framework props are absent). Owns the close-to-discard unmount signal
     * for both paths.
     */
    function NativeChatTab(props) {
      const { sessionId, controllers, t, localizedPresetLabel, SessionProvider, renderSlot } = props
      const controller = controllers.get(sessionId)
      // A btw tab whose owning main session has no live side chat is a
      // persisted zombie (e.g. after a restart); the sweep closes it and the
      // body renders nothing meanwhile.
      if (controller === undefined) return null
      const state = useSource(controller.store)
      useEffect(() => {
        controller.noteMounted()
        return () => { controller.scheduleDiscardIfClosed() }
      }, [controller])
      const reference = controller.reference
      if (state.phase !== 'ready' || reference === undefined || SessionProvider === undefined) {
        // Creating, or the framework props are unavailable: the hand-built
        // panel serves as its own complete interface.
        return h(BtwBody, { controller, t, localizedPresetLabel })
      }
      return h(ChatTabBoundary, { controller, t, localizedPresetLabel },
        // Styles must mount on the native path too: .btw-native's layout
        // lives in this stylesheet, which the fallback panel used to own.
        h(Styles, null),
        h('div', { className: 'btw-native', 'data-btw-native': '' },
          h(SessionProvider, { session: reference },
            renderSlot(CHAT_SEAT, {}))))
    }

    // ---------------------------------------------------------------- apply --

    return {
      inject: ['slots', 'sessions', 'locale', 'uiSession', 'remote', 'remote.session',
        'remote.permissionPresets', 'sidebarRight', 'sidebarRightTabs', 'workspaces'],
      apply(ctx) {
        const dictionaries = {
          zh: {
            'tab.title': '侧边聊天',
            'button.open': '侧边聊天',
            'button.open.title': '打开临时侧边聊天（不占用当前会话上下文）',
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
            'button.open': 'Side chat',
            'button.open.title': 'Open a temporary side chat',
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

        /** One live side chat per MAIN SESSION — no cross-session sharing. */
        const controllers = new Map() // mainId -> BtwController
        /** Coalesce concurrent opens per main session (double /btw races). */
        const inflight = new Map() // mainId -> Promise
        ctx.effect(() => () => {
          for (const controller of controllers.values()) void controller.discard()
          controllers.clear()
          inflight.clear()
        }, 'dsh-btw: controller teardown')

        /**
         * Open a FRESH side chat for the on-screen main session: discard that
         * session's previous chat first (cancel + archive, clearing its
         * sidebar row), then create a new session. Other main sessions' chats
         * are untouched. Concurrent invocations for the same main session
         * coalesce onto one operation.
         */
        const openAt = async (mainId, task = '') => {
          if (mainId === undefined) return
          const running = inflight.get(mainId)
          if (running !== undefined) return running
          const operation = (async () => {
            let controller = controllers.get(mainId)
            if (controller === undefined) {
              controller = new BtwController(ctx)
              controllers.set(mainId, controller)
            }
            await controller.discard()
            await controller.ensure(mainId)
            try { ctx.sidebarRight.openTab(TAB_KIND) } catch { /* no on-screen session */ }
            const text = task.trim()
            if (text !== '') await controller.prompt(text)
          })()
          inflight.set(mainId, operation)
          try { await operation } finally { inflight.delete(mainId) }
        }

        const open = (task = '') =>
          openAt(ctx.uiSession.adapter.current.getSnapshot()?.key, task)

        // /btw watcher — watermark so a closed tab never reopens from history.
        let unsubscribeEvents = null
        let attachedId = null
        let watermark = 0
        const detach = () => { unsubscribeEvents?.(); unsubscribeEvents = null; attachedId = null }
        const attach = mainId => {
          if (mainId === attachedId && unsubscribeEvents !== null) return
          detach()
          if (mainId === undefined) return
          const binding = ctx.sessions.binding(mainId)
          if (binding === undefined) return
          attachedId = mainId
          let high = 0
          for (const entry of binding.eventSource.getSnapshot().entries) {
            const seq = entry?.event?.seq
            if (typeof seq === 'number' && seq > high) high = seq
          }
          watermark = high
          const onWindow = () => {
            const { entries } = binding.eventSource.getSnapshot()
            let next = watermark
            for (const entry of entries) {
              const event = entry?.event
              if (event === undefined) continue
              const seq = typeof event.seq === 'number' ? event.seq : 0
              if (seq > next) next = seq
              if (seq <= watermark || event.type !== 'command/run') continue
              if (event.data?.name !== COMMAND_NAME) continue
              void open(typeof event.data.args === 'string' ? event.data.args : '')
            }
            watermark = next
          }
          unsubscribeEvents = binding.eventSource.subscribe(onWindow)
        }
        ctx.effect(() => {
          const current = ctx.uiSession.adapter.current
          const onCurrent = () => attach(current.getSnapshot()?.key)
          const unsubscribeCurrent = current.subscribe(onCurrent)
          const unsubscribeList = ctx.sessions.list.subscribe(onCurrent)
          onCurrent()
          return () => { unsubscribeCurrent(); unsubscribeList(); detach() }
        }, 'dsh-btw: /btw watcher')

        // Zombie-tab sweep: btw tab records persist in per-session layouts
        // (localStorage). After a restart no controller exists for any of
        // them, and a bodyless record would render a dead panel — close every
        // btw tab whose owning main session has no live side chat. Legitimate
        // tabs always have their controller registered BEFORE openTab.
        ctx.effect(() => {
          const onTabs = () => {
            for (const tab of ctx.sidebarRight.openTabs.getSnapshot()) {
              if (tab.kind !== TAB_KIND) continue
              if (controllers.has(tab.sessionId)) continue
              try { ctx.sidebarRight.closeIn(tab.sessionId, tab.tabId) }
              catch { /* already closed */ }
            }
          }
          return ctx.sidebarRight.openTabs.subscribe(onTabs)
        }, 'dsh-btw: zombie tab sweep')

        // Tab type + body + title. The keyed seats dispatch by registration id.
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_TYPE_ID,
          kind: TAB_KIND,
          title: () => t('tab.title'),
        }), 'dsh-btw: tab type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: TAB_TYPE_ID, locale: 'btw',
          // Declaring the session-scoped child seat is what makes the runtime
          // inject renderSlot + SessionProvider into this entry (scoped-slots
          // standardKit: `if (entry.children !== undefined)`).
          children: { [CHAT_SEAT]: { kind: 'single', scope: 'session' } },
        }, props => h(NativeChatTab, { ...props, controllers, t, localizedPresetLabel }))), 'dsh-btw: tab body')

        ctx.effect(() => ctx.slots.inject(CHAT_SEAT, () => ctx.slots.register({
          name: CHAT_SEAT,
        }, ConversationHost)), 'dsh-btw: native conversation host')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title', key: TAB_TYPE_ID,
        }, props => h(BtwTitle, { ...props, controllers, t }))), 'dsh-btw: tab title')

        // Session-row entry: a btw icon button on each session row's hover
        // strip (before archive/pin), opening THAT session's side chat.
        ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action', id: 'btw-open', order: 50,
          label: () => t('button.open'),
        }, ({ sessionId }) => h('button', {
          className: 'btw-row-button',
          title: t('button.open.title'),
          onClick: () => void openAt(sessionId, ''),
        }, h(BtwIcon, { size: 14 })))), 'dsh-btw: session row button')
      },
    }
  },
})
