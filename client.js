window.__ModuleLoader__.load({
  id: 'dsh-cloud-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // One module-level panel state shared by the composer button and the panel.
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

    const muted = 'color-mix(in srgb, currentColor 65%, transparent)'
    const border = '1px solid color-mix(in srgb, currentColor 14%, transparent)'

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
      active: {
        background: 'color-mix(in srgb, currentColor 10%, transparent)',
        opacity: 1,
      },
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
      header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        marginBottom: '6px',
      },
      title: { fontWeight: 600, fontSize: '13px' },
      hint: { color: muted, fontSize: '12px', lineHeight: '18px' },
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
        h('path', { key: 'cloud', d: 'M17.5 19a4.5 4.5 0 0 0 .4-8.98A7 7 0 0 0 4.6 9.4 4 4 0 0 0 6 17.9' }),
        h('path', { key: 'down', d: 'M12 11v7m0 0-2.6-2.6M12 18l2.6-2.6' }),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const execute = async (sessionId, line) => {
          const remote = ctx.remote && ctx.remote.commands
          if (!remote || typeof remote.execute !== 'function') {
            return { kind: 'error', text: '当前页面没有命令通道，请在对话里直接输入 /sync。' }
          }
          try {
            const response = await remote.execute(sessionId, line, [])
            const result = response && response.value && response.value.result
            if (result && typeof result.text === 'string') {
              return { kind: result.kind || 'success', text: result.text }
            }
            return { kind: 'success', text: response && response.ok ? '已执行，详细结果见对话。' : '命令未执行。' }
          } catch (error) {
            return { kind: 'error', text: `执行失败：${error && error.message ? error.message : String(error)}` }
          }
        }

        function SyncButton(props) {
          const panel = usePanelState()
          return h('button', {
            type: 'button',
            onClick: () => update({ open: !panel.open }),
            title: panel.open ? '收起云同步面板' : '打开云同步面板（双向同步插件与设置）',
            'aria-label': '云同步',
            'aria-expanded': panel.open ? 'true' : 'false',
            style: { ...styles.button, ...(panel.open ? styles.active : null) },
          }, [
            h(CloudIcon, { key: 'icon' }),
            h('span', { key: 'label' }, '云同步'),
          ])
        }

        function SyncPanel(props) {
          const panel = usePanelState()
          if (!panel.open) return null

          const run = async (line, label) => {
            if (panel.busy) return
            if (!props.sessionId) {
              update({ kind: 'error', note: '当前没有会话，无法执行命令。' })
              return
            }
            update({ busy: label, note: '', kind: '' })
            const result = await execute(props.sessionId, line)
            update({ busy: '', note: result.text, kind: result.kind })
          }

          const busy = panel.busy.length > 0
          const action = (label, line, primary) => h('button', {
            type: 'button',
            disabled: busy,
            onClick: () => run(line, label),
            style: { ...styles.action, ...(primary ? styles.primary : null), ...(busy ? styles.disabled : null) },
          }, label)

          return h('section', { style: styles.panel, 'aria-label': '云同步' }, [
            h('div', { key: 'header', style: styles.header }, [
              h('div', { key: 'title', style: styles.title }, '云同步'),
              h('button', {
                key: 'close',
                type: 'button',
                onClick: () => update({ open: false }),
                title: '收起',
                'aria-label': '收起',
                style: styles.close,
              }, '×'),
            ]),
            h('div', { key: 'hint', style: styles.hint },
              '双向同步两台电脑的插件与设置：合并插件列表、设置以云端为准，覆盖前自动备份到云端 backups/ 和本机。对话、任务、缓存不会被同步。'),
            h('div', { key: 'row', style: styles.row }, [
              action('双向同步', '/sync', true),
              action('上传本机', '/sync push'),
              action('查看状态', '/sync status'),
              action('恢复上次', '/sync restore'),
            ]),
            h('div', { key: 'config', style: { ...styles.hint, marginTop: '8px' } },
              '首次使用先到 设置 → 插件 → dsh-cloud-sync 填 repo 与 token；同步完成后需重启应用。'),
            busy ? h('div', { key: 'busy', style: { ...styles.output, color: muted } }, `${panel.busy}…`) : null,
            panel.note ? h('pre', {
              key: 'note',
              style: { ...styles.output, borderColor: panel.kind === 'error' ? 'color-mix(in srgb, #d33 45%, transparent)' : undefined },
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
