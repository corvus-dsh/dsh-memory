/**
 * dsh-memory — the memory console (Client half).
 *
 * WHAT THIS REMOVES
 *
 * The memory knobs (`retrieval`, `workspaceIsolation`, …) were only reachable by
 * hand-editing cordis.patch.yml and restarting, and inspecting what had actually
 * been learned meant reading files in `~/.agents/skills` by hand. The panel reads
 * the catalogue the Host already parses (scene / scope / workspace / provenance /
 * validity) and writes knobs through `configEditor`, so a toggle applies live and
 * survives a restart because it IS the config.
 *
 * The destructive-looking button is a MOVE: it quarantines this workspace's
 * records and reports the directory, because a debug convenience that erases
 * weeks of learned rules is one nobody clicks twice.
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory',
  /**
   * v0.21: `host` is the THIRD symbol the client sandbox hands the factory.
   *
   * The documented surface for a Client half is `(require, styles, host)` — the
   * package-private JSON RPC to this package's own Host half. The panel used
   * `ctx.get('remote')` instead, and on the live page that threw
   * `cannot get property "remote.commands" without inject`: `remote` is a GENERATED
   * namespace that only exists once api-remotes is declared in `dsh.client.inject`.
   * Keeping the namespace as a fallback costs nothing; making it primary is fatal.
   */
  factory(require, styles, host) {
    const React = require('react')
    const h = React.createElement
    const PANEL_KEY = 'memory-console'

    const CSS = `
.mc-root{display:flex;flex-direction:column;gap:16px;padding:20px 24px;height:100%;overflow:auto;color:var(--dsw-alias-text-primary,inherit);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.mc-card{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.25));border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,transparent)}
.mc-h{font-size:14px;font-weight:600;margin:0 0 10px}
.mc-sub{opacity:.65;font-size:12px;margin:0 0 12px}
.mc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-tertiary,rgba(128,128,128,.14))}
.mc-row:first-of-type{border-top:0}
.mc-hint{opacity:.6;font-size:11.5px}
.mc-sw{position:relative;width:40px;height:22px;border-radius:11px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18));cursor:pointer;padding:0;flex:0 0 auto}
.mc-sw[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:transparent}
.mc-sw i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .14s ease}
.mc-sw[aria-checked="true"] i{left:20px}
.mc-chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px}
.mc-chip{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3));background:transparent;border-radius:999px;padding:3px 10px;cursor:pointer;color:inherit;font:inherit}
.mc-chip[aria-pressed="true"]{background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;border-color:transparent}
.mc-table{width:100%;border-collapse:collapse}
.mc-table th,.mc-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-tertiary,rgba(128,128,128,.14));font-weight:400;vertical-align:top}
.mc-mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;opacity:.8}
.mc-tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3));white-space:nowrap}
.mc-human{border-color:#10b981;color:#047857}
.mc-dead{opacity:.5;text-decoration:line-through}
.mc-btn{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));border-radius:7px;padding:5px 11px;cursor:pointer;color:inherit;font:inherit}
.mc-btn:disabled{opacity:.5;cursor:default}
.mc-danger{border-color:#b91c1c;color:#b91c1c}
.mc-err{color:#b91c1c;white-space:pre-wrap}
.mc-ok{color:#047857;white-space:pre-wrap}
.mc-select{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));border-radius:7px;padding:5px 9px;color:inherit;font:inherit;max-width:340px}
.mc-sw[disabled]{opacity:.45;cursor:not-allowed}
.mc-crash{margin:24px;padding:16px 18px;border:1px solid #b91c1c;border-radius:10px;background:rgba(185,28,28,.08);color:#b91c1c;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.mc-crash h3{margin:0 0 8px;font-size:14px}
.mc-crash pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;opacity:.9}
`

    function makeBridge(ctx, host, slotProps) {
      /**
       * v0.24 — `gateway/arguments-invalid` on `commands/execute`, AND the stuck
       * "正在读取…".
       *
       * The Host registers `commands.execute(agent, line, attachments, signal)` where
       * `agent` is typed `Agent` = `{ id: SessionId }`: required, and validated. The
       * gateway rejects anything else with exactly the error the panel was showing.
       *
       * `agentOf()` used to do `ctx.get('sessions').list()`. The CLIENT `sessions`
       * service has NO `list()` method — its face is retain / using / retainInfo /
       * refreshProjections / search / fork / scope / binding. `list()` belongs to the
       * HOST store, a different object in a different process. So the call yielded
       * `undefined` on every render, `execute(undefined, …)` was rejected, and the
       * rejection surfaced as a red card (memory) or as a panel that never left the
       * loading line (graft).
       *
       * The fix asks the SLOT first: `main` is root-scoped, so it receives `useSessions`
       * — the supported selector for live sessions from a root panel. No `list()`
       * anywhere, and no invented agent.
       */
      /**
       * v0.26: the hook is ATTACHED by the component, because it arrives as a PROP.
       *
       * The `inject` callback for a root-scoped slot receives NO arguments (its
       * `InjectParams` tuple is empty), so reading `slotProps.useSessions` there always
       * produced `undefined`. The hook is a standard selector delivered to the COMPONENT,
       * which forwards it here through `attach()`.
       */
      let sessionsHook = (() => {
        if (slotProps === undefined || slotProps === null) return undefined
        return typeof slotProps.useSessions === 'function' ? slotProps.useSessions : undefined
      })()

      const sessionIdsFromProps = () => {
        try {
          const useSessions = sessionsHook
          if (typeof useSessions !== 'function') return []
          const snapshot = useSessions((value) => value)
          if (snapshot === undefined || snapshot === null) return []
          const list = Array.isArray(snapshot)
            ? snapshot
            : Array.isArray(snapshot.sessions)
              ? snapshot.sessions
              : Array.isArray(snapshot.list)
                ? snapshot.list
                : []
          const ids = []
          for (const entry of list) {
            const id =
              typeof entry === 'string'
                ? entry
                : entry && typeof entry.id === 'string'
                  ? entry.id
                  : typeof entry?.sessionId === 'string'
                    ? entry.sessionId
                    : ''
            if (id.length > 0) ids.push(id)
          }
          return ids
        } catch {
          return []
        }
      }

      /** One valid `{ id }` agent, or undefined with the reason recorded by the caller. */
      const agentOf = (preferredId) => {
        // v0.25: an EXPLICIT choice always wins. A human picking a session in the panel
        // is the unambiguous source of truth and must not be second-guessed by "newest".
        const ids = sessionIdsFromProps()
        if (typeof preferredId === 'string' && preferredId.length > 0) {
          // Even when the snapshot does not list it, an id the user chose is a real id:
          // the Host validates it and reports if it is gone. Refusing it here would make
          // the selector unable to recover from a stale snapshot.
          return { id: preferredId }
        }
        if (ids.length > 0) return { id: ids[ids.length - 1] }
        try {
          const sessions = ctx.get ? ctx.get('sessions') : undefined
          if (sessions && typeof sessions.list === 'function') {
            const list = sessions.list()
            if (Array.isArray(list) && list.length > 0) {
              const first = list[0]
              const id = typeof first === 'string' ? first : first && typeof first.id === 'string' ? first.id : ''
              if (id.length > 0) return { id }
            }
          }
        } catch {
          // Reported as "no session", which is the accurate statement.
        }
        return undefined
      }

      /**
       * v0.25: the session list, for the panel's selector.
       *
       * A root-scoped panel can legitimately see ZERO sessions — a fresh window with no
       * conversation. Reporting "no session" and stopping there leaves the panel useless,
       * so the ids are published and a human picks one explicitly.
       */
      const listSessions = () => {
        const ids = [...sessionIdsFromProps()]
        try {
          const sessions = ctx.get ? ctx.get('sessions') : undefined
          if (sessions && typeof sessions.list === 'function') {
            const list = sessions.list()
            if (Array.isArray(list)) {
              for (const entry of list) {
                const id = typeof entry === 'string' ? entry : entry && typeof entry.id === 'string' ? entry.id : ''
                if (id.length > 0 && !ids.includes(id)) ids.push(id)
              }
            }
          }
        } catch {
          // An unavailable service simply means no extra ids.
        }
        return ids
      }

      /**
       * v0.28: a shape-valid Agent for a session-independent command.
       *
       * `Agent` is `{ id: SessionId }`; the gateway checks the SHAPE and never the
       * existence. The Host side of `/memory-console-global` reads nothing from it. So a
       * placeholder is honest here — it is not a pretend session, it is the parameter the
       * contract demands for a request that has no session.
       */
      const GLOBAL_AGENT_ID = 'dsh-memory-console-global'

      const callHost = async (line, preferredId) => {
        const failures = []
        const agent = agentOf(preferredId)
        /**
         * v0.28 P0: when no session is known and the caller is a READ, redirect to the
         * global command rather than refusing. Writes never take this path.
         */
        const isWrite = /-set|-clear/u.test(line)
        const effectiveLine = agent === undefined && !isWrite && line === '/memory-console' ? '/memory-console-global' : line
        const commands = (() => {
          try {
            const remote = ctx && ctx.get ? ctx.get('remote') : undefined
            return remote && remote.commands
          } catch (error) {
            failures.push(`ctx.get('remote'): ${String((error && error.message) || error)}`)
            return undefined
          }
        })()

        if (commands && typeof commands.execute === 'function') {
          /**
           * v0.28 P0 — GLOBAL READS ALWAYS RUN; WRITES STILL NEED A REAL SESSION.
           *
           * The gateway validates `agent` by SHAPE (`{ id: string }`), never by
           * existence — which is why `gateway/arguments-invalid` appeared for `undefined`
           * and never for a well-formed id.
           *
           * READS through `/memory-console-global` read nothing from the agent, so a
           * shape-valid placeholder is sound and the panel finally gets its global data
           * (knobs, totals, scenes, ledger) with no session open.
           *
           * WRITES are different in kind: `/memory-console-set` records WHO changed a
           * knob, and an invented id would make that audit a lie. They still require a
           * real session and are refused without one.
           */
          const isWrite = /-set|-clear/u.test(line)
          const target = agent !== undefined && agent !== null
            ? agent
            : isWrite
              ? undefined
              : { id: GLOBAL_AGENT_ID }
          if (target === undefined) {
            failures.push('写入需要一个确定的会话（当前没有活动会话），已阻止发送')
          } else {
            try {
              const settled = await commands.execute(target, effectiveLine, [], undefined)
              const text = settled && settled.result && typeof settled.result.text === 'string' ? settled.result.text : undefined
              if (text !== undefined) return { ok: settled.result.kind !== 'error', text, via: 'remote.commands.execute' }
              if (settled !== undefined) return { ok: true, text: JSON.stringify(settled), via: 'remote.commands.execute' }
              failures.push('remote.commands.execute: returned undefined (the command name did not resolve)')
            } catch (error) {
              failures.push(`remote.commands.execute: ${String((error && error.message) || error)}`)
            }
          }
        } else {
          failures.push('remote.commands 不可用（inject 未生效或宿主未挂载）')
        }
        // The dynamic-package RPC: only present when this bundle runs as a DYNAMIC
        // package. An installed client module receives `require` alone.
        if (host !== undefined && typeof host.call === 'function') {
          try {
            const value = await host.call('commands.execute', { line })
            return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value), via: 'host.call(commands.execute)' }
          } catch (error) {
            failures.push(`host.call(commands.execute): ${String((error && error.message) || error)}`)
          }
        }
        return {
          ok: false,
          via: 'none',
          text:
            `面板无法调用宿主（${failures.length === 0 ? 'remote.commands 与 host.call 都不可用' : failures.join(' | ')}）。\n` +
            'Host 侧功能不受影响：可在输入框执行 /memory-console，或用记忆工具操作。',
        }
      }
      return {
        /**
         * v0.25: the session surface, so the panel can offer an explicit choice.
         *
         * sessions() is synchronous and pure (it reads the injected snapshot), so the
         * panel can call it on every render without a round trip.
         */
        /**
         * v0.26: the component hands over the `useSessions` hook it received.
         *
         * Until this is called, `sessions()` is empty and `canWrite()` is false, so no
         * request is attempted — the reported fix.
         */
        attach: (hook) => {
          if (typeof hook === 'function') sessionsHook = hook
        },
        sessions: () => listSessions(),
        /** Is there an agent right now? Decides read-only mode vs. interactive. */
        canWrite: () => agentOf() !== undefined,
        state: (sessionId) => callHost('/memory-console', sessionId),
        set: (key, value, sessionId) => callHost(`/memory-console-set ${key} ${value}`, sessionId),
        clear: (sessionId) => callHost('/memory-console-clear', sessionId),
      }
    }


    function Toggle({ label, hint, checked, onChange, disabled }) {
      return h('div', { className: 'mc-row' }, [
        h('span', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
          h('span', { key: 'a' }, label),
          hint ? h('span', { key: 'b', className: 'mc-hint' }, hint) : null,
        ]),
        h('button', {
          key: 's', type: 'button', role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label, className: 'mc-sw',
          // v0.25: read-only mode DISABLES the control instead of hiding it. A hidden
          // switch leaves the user wondering whether the feature exists; a disabled one
          // shows the current value AND that it cannot be changed right now.
          ...(disabled === true ? { disabled: true, title: '只读：没有确定的活动会话' } : {}),
          onClick: () => { if (disabled !== true) onChange(!checked) },
        }, h('i', null)),
      ])
    }

    function skillRow(skill) {
      // v0.23: a Host payload is DATA. `skill.invalidAt.length` on a missing field is
      // one of the ways a single malformed record blanked the whole panel.
      const data = skill || {}
      const invalidAt = typeof data.invalidAt === 'string' ? data.invalidAt : ''
      const dead = invalidAt.length > 0
      const supersedes = Array.isArray(data.supersedes) ? data.supersedes : []
      return h('tr', { key: String(data.name || Math.random()), className: dead ? 'mc-dead' : undefined }, [
        h('td', { key: 'n' }, [
          h('div', { key: 'a' }, data.title || data.name || '(未命名)'),
          h('div', { key: 'b', className: 'mc-mono' }, String(data.name || '')),
          h('div', { key: 'c', className: 'mc-hint' }, String(data.when || '')),
        ]),
        h('td', { key: 's' }, h('span', { className: 'mc-tag' }, String(data.scene || 'general'))),
        h('td', { key: 'p' }, [
          h('span', {
            key: 'a',
            className: `mc-tag${data.provenance === 'human' ? ' mc-human' : ''}`,
            title: data.provenance === 'human' ? '用户原话' : '工具/推断，请核实',
          }, String(data.provenance || 'inferred')),
          h('div', { key: 'b', className: 'mc-hint' }, String(data.scope || '')),
        ]),
        h('td', { key: 'w' }, [
          h('div', { key: 'a', className: 'mc-hint' }, data.workspace || '(无 provenance)'),
          dead ? h('div', { key: 'b', className: 'mc-hint' }, `失效于 ${invalidAt.slice(0, 10)}${data.supersededBy ? ` → ${data.supersededBy}` : ''}`) : null,
          supersedes.length > 0 ? h('div', { key: 'c', className: 'mc-hint' }, `取代了 ${supersedes.join(', ')}`) : null,
        ]),
        h('td', { key: 'e' }, String(data.evidence === undefined ? 0 : data.evidence)),
      ])
    }

    /**
     * v0.23 — ERROR BOUNDARY. See dsh-graft-slice/client.js for the full reasoning.
     *
     * Two facts drove this shape, both proven by test:
     *   1. A white panel reports nothing, so a render throw must become a red card.
     *   2. A try/catch around `createElement` CANNOT do it — createElement is lazy, and
     *      React invokes the component later, outside the catch. Only a real class
     *      boundary sits in the render phase.
     *
     * `React.Component` is feature-detected because it is not on the sandbox's
     * documented surface (`createElement` / `useState` / `useEffect`). When present the
     * panel gets a real boundary; when absent it renders unguarded. A boundary can only
     * add protection — it must never be the reason the panel disappears.
     */
    function guard(Component) {
      if (typeof React.Component !== 'function') return Component
      return class MemoryPanelBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { crash: null }
        }

        static getDerivedStateFromError(error) {
          return { crash: error }
        }

        componentDidCatch(error, info) {
          try {
            const detail = `${String((error && error.stack) || error)}\n\n组件栈：\n${String((info && info.componentStack) || '(无)')}`
            console.error(`[${PANEL_KEY}] 面板渲染失败：`, detail)
          } catch {
            // Logging must never be the second crash.
          }
        }

        render() {
          if (this.state.crash === null) return this.props.children
          const error = this.state.crash
          return h('div', { className: 'mc-crash' }, [
            h('h3', { key: 't' }, '控制台渲染失败'),
            h('div', { key: 'a' }, '面板内部抛出了未捕获异常，已被错误边界拦下（不再白屏）。完整堆栈已写入浏览器控制台。'),
            h('pre', { key: 'p' }, String((error && error.stack) || (error && error.message) || error)),
            h('div', { key: 'b', style: { marginTop: '10px', opacity: 0.75 } },
              '宿主侧功能不受影响：可直接在输入框执行 /memory-console 查看同样的数据。'),
          ])
        }
      }
    }

    /** Wrap the panel so a render throw becomes a card instead of an unmounted tree. */
    function withBoundary(Component) {
      const Boundary = guard(Component)
      if (Boundary === Component) return Component
      return function GuardedPanel(props) {
        return h(Boundary, null, h(Component, props))
      }
    }

    function MemoryConsole({ bridge, useSessions }) {
      /**
       * v0.26: hand the selector to the bridge BEFORE anything can request.
       *
       * Runs during render, above every effect, so by the time `refresh` can fire the
       * bridge already knows how to list sessions. With no hook the bridge stays empty
       * and NO request is made — which is the reported fix.
       */
      try {
        if (bridge !== undefined && typeof bridge.attach === 'function') bridge.attach(useSessions)
      } catch {
        // A bridge that cannot attach is a bridge that will report "no session".
      }
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [via, setVia] = React.useState('')
      const [scene, setScene] = React.useState('*')
      const [confirming, setConfirming] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      /**
       * v0.27 P0 — THE PANEL THAT NEVER WOKE UP.
       *
       * The report: the panel sat at "只读 / 没有活动会话" and stayed at "正在读取" even
       * after the user switched sessions. The bridge HAD the hook, so why?
       *
       * Because `useSessions` was being CALLED FROM AN EFFECT (through
       * `bridge.canWrite()`), which is not a render. It cannot subscribe, so a session
       * change never re-rendered this component. The panel was frozen at whatever the
       * snapshot said when it mounted — which, on a fresh window, is nothing.
       *
       * The fix is to call the hook HERE, during render, and let its RESULT drive the
       * component. A SnapshotSelectorHook subscribes internally, so a change to the
       * session list re-renders this component and the ids below are recomputed. That is
       * what "reactive" means, and it cannot be achieved from an effect.
       *
       * `useSessions` is called unconditionally — no early return, no condition — so the
       * hook order is stable across every render.
       */
      const readSessions = (hooks) => {
        try {
          if (typeof hooks !== 'function') return []
          const snapshot = hooks((value) => value)
          if (snapshot === undefined || snapshot === null) return []
          const list = Array.isArray(snapshot)
            ? snapshot
            : Array.isArray(snapshot.sessions)
              ? snapshot.sessions
              : Array.isArray(snapshot.all)
                ? snapshot.all
                : Array.isArray(snapshot.list)
                  ? snapshot.list
                  : []
          const ids = []
          for (const entry of list) {
            const id =
              typeof entry === 'string'
                ? entry
                : entry && typeof entry.id === 'string'
                  ? entry.id
                  : entry && typeof entry.sessionId === 'string'
                    ? entry.sessionId
                    : ''
            if (id.length > 0 && !ids.includes(id)) ids.push(id)
          }
          return ids
        } catch {
          return []
        }
      }

      /**
       * Called ONCE per render, unconditionally. Subscribing happens inside the hook, so
       * a session appearing/disappearing re-runs this component and everything derived
       * from `liveSessions` below follows.
       */
      const liveSessions = readSessions(useSessions)
      /**
       * A STABLE identity for "which sessions exist", used as an effect dependency.
       *
       * Arrays compare by reference in a dependency array, so passing `liveSessions`
       * would re-run the fetch on every render whenever the hook mints a fresh array.
       * The joined ids change only when the SET changes — which is exactly when a
       * refetch is warranted.
       */
      const sessionKey = liveSessions.join('\u0000')
      // The selector's own idea of "current", when it offers one. Used only as a default.
      const activeFromHook = (() => {
        try {
          if (typeof useSessions !== 'function') return ''
          const snapshot = useSessions((value) => value)
          if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return ''
          const candidate = snapshot.activeSessionId ?? snapshot.currentSessionId ?? snapshot.active ?? snapshot.current
          return typeof candidate === 'string' ? candidate : ''
        } catch {
          return ''
        }
      })()

      /**
       * v0.25 — THE SESSION THE PANEL ACTS ON.
       *
       * Empty means "follow the panel's default": the selector's active session, else the
       * newest live one. A root-scoped panel has no inherent binding, and the hook can
       * legitimately return nothing (a fresh window). An explicit choice is authoritative
       * and is never second-guessed.
       */
      const [picked, setPicked] = React.useState('')
      /**
       * v0.23 — THE BLANK PANEL. See the same note in dsh-graft-slice/client.js.
       *
       * The sidebar icon drew and the panel was white. The icon calls no hook; the
       * panel called `React.useCallback`, which is not on the React surface this
       * sandbox advertises (`createElement` / `useState` / `useEffect`). A missing
       * symbol throws during render, before anything is committed — a white page.
       *
       * `tick` replaces the memoised callback: state is stable by construction, so
       * bumping it re-runs the effect and there is no dependency array to get wrong.
       */
      const [tick, setTick] = React.useState(0)
      const refresh = () => setTick((value) => value + 1)

      React.useEffect(() => {
        let alive = true
        /**
         * v0.24: a HARD timeout on the fetch.
         *
         * The bridge awaits a Remote call. If the gateway never settles — a broken
         * connection, a channel that is mounted but not answering — the await never
         * returns and `busy` stays true forever, so the panel spins with no way to
         * recover. Twelve seconds is longer than any healthy round trip and short
         * enough that a user sees a real answer either way.
         */
        const withTimeout = (promise, ms, label) =>
          new Promise((resolve) => {
            let settled = false
            const timer = setTimeout(() => {
              if (settled) return
              settled = true
              resolve({ ok: false, via: 'timeout', text: `${label} 超时（${ms}ms 内宿主没有回应）` })
            }, ms)
            Promise.resolve(promise).then(
              (value) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                resolve(value)
              },
              (error) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                resolve({ ok: false, via: 'none', text: String((error && error.message) || error) })
              },
            )
          })

        const run = async () => {
          if (bridge === undefined) {
            if (alive) { setError('桥接未注入（slot inject 缺失）'); setBusy(false) }
            return
          }
          /**
           * v0.26 P0 — THE AGENT GUARD, BEFORE ANY REQUEST.
           *
           * This is the bug the user reported: the panel rendered its read-only UI
           * correctly, and then the background fetch STILL went out with an undefined
           * agent, so the gateway rejected it and the red `remote.commands.execute` card
           * appeared over a panel that was already correctly saying "read only".
           *
           * The UI state was right; the traffic was not. So the guard belongs HERE, at
           * the single choke point every request passes through, not in the renderer:
           *
           *   if no agent -> do not send, do not clear the data, do not raise an error.
           *
           * An error is also wrong here. "Nobody has picked a session yet" is a
           * NORMAL state on a root-scoped panel, not a failure, and printing it in red
           * teaches the user to ignore red.
           */
          /**
           * v0.27: resolve the target from the RENDER-TIME session list.
           *
           * `bridge.canWrite()` used to be asked here, and it called `useSessions` from
           * inside this effect — a hook invoked outside render, which cannot subscribe
           * and therefore never saw a session change. The ids are now computed during
           * render and captured here; switching a session re-runs this effect because
           * `sessionKey` is a dependency.
           */
          /**
           * v0.28 P0 — NO DEAD END: ALWAYS FETCH, AND LABEL WHAT YOU FETCHED.
           *
           * v0.26 refused to send anything without an agent, which stopped the abandoned
           * gateway call but ALSO stopped the global data (knobs, totals, scenes, ledger)
           * from ever loading. The user then saw a permanent "只读" with no numbers — a
           * correct guard producing a useless panel.
           *
           * The distinction that was missing:
           *
           *   session-scoped reads  -> need an agent; block without one
           *   global reads          -> need nothing; ALWAYS run
           *
           * The bridge already redirects an agent-less `/memory-console` to
           * `/memory-console-global`, so simply making the request is enough. What must
           * never happen is a WRITE in that state.
           */
          const target = picked.length > 0
            ? picked
            : activeFromHook !== ''
              ? activeFromHook
              : liveSessions.length > 0
                ? liveSessions[liveSessions.length - 1]
                : ''
          if (alive) setBusy(true)
          try {
            // No agent: the bridge sends the GLOBAL command with a shape-valid placeholder.
            const reply = await withTimeout(bridge.state(target), 12_000, '读取控制台状态')
            if (!alive) return
            setVia(String((reply && reply.via) || ''))
            if (!reply || !reply.ok) {
              setError(String((reply && reply.text) || '宿主没有返回内容'))
              return
            }
            let parsed
            try {
              parsed = JSON.parse(reply.text)
            } catch (parseError) {
              setError(`宿主返回的不是 JSON：${String((parseError && parseError.message) || parseError)}\n原始内容：${String(reply.text).slice(0, 500)}`)
              return
            }
            setError('')
            setState(parsed)
          } catch (caught) {
            if (alive) setError(String((caught && caught.message) || caught))
          } finally {
            if (alive) setBusy(false)
          }
        }
        void run()
        const timer = setInterval(() => { void run() }, 15000)
        return () => { alive = false; clearInterval(timer) }
        /**
         * v0.27: `sessionKey` (a plain string) instead of the arrays.
         *
         * A dependency array compares by reference, so passing `liveSessions` would
         * re-run the effect on every render if the hook returned a fresh array each time.
         * The joined ids change ONLY when the set of sessions changes, which is exactly
         * when a refetch is warranted.
         */
      }, [bridge, tick, picked, sessionKey])

      const write = async (key, value) => {
        try {
          /**
           * v0.27: the write carries the SAME session the panel is showing.
           *
           * `picked` empty means "the default", and the bridge resolves that identically
           * to `effectiveSession` below (hook's active -> newest live). Passing the
           * resolved id when we have one keeps the write and the display in agreement
           * even if the default shifts between renders.
           */
          const reply = await bridge.set(key, value, picked.length > 0 ? picked : undefined)
          setVia(String((reply && reply.via) || ''))
          if (!reply || !reply.ok) { setError(String((reply && reply.text) || '写入失败')); return }
          setNotice(String(reply.text || ''))
          setError('')
          setState((prev) => (prev === null ? prev : { ...prev, config: { ...((prev && prev.config) || {}), [key]: value } }))
        } catch (caught) {
          setError(String((caught && caught.message) || caught))
        }
      }

      const clear = async () => {
        setConfirming(false)
        try {
          const reply = await bridge.clear(picked)
          setVia(String((reply && reply.via) || ''))
          if (!reply || !reply.ok) { setError(String((reply && reply.text) || '清理失败')); return }
          setNotice(String(reply.text || ''))
          setError('')
          refresh()
        } catch (caught) {
          setError(String((caught && caught.message) || caught))
        }
      }

      // v0.23: every field read defensively. An incomplete Host payload must cost a
      // section, never the panel.
      const num0 = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      const config = state === null || state === undefined ? null : state.config || null
      const skillsRaw = state !== null && state !== undefined && Array.isArray(state.skills) ? state.skills : []
      const skills = skillsRaw.filter((skill) => skill !== null && typeof skill === 'object')
      const scenes = state !== null && state !== undefined && Array.isArray(state.scenes) ? state.scenes : []
      const counts = state !== null && state !== undefined && state.counts ? state.counts : {}
      const ledger = state !== null && state !== undefined && state.ledger ? state.ledger : undefined
      const shown = scene === '*' ? skills : skills.filter((skill) => skill.scene === scene)

      /**
       * v0.25: the session surface, read synchronously from the injected snapshot.
       *
       * sessions() is a pure read, so it is safe on every render. readOnly when there is
       * no resolvable agent AND no explicit choice: the panel then shows what it can and
       * disables the switches, instead of reporting a dead end.
       */
      /**
       * v0.27: the session list comes from the RENDER-TIME read, not from the bridge.
       *
       * The bridge's copy is whatever the hook returned the last time someone asked it —
       * and since that used to happen inside an effect, it never updated. `liveSessions`
       * is recomputed on every render and therefore follows a session switch.
       */
      /**
       * v0.28 P0 — WHERE THE SESSION LIST ACTUALLY COMES FROM, in priority order.
       *
       *   1. THE HOST PAYLOAD. `state.sessions` is produced by `sessions.list()` on the
       *      Host, which is the only place that method exists. This is authoritative and
       *      works even when the Client exposes nothing.
       *   2. THE HOOK. `useSessions`, when the owner actually projects something.
       *   3. Nothing.
       *
       * v0.27 relied on (2) alone. On this sidebar it returns an empty list, so the
       * selector never appeared even though a session was plainly open — the panel was
       * asking the one party that could not answer.
       */
      const hostSessions = state !== null && state !== undefined && Array.isArray(state.sessions)
        ? state.sessions
            .map((entry) => (entry && typeof entry.sessionId === 'string' ? entry.sessionId : typeof entry === 'string' ? entry : ''))
            .filter((id) => id.length > 0)
        : []
      const sessions = hostSessions.length > 0 ? hostSessions : liveSessions
      /** Where the list came from, so the UI can say it honestly. */
      const sessionSource = hostSessions.length > 0 ? 'host' : liveSessions.length > 0 ? 'hook' : 'none'
      /** The session this panel will act on. */
      const effectiveSession = picked.length > 0 ? picked : activeFromHook !== '' ? activeFromHook : sessions.length > 0 ? sessions[sessions.length - 1] : ''
      /**
       * v0.28: the switches are GLOBAL, so they are usable whenever the Host is reachable.
       *
       * v0.26 gated them on `effectiveSession`, which made sense when every command was
       * session-scoped. But `/memory-console-set` writes the profile patch — it is a
       * workspace-wide setting that has nothing to do with which session is open. Locking
       * it behind a session is what kept the panel inert in global mode.
       *
       * `canWrite` now means "the panel can talk to the Host at all". Session-scoped
       * controls (the watermark view) are greyed separately.
       */
      const canWrite = state !== null && state !== undefined
      /** A session exists to scope session-only controls against. */
      const hasSession = effectiveSession.length > 0

      /**
       * v0.24: THREE states, not two.
       *
       * "no data yet" and "went and got it, and it failed" must not render the same
       * line. The panel used to say 正在读取… whenever state was null — including after
       * a hard failure — which is a permanent spinner that reports nothing and looks
       * like a hang. `phase` makes the difference explicit:
       *
       *   loading  -> 正在读取…      (a fetch is in flight RIGHT NOW)
       *   failed   -> 读取失败        (it returned, with an error; the card shows why)
       *   ready    -> the real summary
       */
      const phase = state !== null && state !== undefined ? 'ready' : busy ? 'loading' : error.length > 0 ? 'failed' : 'loading'
      const summary =
        phase === 'ready'
          ? `工作区 ${state.workspace || '(未知)'} · 存储 ${state.skillsDir || '(未知)'}`
          : phase === 'failed'
            ? '未能从宿主读取状态（原因见下方红色卡片）；开关显示的是默认值，不是真实配置。'
            : '正在读取…'

      return h('div', { className: 'mc-root' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'head' }, [
          h('h2', { key: 't', className: 'mc-h', style: { fontSize: '16px' } }, '记忆控制台 · dsh-memory'),
          h('p', { key: 's', className: 'mc-sub' }, summary),
        ]),
        /**
         * v0.25 — THE SESSION SELECTOR.
         *
         * A root-scoped panel may see zero sessions. Reporting that as a dead end made
         * the console useless in exactly the situation a user opens it (a fresh window,
         * nothing running). The choices are:
         *
         *   - sessions available -> default to the newest, allow switching
         *   - none available     -> say so ONCE, and keep the READ-ONLY view alive so the
         *                           corpus total is still visible
         */
        h('div', { key: 'session', className: 'mc-card' }, [
          h('div', { key: 'hh', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
            h('h3', { key: 'h', className: 'mc-h', style: { margin: 0 } }, '目标会话'),
            /**
             * v0.27: a manual refresh, because "reactive" is a property of the host's
             * snapshot and this panel cannot verify it. A button that forces a fetch
             * turns an unverifiable assumption into something the user can override.
             */
            h('button', {
              key: 'rf',
              type: 'button',
              className: 'mc-btn',
              disabled: busy,
              onClick: refresh,
              title: '立即重新拉取状态（全局数据不需要会话）',
            }, busy ? '读取中…' : '刷新'),
          ]),
          h('p', { key: 's', className: 'mc-sub' },
            sessions.length === 0
              /**
               * v0.28: GLOBAL MODE is a real mode, not a degraded dead end.
               *
               * Everything above this line — the knobs, the corpus totals, the scenes,
               * the ledger epoch — is session-INDEPENDENT and is already loaded. Only the
               * live per-session part needs a session. So the message says what works,
               * and the switches below stay ENABLED because they are global settings.
               */
              ? '全局模式：以下开关作用于整个记忆库（与具体会话无关），可以直接调节并落盘。会话级的水位/选择在打开会话后出现。'
              : `命令会以会话 ${effectiveSession} 的身份执行（列表来源：${sessionSource === 'host' ? '宿主 sessions.list' : 'useSessions'}）。切换会立即重新读取。`),
          // The selector is rendered whenever a list exists — from EITHER source, which is
          // the entire point of v0.28.
          sessions.length === 0
            ? null
            : h('div', { key: 'r', className: 'mc-row' }, [
                h('span', { key: 'l', className: 'mc-label' }, '会话'),
                h('select', {
                  key: 'sel',
                  className: 'mc-select',
                  value: picked,
                  'aria-label': '目标会话',
                  onChange: (event) => {
                    setPicked(String(event.target.value || ''))
                    setState(null)
                    setError('')
                    setTick((value) => value + 1)
                  },
                }, [
                  h('option', { key: '', value: '' }, `（默认：${effectiveSession}）`),
                  ...sessions.map((id) => h('option', { key: id, value: id }, id)),
                ]),
              ]),
        ]),
        error ? h('div', { key: 'e', className: 'mc-card mc-err' }, error) : null,
        notice ? h('div', { key: 'n', className: 'mc-card mc-ok' }, notice) : null,
        h('div', { key: 'sw', className: 'mc-card' }, [
          h('h3', { key: 'h', className: 'mc-h' }, '核心开关'),
          h(Toggle, {
            key: 'r',
            label: '自动注入记忆提示（retrieval）',
            hint: '关掉后不再往对话里注入任何记忆；隔离与防污染仍在写入/读取端生效',
            checked: config ? config.retrieval === true : false,
            onChange: (next) => write('retrieval', next),
            disabled: !canWrite,
          }),
          h(Toggle, {
            key: 'w',
            label: '工作区硬隔离（workspaceIsolation）',
            hint: '跨工作区记忆一律不注入；建议保持开启',
            checked: config ? config.workspaceIsolation === true : false,
            onChange: (next) => write('workspaceIsolation', next),
            disabled: !canWrite,
          }),
          h(Toggle, {
            key: 's',
            label: 'LLM 语义裁决（semanticFilter）',
            hint: '低阈值召回后由模型判定是否适用；关掉则退化为纯词法阈值',
            checked: config ? config.semanticFilter === true : false,
            onChange: (next) => write('semanticFilter', next),
            disabled: !canWrite,
          }),
          h(Toggle, {
            key: 'ta',
            label: '任务对齐过滤（taskAlignment）',
            hint: '与当前任务无关的旧事故流水账一律不召回；修复类提问例外',
            checked: config ? config.taskAlignment === true : false,
            onChange: (next) => write('taskAlignment', next),
            disabled: !canWrite,
          }),
          // v0.20: the gate's own refusals, so "it did not recall" is explainable
          // from the panel instead of requiring the log.
          num0(state && state.blockedByTask) > 0
            ? h('p', { key: 'bt', className: 'mc-hint', style: { margin: '6px 0 0' } },
                `上一次检索：${num0(state.blockedByTask)} 条记忆因与当前任务无关被拒（事故流水账）。`)
            : null,
        ]),
        h('div', { key: 'cat', className: 'mc-card' }, [
          h('div', { key: 'h', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
            h('h3', { key: 't', className: 'mc-h', style: { margin: 0 } },
              state === null || state === undefined
                ? '记忆库'
                : `记忆库 · ${num0(counts.skills)} 条（生效 ${num0(counts.active)} / 失效 ${num0(counts.superseded)}）· 待审 ${num0(counts.queued)}`),
            h('button', { key: 'b', type: 'button', className: 'mc-btn', disabled: busy, onClick: refresh }, busy ? '读取中…' : '刷新'),
          ]),
          h('p', { key: 's', className: 'mc-sub' }, via ? `桥接通道：${via}` : '按 scene 过滤；human 来源带绿色标记，其余需要核实'),
          h('div', { key: 'chips', className: 'mc-chips' }, [
            h('button', { key: '*', type: 'button', className: 'mc-chip', 'aria-pressed': scene === '*' ? 'true' : 'false', onClick: () => setScene('*') }, `全部 ${skills.length}`),
            ...(scenes.map((name) => h('button', {
              key: String(name), type: 'button', className: 'mc-chip',
              'aria-pressed': scene === name ? 'true' : 'false',
              onClick: () => setScene(name),
            }, `${name} ${skills.filter((skill) => skill.scene === name).length}`))),
          ]),
          shown.length === 0
            ? h('div', { key: 'n', className: 'mc-hint' }, skills.length === 0 ? '记忆库为空。' : '该场景下没有记忆。')
            : h('table', { key: 'tb', className: 'mc-table' }, [
                h('thead', { key: 'th' }, h('tr', null, [
                  h('th', { key: 'a' }, '技能'),
                  h('th', { key: 'b' }, '场景'),
                  h('th', { key: 'c' }, '来源/范围'),
                  h('th', { key: 'd' }, '工作区'),
                  h('th', { key: 'e' }, '证据'),
                ])),
                h('tbody', { key: 'tb' }, shown.map(skillRow)),
              ]),
        ]),
        h('div', { key: 'ledger', className: 'mc-card' }, [
          h('h3', { key: 'h', className: 'mc-h' }, '台账状态（交接来源）'),
          // v0.23: `ledger` is a local guard now, and `ledger.epoch` is assumed to
          // exist only after being checked — the old code read `.epoch.retired`
          // straight off the payload and blanked the panel when the Host omitted it.
          ledger === undefined
            ? h('p', { key: 's', className: 'mc-sub' }, '正在读取…')
            : [
                h('p', { key: 'e', className: 'mc-sub', style: { margin: '0 0 6px' } },
                  `epoch retired ${num0(ledger.epoch && ledger.epoch.retired)} / transferred ${num0(ledger.epoch && ledger.epoch.transferred)}` +
                    `（本读取端支持到 ${ledger.supportedEpoch === undefined ? '(未知)' : ledger.supportedEpoch}）· 已退休 ${num0(ledger.retired)} · 已转移 ${num0(ledger.transferred)}`),
                ledger.deferred
                  ? h('p', { key: 'd', className: 'mc-sub', style: { color: '#b45309', margin: 0 } },
                      `本台账本轮被拒读，等待下一次完整写入（不猜测、不从半条记录抽取）：` +
                        (Array.isArray(ledger.skipped) ? ledger.skipped.map((skip) => `${skip && skip.file}:${skip && skip.reason}`).join('、') : '(未提供原因)'))
                  : h('p', { key: 'd', className: 'mc-sub', style: { margin: 0 } }, '台账可读，抽取按最后一次完整写入进行。'),
                h('p', { key: 'p', className: 'mc-hint', style: { margin: '4px 0 0' } }, ledger.graftDataDir || '(未配置)'),
              ],
        ]),
        h('div', { key: 'clear', className: 'mc-card' }, [
          h('h3', { key: 'h', className: 'mc-h' }, '数据清理（调试用）'),
          h('p', { key: 's', className: 'mc-sub' }, '把当前工作区的记忆移入隔离目录（不删除；global 与其它工作区保留）。'),
          confirming
            ? h('div', { key: 'c', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
                h('span', { key: 'q', className: 'mc-hint' }, '确认清空当前工作区的记忆？'),
                h('button', { key: 'y', type: 'button', className: 'mc-btn mc-danger', onClick: clear }, '确认清空'),
                h('button', { key: 'n', type: 'button', className: 'mc-btn', onClick: () => setConfirming(false) }, '取消'),
              ])
            : h('button', {
                key: 'b', type: 'button', className: 'mc-btn mc-danger',
                disabled: state === null || state === undefined,
                onClick: () => setConfirming(true),
              }, '一键清空当前工作区记忆'),
        ]),
        // v0.23: a raw dump, always present, so "is the Host returning data at all"
        // is answerable from the page instead of from devtools.
        h('details', { key: 'raw', className: 'mc-card' }, [
          h('summary', { key: 's', style: { cursor: 'pointer', fontSize: '12px', opacity: 0.7 } },
            '原始状态数据（排查用）'),
          h('pre', { key: 'p', className: 'mc-mono', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: '8px' } },
            state === null || state === undefined ? '(尚未读取)' : JSON.stringify(state, null, 2).slice(0, 8000)),
        ]),
      ])
    }

    /**
     * The sidebar cell renders the ICON ONLY.
     *
     * v0.22: it used to render an icon AND a text span '记忆', while the panellist
     * registration ALSO supplies `label: () => '记忆'` for the owner. Both drew text,
     * which is why the sidebar showed "记忆 记忆".
     */
    function SidebarEntry() {
      return h('span', { 'aria-hidden': true, style: { display: 'inline-flex', alignItems: 'center' } }, [
        h('svg', { key: 'i', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }, [
          h('path', { key: 'p', d: 'M4 6h16M4 12h16M4 18h10' }),
        ]),
      ])
    }

    return {
      // v0.22: 'remote' and 'remote.commands' are SERVICES; the Cordis property guard
      // reads exactly this array. `dsh.client.inject` orders loading, it grants nothing.
      inject: ['slots', 'remote', 'remote.commands'],
      apply(ctx) {
        // v0.24: build the bridge PER SLOT INSTANCE so it can read `useSessions` from
        // the root-scoped `main` slot props. Building it once here froze it before any
        // session existed, which is how every call went out with an undefined agent.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_KEY,
              inject: () => ({ bridge: makeBridge(ctx, host) }),
            },
            withBoundary(MemoryConsole),
          ),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 61, label: () => '记忆' }, withBoundary(SidebarEntry)),
        )
      },
      __bridgeFactory: makeBridge,
      /**
       * v0.23: test seams — see dsh-graft-slice/client.js for why rendering, not string
       * matching, is what catches a blank panel.
       */
      __panelForTest: MemoryConsole,
      __skillRowForTest: skillRow,
      __guardForTest: guard,
    }
  },
})
