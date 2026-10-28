window.__ModuleLoader__.load({
  id: 'dsh-cloud-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // Shared panel state: the composer button and the panel are two slots in one module.
    const state = { open: false, busy: '', note: '', kind: '' }
    const listeners = new Set()
    const update = (patch) => {
      Object.assign(state, patch)
      for (const listener of listeners) listener()
    }
    function usePanelState() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((value) => value + 1)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return state
    }

    // Generated remotes answer `{ ok, value }`; unwrap before reading the payload.
    const unwrap = (response) => (
      response && typeof response === 'object' && 'ok' in response && 'value' in response
        ? response.value
        : response
    )

    const muted = 'color-mix(in srgb, currentColor 65%, transparent)'
    const danger = 'color-mix(in srgb, #d33 55%, transparent)'
    const border = '1px solid color-mix(in srgb, currentColor 14%, transparent)'
    const fieldStyle = {
      width: '100%',
      boxSizing: 'border-box',
      height: '28px',
      padding: '0 8px',
      border,
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: '12px',
    }
    const labelStyle = { color: muted, fontSize: '11px', lineHeight: '16px', display: 'block', marginBottom: '2px' }
    const cellStyle = { display: 'flex', flexDirection: 'column', minWidth: '0' }

    const styles = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '28px',
        padding: '0 8px',
        border,
        borderRadius: '8px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
        opacity: 0.85,
        whiteSpace: 'nowrap',
      },
      active: { background: 'color-mix(in srgb, currentColor 10%, transparent)', opacity: 1 },
      disabled: { cursor: 'default', opacity: 0.45 },
      panel: {
        boxSizing: 'border-box',
        margin: '0 0 8px',
        padding: '12px 14px',
        border,
        borderRadius: '12px',
        background: 'color-mix(in srgb, currentColor 4%, transparent)',
        fontSize: '13px',
        lineHeight: '20px',
      },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '6px' },
      title: { fontWeight: 600, fontSize: '13px' },
      hint: { color: muted, fontSize: '12px', lineHeight: '18px' },
      grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '10px' },
      row: { display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '10px 0 0' },
      action: {
        height: '30px',
        padding: '0 12px',
        border,
        borderRadius: '8px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      primary: {
        border: '1px solid color-mix(in srgb, #2f6fed 55%, transparent)',
        background: 'color-mix(in srgb, #2f6fed 14%, transparent)',
      },
      warning: { color: 'color-mix(in srgb, #b8860b 80%, currentColor)', fontSize: '12px', lineHeight: '18px', marginTop: '8px' },
      output: {
        marginTop: '10px',
        padding: '8px 10px',
        border,
        borderRadius: '8px',
        background: 'color-mix(in srgb, currentColor 3%, transparent)',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '220px',
        overflow: 'auto',
      },
      close: {
        border: 'none',
        background: 'transparent',
        color: muted,
        cursor: 'pointer',
        fontSize: '16px',
        lineHeight: '16px',
        padding: '2px 4px',
      },
    }

    function CloudIcon() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      }, [
        h('path', { key: 'c', d: 'M17.5 19a4.5 4.5 0 0 0 .4-8.98A7 7 0 0 0 4.6 9.4 4 4 0 0 0 6 17.9' }),
        h('path', { key: 'd', d: 'M12 11v7m0 0-2.6-2.6M12 18l2.6-2.6' }),
      ])
    }

    const findNamespace = (described) => {
      const list = (described && described.namespaces) || []
      return list.find((entry) => {
        if (typeof entry.ns === 'string'
          && (entry.ns === 'cloud-sync' || entry.ns === 'dsh-cloud-sync' || entry.ns.includes('cloud-sync'))) return true
        const schema = JSON.stringify(entry.schema || {})
        return schema.includes('"repo"') && schema.includes('"token"')
      }) || null
    }

    return {
      inject: ['slots', 'remote', 'remote.settings', 'remote.commands'],
      apply(ctx) {
        const execute = async (sessionId, line) => {
          const remote = ctx.remote && ctx.remote.commands
          if (!remote || typeof remote.execute !== 'function') {
            return { kind: 'error', text: '当前页面没有命令通道。' }
          }
          try {
            const response = await remote.execute(sessionId, line, [])
            const result = response && response.value && response.value.result
            if (result && typeof result.text === 'string') return { kind: result.kind || 'success', text: result.text }
            return { kind: 'success', text: '已执行。' }
          } catch (error) {
            return { kind: 'error', text: `执行失败：${error && error.message ? error.message : String(error)}` }
          }
        }

        function SyncButton() {
          const panel = usePanelState()
          return h('button', {
            type: 'button',
            onClick: () => update({ open: !panel.open }),
            title: panel.open ? '收起云同步' : '打开云同步（配置 + 同步）',
            'aria-label': '云同步',
            'aria-expanded': panel.open ? 'true' : 'false',
            style: { ...styles.button, ...(panel.open ? styles.active : null) },
          }, [h(CloudIcon, { key: 'i' }), h('span', { key: 'l' }, '云同步')])
        }

        function SyncPanel(props) {
          const panel = usePanelState()
          const [fields, setFields] = React.useState({ repo: '', branch: 'main', path: 'dsh-sync/snapshot.json.gz', token: '' })
          const [ns, setNs] = React.useState(null)
          const [revision, setRevision] = React.useState(undefined)
          const [configState, setConfigState] = React.useState('loading')
          const [configError, setConfigError] = React.useState('')
          const [tokenSet, setTokenSet] = React.useState(false)
          const [saving, setSaving] = React.useState(false)

          React.useEffect(() => {
            if (!panel.open) return
            let alive = true
            ;(async () => {
              try {
                const settings = ctx.remote && ctx.remote.settings
                if (!settings || typeof settings.describe !== 'function') throw new Error('当前版本没有设置通道')
                const described = unwrap(await settings.describe())
                if (described && described.writable === false) throw new Error('本机设置文档不可写，请检查 DSH 权限')
                const found = findNamespace(described)
                if (!found) {
                  const names = ((described && described.namespaces) || []).map((entry) => entry.ns).filter(Boolean)
                  throw new Error(`没有找到云同步的配置项。当前可用的配置命名空间：${names.length ? names.join('、') : '（空）'}`)
                }
                if (!alive) return
                const value = found.value || {}
                setNs(found.ns)
                setRevision(found.revision)
                setFields({
                  repo: String(value.repo || ''),
                  branch: String(value.branch || 'main'),
                  path: String(value.path || 'dsh-sync/snapshot.json.gz'),
                  token: '',
                })
                const secret = (found.secrets || []).find((item) => Array.isArray(item.path) && item.path[0] === 'token')
                setTokenSet(Boolean(secret && secret.set))
                setConfigState('ready')
              } catch (error) {
                if (!alive) return
                setConfigState('error')
                setConfigError(error && error.message ? error.message : String(error))
              }
            })()
            return () => { alive = false }
          }, [panel.open])

          const save = async () => {
            if (saving || !ns) return
            setSaving(true)
            try {
              const patch = {
                repo: fields.repo.trim(),
                branch: fields.branch.trim() || 'main',
                path: fields.path.trim() || 'dsh-sync/snapshot.json.gz',
              }
              if (fields.token.trim()) patch.token = fields.token.trim()
              const view = unwrap(await ctx.remote.settings.update(ns, patch, revision))
              if (view) {
                if (typeof view.revision === 'number') setRevision(view.revision)
                const secret = (view.secrets || []).find((item) => Array.isArray(item.path) && item.path[0] === 'token')
                if (secret) setTokenSet(Boolean(secret.set))
              }
              setFields((current) => ({ ...current, token: '' }))
              update({ kind: 'success', note: '配置已保存。' })
            } catch (error) {
              update({ kind: 'error', note: `保存失败：${error && error.message ? error.message : String(error)}` })
            } finally {
              setSaving(false)
            }
          }

          if (!panel.open) return null
          const busy = panel.busy.length > 0 || saving
          const run = async (line, label) => {
            if (busy || !props.sessionId) return
            update({ busy: label, note: '', kind: '' })
            const result = await execute(props.sessionId, line)
            update({ busy: '', note: result.text, kind: result.kind })
          }
          const action = (label, line, primary) => h('button', {
            type: 'button',
            disabled: busy,
            onClick: () => run(line, label),
            style: { ...styles.action, ...(primary ? styles.primary : null), ...(busy ? styles.disabled : null) },
          }, label)
          const field = (key, label, placeholder, secret) => h('label', { key, style: cellStyle }, [
            h('span', { key: 'l', style: labelStyle }, label),
            h('input', {
              key: 'i',
              type: secret ? 'password' : 'text',
              value: fields[key],
              placeholder: secret && tokenSet ? '已保存（留空则不修改）' : (placeholder || ''),
              onChange: (event) => setFields((current) => ({ ...current, [key]: event.target.value })),
              style: fieldStyle,
              autoComplete: 'off',
              spellCheck: false,
            }),
          ])

          return h('section', { style: styles.panel, 'aria-label': '云同步' }, [
            h('div', { key: 'h', style: styles.header }, [
              h('div', { key: 't', style: styles.title }, '云同步'),
              h('button', { key: 'x', type: 'button', onClick: () => update({ open: false }), title: '收起', style: styles.close }, '×'),
            ]),
            h('div', { key: 'd', style: styles.hint },
              '两个方向分开操作，不做自动合并：拉取会用云端快照替换本机，上传会用本机覆盖云端。两个方向都会先备份。'),
            configState === 'loading' ? h('div', { key: 'l', style: { ...styles.hint, marginTop: '8px' } }, '读取配置…') : null,
            configState === 'error' ? h('div', {
              key: 'e',
              style: { ...styles.output, borderColor: danger },
            }, configError) : null,
            configState === 'ready' ? h('div', { key: 'g', style: styles.grid }, [
              field('repo', 'GitHub 仓库（owner/name）', 'Perfactiona/htc_DSHsetups'),
              field('branch', '分支', 'main'),
              field('path', '快照路径', 'dsh-sync/snapshot.json.gz'),
              field('token', 'GitHub Token', '', true),
            ]) : null,
            configState === 'ready' ? h('div', { key: 'sr', style: styles.row }, [
              h('button', {
                key: 'save',
                type: 'button',
                disabled: busy,
                onClick: save,
                style: { ...styles.action, ...(busy ? styles.disabled : null) },
              }, saving ? '保存中…' : '保存配置'),
            ]) : null,
            h('div', { key: 'a', style: styles.row }, [
              action('以云端更新本机', '/sync pull', true),
              action('以本机覆盖云端', '/sync push'),
              action('查看状态', '/sync status'),
              action('恢复上次', '/sync restore'),
            ]),
            h('div', { key: 'w', style: styles.warning },
              '「以云端更新本机」会替换本机插件与设置（先备份到云端 backups/ 与本机）；「以本机覆盖云端」会让云端变成这台机器的状态。'),
            h('div', { key: 'n', style: { ...styles.hint, marginTop: '6px' } }, '同步完成后需重启应用。'),
            busy ? h('div', { key: 'b', style: { ...styles.output, color: muted } }, `${panel.busy || '保存中'}…`) : null,
            panel.note ? h('pre', {
              key: 'o',
              style: { ...styles.output, borderColor: panel.kind === 'error' ? danger : undefined },
            }, panel.note) : null,
          ])
        }

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'cloud-sync',
          order: 40,
        }, SyncButton))

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'cloud-sync-panel',
          order: 20,
        }, SyncPanel))
      },
    }
  },
})
