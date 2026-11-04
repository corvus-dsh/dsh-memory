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
`

    function makeBridge(ctx, host) {
      /**
       * v0.22: `remote.commands.execute(agent, line, attachments, signal)`.
       *
       * The earlier version passed `(method, args, ...)`, which is not the signature:
       * the Remote takes the receiving Agent first and a complete `/name args` line
       * second. It also needs `inject: ['remote', 'remote.commands']` — the service
       * keys, not the package name in `dsh.client` — or the Cordis guard throws
       * `cannot get property "remote.commands" without inject`.
       */
      const agentOf = () => {
        try {
          const sessions = ctx.get ? ctx.get('sessions') : undefined
          const list = sessions && typeof sessions.list === 'function' ? sessions.list() : undefined
          const first = Array.isArray(list) && list.length > 0 ? list[0] : undefined
          if (first !== undefined) return first
        } catch {
          // A missing sessions service is not fatal: the call reports it.
        }
        return undefined
      }
      const callHost = async (line) => {
        const failures = []
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
          try {
            const settled = await commands.execute(agentOf(), line, [], undefined)
            const text = settled && settled.result && typeof settled.result.text === 'string' ? settled.result.text : undefined
            if (text !== undefined) return { ok: settled.result.kind !== 'error', text, via: 'remote.commands.execute' }
            if (settled !== undefined) return { ok: true, text: JSON.stringify(settled), via: 'remote.commands.execute' }
            failures.push('remote.commands.execute: returned undefined (the command name did not resolve)')
          } catch (error) {
            failures.push(`remote.commands.execute: ${String((error && error.message) || error)}`)
          }
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
        state: () => callHost('/memory-console'),
        set: (key, value) => callHost(`/memory-console-set ${key} ${value}`),
        clear: () => callHost('/memory-console-clear'),
      }
    }


    function Toggle({ label, hint, checked, onChange }) {
      return h('div', { className: 'mc-row' }, [
        h('span', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
          h('span', { key: 'a' }, label),
          hint ? h('span', { key: 'b', className: 'mc-hint' }, hint) : null,
        ]),
        h('button', {
          key: 's', type: 'button', role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label, className: 'mc-sw',
          onClick: () => onChange(!checked),
        }, h('i', null)),
      ])
    }

    function skillRow(skill) {
      const dead = skill.invalidAt.length > 0
      return h('tr', { key: skill.name, className: dead ? 'mc-dead' : undefined }, [
        h('td', { key: 'n' }, [
          h('div', { key: 'a' }, skill.title || skill.name),
          h('div', { key: 'b', className: 'mc-mono' }, skill.name),
          h('div', { key: 'c', className: 'mc-hint' }, skill.when),
        ]),
        h('td', { key: 's' }, h('span', { className: 'mc-tag' }, skill.scene)),
        h('td', { key: 'p' }, [
          h('span', {
            key: 'a',
            className: `mc-tag${skill.provenance === 'human' ? ' mc-human' : ''}`,
            title: skill.provenance === 'human' ? '用户原话' : '工具/推断，请核实',
          }, skill.provenance),
          h('div', { key: 'b', className: 'mc-hint' }, skill.scope),
        ]),
        h('td', { key: 'w' }, [
          h('div', { key: 'a', className: 'mc-hint' }, skill.workspace || '(无 provenance)'),
          dead ? h('div', { key: 'b', className: 'mc-hint' }, `失效于 ${skill.invalidAt.slice(0, 10)}${skill.supersededBy ? ` → ${skill.supersededBy}` : ''}`) : null,
          skill.supersedes.length > 0 ? h('div', { key: 'c', className: 'mc-hint' }, `取代了 ${skill.supersedes.join(', ')}`) : null,
        ]),
        h('td', { key: 'e' }, `${skill.evidence}`),
      ])
    }

    function MemoryConsole({ bridge }) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [via, setVia] = React.useState('')
      const [scene, setScene] = React.useState('*')
      const [confirming, setConfirming] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      const refresh = React.useCallback(async () => {
        if (bridge === undefined) { setError('桥接未注入（slot inject 缺失）'); return }
        setBusy(true)
        try {
          const reply = await bridge.state()
          setVia(reply.via)
          if (!reply.ok) { setError(reply.text); return }
          setError('')
          setState(JSON.parse(reply.text))
        } catch (caught) {
          setError(String((caught && caught.message) || caught))
        } finally {
          setBusy(false)
        }
      }, [bridge])

      const write = React.useCallback(async (key, value) => {
        const reply = await bridge.set(key, value)
        setVia(reply.via)
        if (!reply.ok) { setError(reply.text); return }
        setNotice(reply.text)
        setError('')
        setState((prev) => (prev === null ? prev : { ...prev, config: { ...prev.config, [key]: value } }))
      }, [bridge])

      const clear = React.useCallback(async () => {
        setConfirming(false)
        const reply = await bridge.clear()
        setVia(reply.via)
        if (!reply.ok) { setError(reply.text); return }
        setNotice(reply.text)
        setError('')
        void refresh()
      }, [bridge, refresh])

      React.useEffect(() => { void refresh() }, [refresh])

      const config = state === null ? null : state.config
      const skills = state === null ? [] : state.skills
      const shown = scene === '*' ? skills : skills.filter((skill) => skill.scene === scene)

      return h('div', { className: 'mc-root' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'head' }, [
          h('h2', { key: 't', className: 'mc-h', style: { fontSize: '16px' } }, '记忆控制台 · dsh-memory'),
          h('p', { key: 's', className: 'mc-sub' },
            state === null ? '正在读取…' : `工作区 ${state.workspace} · 存储 ${state.skillsDir}`),
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
          }),
          h(Toggle, {
            key: 'w',
            label: '工作区硬隔离（workspaceIsolation）',
            hint: '跨工作区记忆一律不注入；建议保持开启',
            checked: config ? config.workspaceIsolation === true : false,
            onChange: (next) => write('workspaceIsolation', next),
          }),
          h(Toggle, {
            key: 's',
            label: 'LLM 语义裁决（semanticFilter）',
            hint: '低阈值召回后由模型判定是否适用；关掉则退化为纯词法阈值',
            checked: config ? config.semanticFilter === true : false,
            onChange: (next) => write('semanticFilter', next),
          }),
          h(Toggle, {
            key: 'ta',
            label: '任务对齐过滤（taskAlignment）',
            hint: '与当前任务无关的旧事故流水账一律不召回；修复类提问例外',
            checked: config ? config.taskAlignment === true : false,
            onChange: (next) => write('taskAlignment', next),
          }),
          // v0.20: the gate's own refusals, so "it did not recall" is explainable
          // from the panel instead of requiring the log.
          state && state.blockedByTask
            ? h('p', { key: 'bt', className: 'mc-hint', style: { margin: '6px 0 0' } },
                `上一次检索：${state.blockedByTask} 条记忆因与当前任务无关被拒（事故流水账）。`)
            : null,
        ]),
        h('div', { key: 'cat', className: 'mc-card' }, [
          h('div', { key: 'h', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
            h('h3', { key: 't', className: 'mc-h', style: { margin: 0 } },
              state === null ? '记忆库' : `记忆库 · ${state.counts.skills} 条（生效 ${state.counts.active} / 失效 ${state.counts.superseded}）· 待审 ${state.counts.queued}`),
            h('button', { key: 'b', type: 'button', className: 'mc-btn', disabled: busy, onClick: refresh }, busy ? '读取中…' : '刷新'),
          ]),
          h('p', { key: 's', className: 'mc-sub' }, via ? `桥接通道：${via}` : '按 scene 过滤；human 来源带绿色标记，其余需要核实'),
          h('div', { key: 'chips', className: 'mc-chips' }, [
            h('button', { key: '*', type: 'button', className: 'mc-chip', 'aria-pressed': scene === '*' ? 'true' : 'false', onClick: () => setScene('*') }, `全部 ${skills.length}`),
            ...(state === null ? [] : state.scenes.map((name) => h('button', {
              key: name, type: 'button', className: 'mc-chip',
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
          state === null || state.ledger === undefined
            ? h('p', { key: 's', className: 'mc-sub' }, '正在读取…')
            : [
                h('p', { key: 'e', className: 'mc-sub', style: { margin: '0 0 6px' } },
                  `epoch retired ${state.ledger.epoch.retired} / transferred ${state.ledger.epoch.transferred}` +
                    `（本读取端支持到 ${state.ledger.supportedEpoch}）· 已退休 ${state.ledger.retired} · 已转移 ${state.ledger.transferred}`),
                state.ledger.deferred
                  ? h('p', { key: 'd', className: 'mc-sub', style: { color: '#b45309', margin: 0 } },
                      `本台账本轮被拒读，等待下一次完整写入（不猜测、不从半条记录抽取）：` +
                        state.ledger.skipped.map((skip) => `${skip.file}:${skip.reason}`).join('、'))
                  : h('p', { key: 'd', className: 'mc-sub', style: { margin: 0 } }, '台账可读，抽取按最后一次完整写入进行。'),
                h('p', { key: 'p', className: 'mc-hint', style: { margin: '4px 0 0' } }, state.ledger.graftDataDir),
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
                disabled: state === null,
                onClick: () => setConfirming(true),
              }, '一键清空当前工作区记忆'),
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
        const bridge = makeBridge(ctx, host)
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_KEY, inject: () => ({ bridge }) }, MemoryConsole),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 61, label: () => '记忆' }, SidebarEntry),
        )
      },
      __bridgeFactory: makeBridge,
    }
  },
})
