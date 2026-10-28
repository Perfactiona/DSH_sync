window.__ModuleLoader__.load({
  id: 'dsh-cloud-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const styles = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '28px',
        padding: '0 8px',
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
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
      busy: { cursor: 'default', opacity: 0.45 },
      icon: { display: 'block', flex: 'none' },
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
        style: styles.icon,
      }, [
        h('path', { key: 'cloud', d: 'M17.5 19a4.5 4.5 0 0 0 .4-8.98A7 7 0 0 0 4.6 9.4 4 4 0 0 0 6 17.9' }),
        h('path', { key: 'down', d: 'M12 11v7m0 0-2.6-2.6M12 18l2.6-2.6' }),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        function SyncButton(props) {
          const [busy, setBusy] = React.useState(false)
          const [failed, setFailed] = React.useState(false)

          const onClick = React.useCallback(async () => {
            if (busy || !props.sessionId) return
            const commands = ctx.remote && ctx.remote.commands
            if (!commands || typeof commands.execute !== 'function') {
              setFailed(true)
              return
            }
            setBusy(true)
            setFailed(false)
            try {
              await commands.execute(props.sessionId, '/sync', [])
            } catch (error) {
              setFailed(true)
              console.error('[dsh-cloud-sync] sync command failed', error)
            } finally {
              setBusy(false)
            }
          }, [busy, props.sessionId])

          return h('button', {
            type: 'button',
            onClick,
            disabled: busy,
            title: failed ? '同步失败，详见对话中的命令结果' : '双向同步插件与应用设置（/sync）',
            'aria-label': '云同步',
            'aria-busy': busy ? 'true' : 'false',
            style: { ...styles.button, ...(busy ? styles.busy : null) },
          }, [
            h(CloudIcon, { key: 'icon' }),
            h('span', { key: 'label' }, busy ? '同步中…' : '云同步'),
          ])
        }

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'cloud-sync',
          order: 40,
        }, SyncButton))
      },
    }
  },
})
