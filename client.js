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

    /**
     * v0.32 P0 — FACTORY SCOPE, NOT EFFECT SCOPE.
     *
     * Same defect as the graft console: this helper lived inside the fetch effect while
     * `write` is a component-scope closure, so every toggle threw
     * `ReferenceError: withTimeout is not defined` and no knob was ever written. The
     * live page showed it as a red `remote.commands.execute` card plus the "these are
     * the plugin defaults" line.
     */
    /**
     * v0.32 P1 — the envelope helpers live INSIDE makeBridge (only it uses them, and
     * the bridge is unit-tested by lifting it out of this bundle). `withTimeout` stays
     * at factory scope because the renderer needs it too.
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
.mc-badge{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3))}
.mc-crash{margin:24px;padding:16px 18px;border:1px solid #b91c1c;border-radius:10px;background:rgba(185,28,28,.08);color:#b91c1c;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.mc-crash h3{margin:0 0 8px;font-size:14px}
.mc-crash pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;opacity:.9}
`

    function makeBridge(ctx, host, slotProps) {
      /**
       * v0.32 P1 — PEELING THE COMMAND ENVELOPE.
       *
       * `commands.execute` resolves to a CommandExecution `{ kind, text }`, not to
       * `{ result: { kind, text } }`. The old code looked only at `.result` and then
       * fell back to `JSON.stringify(settled)` with `ok: true`, so the panel's state
       * became the ENVELOPE: no `skills`, no `ledger`, no `workspace`.
       *
       * Live symptoms from that one line: "记忆库 0 条", 工作区 "(未知)", 台账 "正在
       * 读取…", every switch OFF and un-flippable — while the write toast said
       * "已保存到全局配置" because the Host really had persisted it.
       */
      const tryParse = (text) => {
        try {
          return JSON.parse(text)
        } catch {
          return undefined
        }
      }

      const safeSlice = (value, limit) => {
        const cap = typeof limit === 'number' ? limit : 600
        try {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          if (typeof text !== 'string') return String(value)
          return text.length > cap ? `${text.slice(0, cap)}…` : text
        } catch {
          return '(无法序列化的返回值)'
        }
      }

      const unwrapExecution = (value) => {
        let node = value
        let decision = undefined
        for (let depth = 0; depth < 3 && decision === undefined; depth += 1) {
          if (node === null || node === undefined) return undefined
          if (typeof node === 'string') {
            const parsed = tryParse(node)
            if (parsed === undefined) return undefined
            node = parsed
            continue
          }
          if (typeof node !== 'object') return undefined
          if (typeof node.text === 'string') {
            decision = { kind: typeof node.kind === 'string' ? node.kind : 'success', text: node.text }
            break
          }
          const inner = node.result !== undefined ? node.result : node.value !== undefined ? node.value : node.execution
          if (inner === undefined) return undefined
          node = inner
        }
        return decision
      }

      /** Which call shape the host accepted last time, so a working contract costs one call. */
      let workingShape = undefined

      /** v0.32 P1: a gateway rejection has a code and a field — print them, not a JSON blob. */
      const describeRejection = (value) => {
        if (value !== null && value !== undefined && typeof value === 'object') {
          const failure = value.error !== null && typeof value.error === 'object' ? value.error : undefined
          if (failure !== undefined) {
            const code = typeof failure.code === 'string' ? failure.code : 'error'
            const details = failure.details !== null && typeof failure.details === 'object' ? failure.details : undefined
            const field = details !== undefined && typeof details.field === 'string' ? ` field=${details.field}` : ''
            return `${code}${field}`
          }
          if (value.ok === false) return 'ok:false（无错误码）'
        }
        return `无法识别的返回形状：${safeSlice(value, 200)}`
      }

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

      /**
       * v1.0.3 — a REAL session id (see the shapes comment at the call site): the gateway
       * accepts a bare id and then looks it up, so a placeholder always answers
       * `session/not-found`. Resolved once, from the slot snapshot or the Host index.
       */
      let cachedSessionId = ''
      const realSessionId = async () => {
        if (cachedSessionId.length > 0) return cachedSessionId
        const fromProps = sessionIdsFromProps()
        if (fromProps.length > 0) {
          cachedSessionId = fromProps[fromProps.length - 1]
          return cachedSessionId
        }
        try {
          const sessions = ctx.get ? ctx.get('sessions') : undefined
          if (sessions && typeof sessions.search === 'function') {
            for (const query of ['的', '我们', '我', 'the', 'a']) {
              try {
                const reply = await sessions.search(query, undefined)
                const items = reply && reply.ok === true && reply.value ? reply.value.items : undefined
                if (!Array.isArray(items)) continue
                for (const item of items) {
                  const id = item && typeof item.sessionId === 'string' ? item.sessionId : ''
                  if (id.length > 0) {
                    cachedSessionId = id
                    return cachedSessionId
                  }
                }
              } catch {
                // A search shape that throws simply contributes no id.
              }
            }
          }
        } catch {
          // No sessions face: report "no id" rather than inventing one.
        }
        return ''
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
         * v0.30 P0 — PURE GLOBAL MODE: a READ never depends on a session.
         *
         * v0.28 redirected an agent-less read to `/memory-console-global`, but still
         * needed a real agent for the write path and for any read where *some* session
         * happened to be resolvable. That left the panel's behaviour dependent on state
         * it cannot control — and on a root-scoped sidebar, that state is usually absent.
         *
         * Now the rule is unconditional:
         *
         *   - EVERY read goes to `/memory-console-global` with a shape-valid placeholder
         *     agent. The Host command reads nothing from `agent`, and the gateway only
         *     validates the SHAPE (`{ id: string }`), so this is sound rather than a
         *     pretence.
         *   - EVERY write goes to the real command with the same placeholder. The knobs
         *     are PROFILE settings (`configEditor.edit` writes `cordis.patch.yml`), and
         *     they are not attributable to a session, so requiring one was always wrong.
         *
         * The placeholder is a constant, so two panels cannot disagree about which
         * pseudo-session they are acting as.
         */
        const isWrite = /-set|-clear/u.test(line)
        const effectiveLine = isWrite ? line : line === '/memory-console' ? '/memory-console-global' : line
        const effectiveAgent = agent !== undefined && agent !== null ? agent : { id: GLOBAL_AGENT_ID }
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
           * v0.30 P0 — writes take the placeholder too.
           *
           * v0.28 refused a write without a real session, on the reasoning that a knob
           * change records WHO made it. That reasoning was wrong for these knobs: they are
           * PROFILE settings written by `configEditor.edit` into `cordis.patch.yml`, and
           * they belong to the workspace, not to a conversation. Requiring a session made
           * the panel inert in exactly the case the user hit — global mode with nothing
           * open — and the "有数据但无法点击" deadlock followed.
           *
           * The audit argument still has force, so the plugin's own audit line records the
           * command name and value; the pseudo-id is a constant, and the UI states plainly
           * that these are global settings. No session is invented as a REAL one.
           */
          /**
           * v0.32 P1 — THE FIRST ARGUMENT IS PROBED, NOT ASSUMED.
           *
           * Live failure: `gateway/input-invalid`, `field=agentId` on `commands/execute`.
           * The generated proxy does not document whether it wants the Agent object or the
           * bare id, and every shape the panel tried was rejected — which is why the
           * console never read anything. Probe in order, remember the winner, and treat a
           * rejection as a rejection (never as state).
           */
          const targetId =
            typeof effectiveAgent.id === 'string' && effectiveAgent.id.length > 0 ? effectiveAgent.id : GLOBAL_AGENT_ID
          /**
           * v1.0.3 — the probe answered the question: `id-string` is the contract, and the
           * id must name a REAL session. Live rejections (2026-11-04 21:39):
           *
           *   agent-object:   gateway/input-invalid field=agentId   (wrong type)
           *   id-string:      session/not-found                     (right type, id missing)
           *   agentId-object: gateway/input-invalid field=agentId   (wrong type)
           */
          const shapes = [
            { name: 'id-string', build: (id) => [id, effectiveLine, [], undefined] },
            { name: 'agent-object', build: (id) => [{ id }, effectiveLine, [], undefined] },
            { name: 'agentId-object', build: (id) => [{ agentId: id }, effectiveLine, [], undefined] },
          ]
          const ordered =
            workingShape === undefined
              ? shapes
              : [shapes.find((shape) => shape.name === workingShape), ...shapes.filter((shape) => shape.name !== workingShape)]
          const liveId = await realSessionId()
          /**
           * v1.0.3: the RESOLVED id goes first (an explicit choice must never be
           * second-guessed); the live id from the snapshot/index is the retry. In
           * production the placeholder earns `session/not-found` and the retry is what
           * makes the panel work.
           */
          const candidateIds = liveId.length > 0 && liveId !== targetId ? [targetId, liveId] : [targetId]
          for (const attemptId of candidateIds) {
            for (const shape of ordered) {
              if (shape === undefined) continue
              try {
                const settled = await commands.execute(...shape.build(attemptId))
                const execution = unwrapExecution(settled)
                if (execution !== undefined) {
                  workingShape = shape.name
                  return {
                    ok: execution.kind !== 'error',
                    text: execution.text,
                    via: `remote.commands.execute(${shape.name})`,
                    raw: settled,
                  }
                }
                failures.push(`${shape.name}: ${describeRejection(settled)}`)
              } catch (error) {
                failures.push(`${shape.name}: ${String((error && error.message) || error)}`)
              }
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

    /**
     * v0.29 P0 — THE STATE THE PANEL FALLS BACK TO WHEN THE HOST DOES NOT ANSWER.
     *
     * The reported failure was three symptoms with ONE cause: the fetch failed, `state`
     * stayed null, and everything derived from it therefore looked broken —
     *
     *   - every switch was `disabled: !canWrite` with `canWrite = state !== null`;
     *   - the ledger card rendered its "正在读取…" branch;
     *   - the summary said 读取失败 while no error card existed, because the failure
     *     path returned before setting an error in one branch.
     *
     * A panel that cannot reach the Host is still useful for READING: it can show what
     * the plugin would use by default. So a failed fetch now produces a REAL state object
     * carrying the shipped defaults, tagged `degraded` with the reason. The switches then
     * reflect those defaults (and say they are defaults), which is far more useful than
     * a dead panel — and a write attempt on them will still fail loudly, which is correct
     * because the default is not the live config.
     */
    function fallbackState(reason) {
      return {
        degraded: true,
        degradedReason: reason,
        config: {
          retrieval: true,
          workspaceIsolation: true,
          semanticFilter: true,
          taskAlignment: true,
          autoApprove: false,
          extraction: 'llm',
          floor: 0.2,
          threshold: 0.55,
        },
        workspace: '',
        memoryDir: '',
        skillsDir: '',
        counts: { skills: 0, active: 0, superseded: 0, scenes: 0, queued: 0 },
        scenes: [],
        skills: [],
        ledger: undefined,
        sessions: [],
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
         * `withTimeout` is defined at FACTORY scope (v0.32) — it used to be local to
         * this effect, which broke every `write` handler with a ReferenceError.
         */

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
            /**
             * v0.29 P0 — A THREE-SECOND BUDGET AND A REAL FALLBACK.
             *
             * Twelve seconds is indistinguishable from "hang" to someone watching a
             * panel. Worse, when it DID expire the panel was left with no state at all,
             * so every switch stayed disabled and the ledger section kept saying
             * "正在读取…" — three symptoms, one cause: `state` never became non-null.
             *
             * Two changes:
             *   1. the budget is 3s, which is longer than a healthy round trip and short
             *      enough to read as responsive;
             *   2. on failure the panel FALLS BACK to a known default state instead of
             *      leaving `state` null. The defaults are honest (they are what the
             *      plugin ships with) and the error card says the values are defaults,
             *      so the panel is usable for reading while the real values are unknown.
             */
            const reply = await withTimeout(bridge.state(target), 3_000, '读取控制台状态')
            if (!alive) return
            setVia(String((reply && reply.via) || ''))
            if (!reply || !reply.ok) {
              const reason = String((reply && reply.text) || '宿主没有返回内容')
              setError(reason)
              // Fall back to the shipped defaults so the panel is not dead. `degraded`
              // marks it, and the UI says so rather than pretending these are real.
              setState((prev) => (prev !== null && prev !== undefined ? prev : fallbackState(reason)))
              return
            }
            let parsed
            try {
              parsed = JSON.parse(reply.text)
            } catch (parseError) {
              const reason = `宿主返回的不是 JSON：${String((parseError && parseError.message) || parseError)}\n原始内容：${String(reply.text).slice(0, 500)}`
              setError(reason)
              setState((prev) => (prev !== null && prev !== undefined ? prev : fallbackState(reason)))
              return
            }
            setError('')
            setState(parsed)
          } catch (caught) {
            if (alive) {
              const reason = String((caught && caught.message) || caught)
              setError(reason)
              setState((prev) => (prev !== null && prev !== undefined ? prev : fallbackState(reason)))
            }
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
           * v0.30 P0: a write is a GLOBAL write. No session is needed, because the knob
           * lives in the profile patch rather than in a conversation. The bridge supplies
           * a constant placeholder so the gateway's shape check is satisfied, and the
           * Host's `configEditor.edit` decides where it lands.
           */
          const reply = await withTimeout(bridge.set(key, value), 3_000, '写入配置')
          setVia(String((reply && reply.via) || ''))
          if (!reply || !reply.ok) { setError(String((reply && reply.text) || '写入失败')); return }
          // A visible confirmation the user asked for by name: "已保存到全局配置".
          setNotice('已保存到全局配置')
          setError('')
          // Optimistic: show the new value immediately so the switch does not bounce
          // back while the refetch is in flight.
          setState((prev) => (prev === null ? prev : { ...prev, config: { ...((prev && prev.config) || {}), [key]: value } }))
          setTick((n) => n + 1)
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
      /**
       * v0.30 P0 — THE SWITCHES ARE ALWAYS OPERABLE ONCE STATE EXISTS.
       *
       * The user's rule, verbatim: as soon as `state` is loaded — even if it is the
       * degraded fallback — the Toggle's `disabled` must be false. There is no session
       * check anywhere in this decision any more, because the knobs it controls are
       * profile settings, not conversation settings.
       *
       * `state !== null` is therefore the WHOLE gate. A failed fetch populates the
       * fallback state, so the panel is operable even when the Host is unreachable —
       * and writes then fail loudly, which is the honest outcome.
       */
      const canWrite = state !== null && state !== undefined
      /** Whether a session is known. Used ONLY to label the panel, never to gate it. */
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

      /**
       * v0.32 P2 — A HEALTH BADGE, because every failure this panel has had looked the
       * same: plausible numbers that never move. Red = no Host data (or the Host said it
       * degraded); amber = data without the auxiliary reads; green = real Host state.
       */
      const health =
        phase === 'ready' && state.degraded !== true
          ? state.ledger === undefined && state.sessions === undefined
            ? { level: 'amber', text: '已连通 · 部分数据缺失', hint: '宿主返回了状态，但台账/会话列表为空，请点「刷新」。' }
            : { level: 'green', text: '宿主通道正常', hint: `桥接通道：${via || '（未知）'}` }
          : {
              level: 'red',
              text: phase === 'loading' ? '正在读取…' : '宿主通道未连通',
              hint: `${String(error || state?.degradedReason || '尚未拿到宿主状态').slice(0, 300)}`,
            }
      const healthColor = health.level === 'green' ? '#16a34a' : health.level === 'amber' ? '#b45309' : '#b91c1c'

      return h('div', { className: 'mc-root' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'head' }, [
          h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [
            h('h2', { key: 't', className: 'mc-h', style: { fontSize: '16px', margin: 0 } }, '记忆控制台 · dsh-memory'),
            h(
              'span',
              {
                key: 'health',
                className: 'mc-badge',
                title: health.hint,
                style: { color: healthColor, borderColor: healthColor, fontWeight: 600 },
              },
              `${health.level === 'green' ? '●' : health.level === 'amber' ? '▲' : '●'} ${health.text}`,
            ),
          ]),
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
        /**
         * v0.29 P0 — AN UNMISSABLE ERROR CARD.
         *
         * The report was "显示读取失败但下方没有渲染红卡", which is exactly what a
         * conditional `error ? … : null` produces when the failure path forgets to set
         * `error`. Two fixes:
         *
         *   1. the card is keyed on BOTH `error` and `state.degraded`, so any degraded
         *      state shows a card even if the message itself was lost;
         *   2. it is a plain inline-styled div with the raw text, not a themed component.
         *      A diagnostic that depends on the styling layer it is diagnosing is not a
         *      diagnostic.
         */
        /**
         * v0.30 P0 — THE RAW ERROR, ALWAYS VISIBLE.
         *
         * The user's rule: show the error first, debug afterwards. So this is a plain
         * inline-styled div — no theme class, no component — carrying the message AND a
         * JSON dump of the failure. If the panel is misbehaving, the panel is not allowed
         * to be the thing hiding why.
         */
        error || (state !== null && state !== undefined && state.degraded === true)
          ? h('div', {
              key: 'e',
              style: {
                border: '1px solid #b91c1c',
                borderRadius: '8px',
                padding: '12px 14px',
                background: 'rgba(185,28,28,.08)',
                color: '#b91c1c',
                font: '13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              },
            }, [
              h('div', { key: 't', style: { fontWeight: 600, marginBottom: '6px' } }, '读取失败'),
              h('div', { key: 'm' }, String(error || (state && state.degradedReason) || '(宿主没有返回可识别的错误信息)')),
              h('div', { key: 'raw', style: { marginTop: '8px', fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '11.5px', opacity: 0.85 } },
                '错误详情：' + JSON.stringify({
                  message: String(error || ''),
                  degradedReason: state && state.degradedReason ? String(state.degradedReason) : undefined,
                  via: via || undefined,
                })),
              h('div', { key: 'h', style: { marginTop: '8px', opacity: 0.8 } },
                '以上开关显示的是插件默认值，不是宿主的真实配置。点击「刷新」重试。'),
            ])
          : null,
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
