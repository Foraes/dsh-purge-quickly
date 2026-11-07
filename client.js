// dsh-purge-quickly — Client 半
//
// 两个位置，两个职责：
//   conversation.input.left        可点的选择器（只在会话还没开始时出现）
//   conversation.session.header.actions    只读状态，一直存在
//
// 选择器点了调 Host 的 /purge-quickly/toggle；Host 是唯一权威，
// 会话一旦开始就返回 409，这里只负责把结果画出来。
window.__ModuleLoader__.load({
  id: 'dsh-purge-quickly',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/purge-quickly'
    const ENTRY_ID = 'purge-quickly'
    const NS = 'purge-quickly'

    // dsh-purge-quickly — 设置页（Client 半，随 client.js 一起加载）
    //
    // 挂在 settings.section，id=purge-quickly，order=25：
    // 「Agent 预设」和「插件市场」之间。
    //
    // 页面本身不做业务判断，所有写操作打 Host 的 /purge-quickly/*，
    // Host 是唯一权威；这里只负责读回来再画。
    const SETTINGS_NS = 'purge-quickly'
    const SETTINGS_ORDER = 25

    const SETTINGS_API = '/purge-quickly'

    const SETTINGS_TEXT = {
      zh: {
        title: '快速破限',
        intro: '新建会话前，在输入框的工具行点一下切换普通 / 破限。会话一旦开始就锁定，系统提示词全程不变。',
        personasTitle: '人格',
        personasHint: '按 order 排序；改完点保存。默认人格用在破限开关打开时。',
        colName: '名称',
        colOrder: '排序',
        colDefault: '默认',
        colActions: '操作',
        addPersona: '新建人格',
        edit: '编辑',
        duplicate: '复制',
        delete: '删除',
        save: '保存',
        cancel: '取消',
        close: '关闭',
        idLabel: 'ID（用于文件名，字母数字和 - _）',
        nameLabel: '显示名称',
        descLabel: '说明',
        bodyLabel: '正文（写进系统提示词的内容）',
        makeDefault: '设为默认',
        isDefault: '默认',
        behaviorTitle: '行为',
        allowInNormal: '普通模式也自动放行工具确认',
        allowInNormalHint: '关着时普通会话照常弹确认框；破限模式始终自动放行，不受此项影响。',
        defaultPersona: '默认人格',
        saved: '已保存',
        failed: '操作失败',
        confirmDelete: '确定删除人格「{name}」？文件会改名为 .deleted-<时间戳> 保留。',
        cannotDeleteDefault: '这是默认人格，先换一个默认再删。',
        cannotDeleteLast: '至少保留一个人格。',
        empty: '还没有人格。点「新建人格」开始。',
        bytes: '{n} 字节',
      },
      en: {
        title: 'Prompt mode',
        intro: 'Before a conversation starts, click the chip in the composer tool row to switch between normal and override. The choice locks once the session begins, so the system prompt never changes.',
        personasTitle: 'Personas',
        personasHint: 'Sorted by order. Save after editing. The default persona is used when the override switch is on.',
        colName: 'Name',
        colOrder: 'Order',
        colDefault: 'Default',
        colActions: 'Actions',
        addPersona: 'New persona',
        edit: 'Edit',
        duplicate: 'Duplicate',
        delete: 'Delete',
        save: 'Save',
        cancel: 'Cancel',
        close: 'Close',
        idLabel: 'ID (file name: letters, digits, - _)',
        nameLabel: 'Display name',
        descLabel: 'Description',
        bodyLabel: 'Body (what gets written into the system prompt)',
        makeDefault: 'Make default',
        isDefault: 'Default',
        behaviorTitle: 'Behavior',
        allowInNormal: 'Auto-approve tool confirmations in normal mode too',
        allowInNormalHint: 'When off, normal sessions keep asking. Override mode always auto-approves regardless of this setting.',
        defaultPersona: 'Default persona',
        saved: 'Saved',
        failed: 'Failed',
        confirmDelete: 'Delete persona "{name}"? The file is renamed to .deleted-<timestamp> and kept.',
        cannotDeleteDefault: 'This is the default persona. Pick another default first.',
        cannotDeleteLast: 'Keep at least one persona.',
        empty: 'No personas yet. Click "New persona" to start.',
        bytes: '{n} bytes',
      },
    }

    function pickSettingsText() {
      try {
        const locale = document?.documentElement?.lang || navigator?.language || 'zh'
        return String(locale).toLowerCase().startsWith('zh') ? SETTINGS_TEXT.zh : SETTINGS_TEXT.en
      } catch {
        return SETTINGS_TEXT.zh
      }
    }

    async function settingsGetState() {
      const res = await fetch(SETTINGS_API + '/state', { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) throw new Error('state ' + res.status)
      return res.json()
    }

    async function settingsPost(path, body) {
      const res = await fetch(SETTINGS_API + path, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) return { ok: false, status: res.status, error: json?.error || 'request-failed' }
      return { ok: true, state: json }
    }

    const SETTINGS_CSS = `
    .dpq-section { display: flex; flex-direction: column; gap: 20px; }
    .dpq-head { display: flex; flex-direction: column; gap: 6px; }
    .dpq-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
    .dpq-intro { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); margin: 0; }
    .dpq-block { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
    .dpq-block-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
    .dpq-block-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
    .dpq-block-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 6px 14px 0; line-height: 1.6; }
    .dpq-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
    .dpq-row:first-of-type { border-top: 0; }
    .dpq-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .dpq-row-name { font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dpq-row-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dpq-default-tag { font-size: 11px; padding: 1px 6px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); flex: none; }
    .dpq-actions { display: flex; gap: 4px; flex: none; }
    .dpq-btn { font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; }
    .dpq-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
    .dpq-btn:disabled { opacity: .5; cursor: default; }
    .dpq-btn-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
    .dpq-btn-danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); background: transparent; }
    .dpq-empty { padding: 20px 14px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary); }
    .dpq-editor { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
    .dpq-field { display: flex; flex-direction: column; gap: 4px; }
    .dpq-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
    .dpq-input, .dpq-textarea { font: inherit; font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
    .dpq-textarea { min-height: 220px; resize: vertical; line-height: 1.6; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .dpq-editor-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .dpq-toggle-row { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
    .dpq-toggle-row:first-of-type { border-top: 0; }
    .dpq-toggle-main { flex: 1; display: flex; flex-direction: column; gap: 3px; }
    .dpq-toggle-label { font-size: 13px; color: var(--dsw-alias-label-primary); }
    .dpq-toggle-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
    .dpq-switch { position: relative; width: 34px; height: 18px; border-radius: 9px; border: 0; padding: 0; cursor: pointer; background: var(--dsw-alias-bg-layer-2); flex: none; transition: background-color .12s ease; }
    .dpq-switch[data-on="true"] { background: var(--dsw-alias-brand-primary); }
    .dpq-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .12s ease; }
    .dpq-switch[data-on="true"]::after { transform: translateX(16px); }
    .dpq-switch:disabled { opacity: .5; cursor: default; }
    .dpq-select { font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
    .dpq-status { font-size: 11px; color: var(--dsw-alias-label-secondary); }
    .dpq-status[data-error="true"] { color: var(--dsw-alias-state-error-primary); }
    `

    // 组件工厂：接收 React，返回设置页组件。
    function createSettingsComponent(React) {
      const h = React.createElement
      const { useState, useEffect, useCallback, useRef } = React

      return function PromptModeSettings() {
        const t = pickSettingsText()
        const [state, setState] = useState(null)
        const [error, setError] = useState(null)
        const [editing, setEditing] = useState(null) // { id, name, description, order, body, isNew }
        const [busy, setBusy] = useState(false)
        const [notice, setNotice] = useState(null)
        const alive = useRef(true)

        const refresh = useCallback(async () => {
          try {
            const next = await settingsGetState()
            if (alive.current) {
              setState(next)
              setError(null)
            }
          } catch (e) {
            if (alive.current) setError(String(e?.message || e))
          }
        }, [])

        useEffect(() => {
          alive.current = true
          refresh()
          return () => {
            alive.current = false
          }
        }, [refresh])

        const run = useCallback(
          async (fn, okMessage) => {
            setBusy(true)
            setNotice(null)
            try {
              const res = await fn()
              if (res.ok) {
                setState(res.state)
                if (okMessage) setNotice({ text: okMessage, error: false })
                return res
              }
              setNotice({ text: t.failed + ': ' + res.error, error: true })
              return res
            } finally {
              setBusy(false)
            }
          },
          [t],
        )

        // ── 载入中 ────────────────────────────────────────────────────────────
        if (!state) {
          return h(
            'div',
            { className: 'dpq-section' },
            h('div', { className: 'dpq-head' }, h('h3', { className: 'dpq-title' }, t.title)),
            h('div', { className: 'dpq-status', 'data-error': error ? 'true' : 'false' }, error || '…'),
          )
        }

        const personas = state.personas ?? []

        // ── 编辑器 ────────────────────────────────────────────────────────────
        const renderEditor = () =>
          h(
            'div',
            { className: 'dpq-editor' },
            h(
              'div',
              { className: 'dpq-field' },
              h('label', { className: 'dpq-label' }, t.idLabel),
              h('input', {
                className: 'dpq-input',
                value: editing.id,
                disabled: !editing.isNew,
                onChange: (e) => setEditing((cur) => ({ ...cur, id: e.target.value })),
              }),
            ),
            h(
              'div',
              { className: 'dpq-field' },
              h('label', { className: 'dpq-label' }, t.nameLabel),
              h('input', {
                className: 'dpq-input',
                value: editing.name,
                onChange: (e) => setEditing((cur) => ({ ...cur, name: e.target.value })),
              }),
            ),
            h(
              'div',
              { className: 'dpq-field' },
              h('label', { className: 'dpq-label' }, t.descLabel),
              h('input', {
                className: 'dpq-input',
                value: editing.description,
                onChange: (e) => setEditing((cur) => ({ ...cur, description: e.target.value })),
              }),
            ),
            h(
              'div',
              { className: 'dpq-field' },
              h('label', { className: 'dpq-label' }, t.bodyLabel),
              h('textarea', {
                className: 'dpq-textarea',
                value: editing.body,
                onChange: (e) => setEditing((cur) => ({ ...cur, body: e.target.value })),
              }),
            ),
            h(
              'div',
              { className: 'dpq-editor-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dpq-btn',
                  disabled: busy,
                  onClick: () => setEditing(null),
                },
                t.cancel,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dpq-btn dpq-btn-primary',
                  disabled: busy || !editing.id.trim() || !editing.name.trim(),
                  onClick: async () => {
                    const res = await run(
                      () =>
                        settingsPost('/personas', {
                          action: 'save',
                          id: editing.id.trim(),
                          name: editing.name.trim(),
                          description: editing.description.trim(),
                          order: Number(editing.order) || 1000,
                          body: editing.body,
                        }),
                      t.saved,
                    )
                    if (res.ok) setEditing(null)
                  },
                },
                t.save,
              ),
            ),
          )

        // ── 人格行 ────────────────────────────────────────────────────────────
        const renderPersona = (p) => {
          if (editing && editing.id === p.id && !editing.isNew) {
            return h('div', { key: p.id }, h('div', { className: 'dpq-row' }, h('div', { className: 'dpq-row-main' }, h('div', { className: 'dpq-row-name' }, p.name))), renderEditor())
          }
          return h(
            'div',
            { className: 'dpq-row', key: p.id },
            h(
              'div',
              { className: 'dpq-row-main' },
              h('div', { className: 'dpq-row-name' }, p.name),
              h('div', { className: 'dpq-row-meta' }, p.id + ' · ' + t.bytes.replace('{n}', p.bytes)),
            ),
            p.isDefault ? h('span', { className: 'dpq-default-tag' }, t.isDefault) : null,
            h(
              'div',
              { className: 'dpq-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dpq-btn',
                  disabled: busy,
                  onClick: () =>
                    setEditing({
                      id: p.id,
                      name: p.name,
                      description: p.description || '',
                      order: p.order,
                      body: p.body || '',
                      isNew: false,
                    }),
                },
                t.edit,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dpq-btn',
                  disabled: busy,
                  onClick: () => run(() => settingsPost('/personas', { action: 'duplicate', id: p.id, newId: p.id + '-copy' }), t.saved),
                },
                t.duplicate,
              ),
              p.isDefault
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dpq-btn dpq-btn-danger',
                      disabled: busy,
                      onClick: async () => {
                        const ask = typeof globalThis.confirm === 'function' ? globalThis.confirm.bind(globalThis) : null
                    if (ask && !ask(t.confirmDelete.replace('{name}', p.name))) return
                        await run(() => settingsPost('/personas', { action: 'delete', id: p.id }), t.saved)
                      },
                    },
                    t.delete,
                  ),
            ),
          )
        }

        // ── 行为 ──────────────────────────────────────────────────────────────
        const renderBehavior = () =>
          h(
            'div',
            { className: 'dpq-block' },
            h('div', { className: 'dpq-block-head' }, h('div', { className: 'dpq-block-title' }, t.behaviorTitle)),
            h(
              'div',
              { className: 'dpq-toggle-row' },
              h(
                'div',
                { className: 'dpq-toggle-main' },
                h('div', { className: 'dpq-toggle-label' }, t.allowInNormal),
                h('div', { className: 'dpq-toggle-hint' }, t.allowInNormalHint),
              ),
              h('button', {
                type: 'button',
                className: 'dpq-switch',
                'data-on': state.allowInNormal ? 'true' : 'false',
                role: 'switch',
                'aria-checked': state.allowInNormal ? 'true' : 'false',
                'aria-label': t.allowInNormal,
                disabled: busy,
                onClick: () => run(() => settingsPost('/settings', { allowInNormal: !state.allowInNormal }), t.saved),
              }),
            ),
            h(
              'div',
              { className: 'dpq-toggle-row' },
              h('div', { className: 'dpq-toggle-main' }, h('div', { className: 'dpq-toggle-label' }, t.defaultPersona)),
              h(
                'select',
                {
                  className: 'dpq-select',
                  value: state.defaultPersona,
                  disabled: busy,
                  onChange: (e) => run(() => settingsPost('/settings', { defaultPersona: e.target.value }), t.saved),
                },
                personas.map((p) => h('option', { key: p.id, value: p.id }, p.name)),
              ),
            ),
          )

        // ── 页面 ──────────────────────────────────────────────────────────────
        return h(
          'div',
          { className: 'dpq-section' },
          h(
            'div',
            { className: 'dpq-head' },
            h('h3', { className: 'dpq-title' }, t.title),
            h('p', { className: 'dpq-intro' }, t.intro),
          ),
          h(
            'div',
            { className: 'dpq-block' },
            h(
              'div',
              { className: 'dpq-block-head' },
              h('div', { className: 'dpq-block-title' }, t.personasTitle),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dpq-btn',
                  disabled: busy,
                  onClick: () =>
                    setEditing({
                      id: '',
                      name: '',
                      description: '',
                      order: personas.length ? Math.max(...personas.map((p) => p.order || 0)) + 1 : 1,
                      body: '',
                      isNew: true,
                    }),
                },
                t.addPersona,
              ),
            ),
            h('div', { className: 'dpq-block-hint' }, t.personasHint),
            personas.length === 0 ? h('div', { className: 'dpq-empty' }, t.empty) : personas.map(renderPersona),
            editing && editing.isNew ? renderEditor() : null,
          ),
          renderBehavior(),
          notice
            ? h('div', { className: 'dpq-status', 'data-error': notice.error ? 'true' : 'false' }, notice.text)
            : null,
        )
      }
    }



    // ── 文案 ──────────────────────────────────────────────────────────────
    const TEXT = {
      zh: {
        normal: '普通',
        switchHint: '点一下，本次会话使用「{full}」人格',
        switchHintOn: '本次会话使用「{full}」· 再点一下改回普通',
        headerOn: '破限 · {name}',
        headerOff: '普通',
        headerHint: '本次会话的快速破限（会话开始后锁定）',
      },
      en: {
        normal: 'Normal',
        switchHint: 'Use the "{full}" persona for this session',
        switchHintOn: 'This session uses "{full}" · click again to go back to normal',
        headerOn: 'Override · {name}',
        headerOff: 'Normal',
        headerHint: 'Prompt mode for this session (locked once it starts)',
      },
    }

    function pickDict() {
      try {
        const locale = document?.documentElement?.lang || navigator?.language || 'zh'
        return String(locale).toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en
      } catch {
        return TEXT.zh
      }
    }

    // 人格名可能很长（"小码酱 · YG 专属"），按钮上只留第一段。
    function shortName(name) {
      const raw = String(name || '').trim()
      if (!raw) return ''
      const head = raw.split(/[·|｜/]/)[0].trim()
      return head || raw
    }

    // ── 与 Host 通信 ──────────────────────────────────────────────────────
    async function getState(sessionId) {
      const query = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''
      const res = await fetch(API + '/state' + query, { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) throw new Error('state ' + res.status)
      return res.json()
    }

    async function toggle(sessionId, on) {
      const res = await fetch(API + '/toggle', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, on }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return { ok: false, status: res.status, error: body?.error || 'request-failed' }
      return { ok: true, state: body }
    }

    // ── 样式 ──────────────────────────────────────────────────────────────
    // 只引用宿主主题 token；颜色变化全部靠 token，不写死色值。
    //
    // 字号必须沿用宿主自己那套「可调字号」变量，不能写死、也不能 inherit，
    // 否则用户改应用字号时会和旁边按钮脱节：
    //   header.actions 里的 chip  → dsh-content-font-size-secondary（宿主
    //     「创造模式」的 .A6Bq1a_trigger 就是这么写的）
    //   composer 工具行           → 同上，行高用 content-font-delta-secondary
    // 真实基准取自 app.asar 内的 dsh-client-ui-conversation / agent-team：
    //   agent-team .VBK9GG_trigger: font-size 12px, gap 5px, padding 3px 7px
    //   conversation .A6Bq1a_trigger: font-size var(...,13px), gap 6px, padding 1px 8px
    // 这里取 conversation 那套（和「创造模式」严格一致）。
    const CSS = `
.dpq-chip {
  position: relative;
  top: -1px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-family: inherit;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.dpq-chip:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.dpq-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dpq-chip[data-on="true"] { color: var(--dsw-alias-state-warn-primary); }
.dpq-chip[data-busy="true"] { opacity: .55; cursor: default; }
.dpq-icon {
  display: block;
  flex: none;
  width: 14px;
  height: 14px;
  overflow: visible;
}
.dpq-badge {
  position: relative;
  top: -1px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  color: var(--dsw-alias-label-tertiary);
  font-family: inherit;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap;
  user-select: none;
  cursor: default;
}
.dpq-badge[data-on="true"] { color: var(--dsw-alias-state-warn-primary); }
`

    // ── 共用状态 ──────────────────────────────────────────────────────────
    // 两个入口读同一份数据，各装各的监听；Host 是唯一权威，这里只缓存展示值。
    function useModeState(sessionId) {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const alive = useRef(true)

      const refresh = useCallback(async () => {
        if (!sessionId) return
        try {
          const next = await getState(sessionId)
          if (alive.current) {
            setState(next)
            setError(null)
          }
        } catch (e) {
          if (alive.current) setError(String(e?.message || e))
        }
      }, [sessionId])

      useEffect(() => {
        alive.current = true
        refresh()
        // 会话状态可能被别处推动（新建、fork、第一条消息提交），低频兜底一次。
        const timer = setInterval(refresh, 4000)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [refresh])

      return { state, error, refresh, setState }
    }

    // ── 图标：面具 ────────────────────────────────────────────────────────
    // persona 的本义就是面具，直接对应「这个会话戴着哪张脸」。
    // 用 currentColor，状态色由外层 chip/badge 的 color 驱动。
    //   普通 → 空心描边面具
    //   破限 → 面具内部亮起（同色淡填充），不靠颜色也能分辨
    // 不用斜线之类横穿面具的笔画：14px 下会盖住眼睛，糊成一团。
    function ModeIcon(props) {
      const on = props?.on === true
      return h(
        'svg',
        {
          className: 'dpq-icon',
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        // 面具主体；破限态内部点亮
        h('path', {
          d: 'M2.6 3.4c1.6.9 3.4 1.4 5.4 1.4s3.8-.5 5.4-1.4c.5.5.7 1.2.7 2v2.2c0 2.6-2.1 4.9-4.7 5.3a2 2 0 0 1-2.8 0C4.1 12.5 2 10.2 2 7.6V5.4c0-.8.2-1.5.6-2z',
          fill: on ? 'currentColor' : 'none',
          fillOpacity: on ? 0.16 : 0,
        }),
        // 眼孔
        h('path', { d: 'M5.6 7.1h.01M10.4 7.1h.01', strokeWidth: 1.9 }),
      )
    }

    // ── 组件 1：composer 工具行的选择器 ────────────────────────────────────
    function ModeSwitch(props) {
      const { sessionId } = props
      const t = pickDict()
      const { state, refresh, setState } = useModeState(sessionId)
      const [busy, setBusy] = useState(false)

      // 等 Host 回话再画，避免先闪一个错误状态。
      // blank 以 Host 为准：它读该会话自己的事件，看有没有 user/message。
      // Client 的 useSession().blank 会在会话被 engage 后变 false，
      // 那样连新建会话的空态都会被判成「已开始」。
      if (!state) return null
      if (state.blank !== true) return null

      const personas = state?.personas ?? []
      const active = state?.active === true
      const fullName = String(state?.personaName || personas.find((p) => p.isDefault)?.name || '')
      const label = active ? shortName(fullName) || shortName(personas.find((p) => p.isDefault)?.name) : t.normal
      const hint = active
        ? t.switchHintOn.replace('{full}', fullName || label || '—')
        : t.switchHint.replace('{full}', fullName || '—')

      const onClick = async () => {
        if (busy) return
        setBusy(true)
        try {
          const next = await toggle(sessionId, !active)
          if (next.ok) setState(next.state)
          else if (next.status === 409) await refresh() // 会话已开始：跟 Host 对齐
        } finally {
          setBusy(false)
        }
      }

      return h(
        'button',
        {
          type: 'button',
          className: 'dpq-chip',
          'data-on': active ? 'true' : 'false',
          'data-busy': busy ? 'true' : 'false',
          'data-purge-quickly-switch': '',
          title: hint,
          'aria-label': hint,
          'aria-pressed': active ? 'true' : 'false',
          disabled: busy,
          onClick,
        },
        h(ModeIcon, { on: active }),
        h('span', null, label),
      )
    }

    // ── 组件 2：header 的只读状态 ──────────────────────────────────────────
    function ModeBadge(props) {
      const { sessionId } = props
      const t = pickDict()
      const { state } = useModeState(sessionId)
      const active = state?.active === true
      if (!state) return null
      const name = shortName(state?.personaName || '')
      const text = active ? t.headerOn.replace('{name}', name || '—') : t.headerOff
      return h(
        'span',
        {
          className: 'dpq-badge',
          'data-on': active ? 'true' : 'false',
          'data-purge-quickly-badge': '',
          title: t.headerHint,
          'aria-label': t.headerHint,
        },
        h(ModeIcon, { on: active }),
        h('span', null, text),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const SettingsSection = createSettingsComponent(React)

        // 样式走 ctx.effect，卸载时自动摘掉。
        ctx.effect(() => {
          if (typeof document === 'undefined') return
          const id = 'dpq-style'
          let tag = document.getElementById(id)
          if (!tag) {
            tag = document.createElement('style')
            tag.id = id
            tag.dataset.plugin = NS
            document.head.appendChild(tag)
          }
          tag.textContent = CSS + '\n' + SETTINGS_CSS
          return () => {
            const mine = document.getElementById(id)
            if (mine && mine.dataset.plugin === NS) mine.remove()
          }
        }, 'purge-quickly: styles')

        try {
          ctx.effect(
            () =>
              ctx.slots.inject('conversation.input.left', () =>
                ctx.slots.register(
                  {
                    name: 'conversation.input.left',
                    id: ENTRY_ID,
                    order: 10,
                  },
                  ModeSwitch,
                ),
              ),
            'purge-quickly: composer switch',
          )
        } catch (e) {
          console.error('[purge-quickly] composer switch registration failed:', e)
        }

        try {
          ctx.effect(
            () =>
              ctx.slots.inject('conversation.session.header.actions', () =>
                ctx.slots.register(
                  {
                    name: 'conversation.session.header.actions',
                    id: ENTRY_ID + ':badge',
                    // 排在 agent-team(-20) 和 agent-preset(-10) 之后，
                    // 也就是「智能体团队 创造模式」的右边。
                    order: 0,
                  },
                  ModeBadge,
                ),
              ),
            'purge-quickly: header badge',
          )
        } catch (e) {
          console.error('[purge-quickly] header badge registration failed:', e)
        }

        try {
          ctx.effect(
            () =>
              ctx.slots.inject('settings.section', () =>
                ctx.slots.register(
                  {
                    name: 'settings.section',
                    id: SETTINGS_NS,
                    order: SETTINGS_ORDER,
                    label: () => pickSettingsText().title,
                  },
                  SettingsSection,
                ),
              ),
            'purge-quickly: settings section',
          )
        } catch (e) {
          console.error('[purge-quickly] settings section registration failed:', e)
        }
      },
    }
  },
})















