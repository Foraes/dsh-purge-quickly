// 第 3 步验收：设置页。
// 用同一套 React 运行时驱动设置页组件，验证：
//   1) 初始渲染：人格列表、行为区、默认人格下拉
//   2) 新建人格 → 打开编辑器 → 保存 → 列表更新
//   3) 编辑已有 → 保存
//   4) 复制
//   5) 删除（默认人格不给删，非默认走 confirm）
//   6) allowInNormal 开关
//   7) 默认人格切换
// 运行：node test-step3.mjs
import { readFileSync } from 'node:fs'

function createReactRuntime() {
  let inst = null
  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
      return { type, props: { ...(props || {}), children: flat.length === 1 ? flat[0] : flat }, __el: true }
    },
    useState(initial) {
      const i = inst.cursor++
      if (!(i in inst.state)) inst.state[i] = typeof initial === 'function' ? initial() : initial
      const set = (v) => {
        const next = typeof v === 'function' ? v(inst.state[i]) : v
        if (Object.is(next, inst.state[i])) return
        inst.state[i] = next
        inst.dirty = true
      }
      return [inst.state[i], set]
    },
    useEffect(fn, deps) {
      const i = inst.cursor++
      const prev = inst.effectDeps[i]
      const changed =
        prev === undefined || deps === undefined || deps.length !== prev.length || deps.some((d, k) => !Object.is(d, prev[k]))
      if (changed) {
        inst.effectDeps[i] = deps ? [...deps] : null
        inst.pendingEffects.push({ fn })
      }
    },
    useCallback(fn, deps) {
      const i = inst.cursor++
      const prev = inst.memoDeps[i]
      const changed =
        prev === undefined || deps === undefined || deps.length !== prev.length || deps.some((d, k) => !Object.is(d, prev[k]))
      if (changed) {
        inst.memoDeps[i] = deps ? [...deps] : null
        inst.memo[i] = fn
      }
      return inst.memo[i]
    },
    useRef(initial) {
      const i = inst.cursor++
      if (!(i in inst.refs)) inst.refs[i] = { current: initial }
      return inst.refs[i]
    },
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  async function mount(Component, props) {
    inst = { cursor: 0, state: {}, effectDeps: {}, memoDeps: {}, memo: {}, refs: {}, pendingEffects: [], cleanups: [], dirty: false }
    const render = () => {
      inst.cursor = 0
      return Component(props)
    }
    let el = render()
    const settle = async () => {
      for (let round = 0; round < 16; round++) {
        const fx = inst.pendingEffects
        inst.pendingEffects = []
        for (const { fn } of fx) {
          const off = fn()
          if (typeof off === 'function') inst.cleanups.push(off)
        }
        await tick()
        if (inst.dirty) {
          inst.dirty = false
          el = render()
          continue
        }
        if (fx.length === 0) break
      }
      return el
    }
    await settle()
    return {
      get el() {
        return el
      },
      async act(fn) {
        const r = await fn()
        inst.dirty = false
        el = render()
        await settle()
        return r
      },
      async setProps(next) {
        props = next
        inst.dirty = false
        el = render()
        await settle()
      },
      unmount() {
        for (const off of inst.cleanups.reverse()) {
          try { off() } catch { /* ignore */ }
        }
      },
    }
  }
  return { React, mount }
}

// ── 载入 client.js ────────────────────────────────────────────────────────
const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
let loaded = null
new Function('window', src)({ __ModuleLoader__: { load: (def) => (loaded = def) } })

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log('  ok   ' + name)
  } else {
    fail++
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''))
  }
}
function textOf(el) {
  if (el === null || el === undefined) return ''
  if (typeof el === 'string') return el
  if (typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map(textOf).join(' ')
  if (el.props) return textOf(el.props.children)
  return ''
}
function findAll(el, pred, out = []) {
  if (!el || typeof el !== 'object') return out
  if (Array.isArray(el)) {
    for (const c of el) findAll(c, pred, out)
    return out
  }
  if (pred(el)) out.push(el)
  findAll(el.props?.children, pred, out)
  return out
}
function byClass(el, name) {
  return findAll(el, (n) => typeof n.props?.className === 'string' && n.props.className.split(/\s+/).includes(name))
}
function byText(el, text) {
  return findAll(el, (n) => n.type === 'button' && textOf(n.props?.children) === text)
}

// ── 宿主替身 ──────────────────────────────────────────────────────────────
let server = null
let fetchLog = []

global.fetch = async (url, init) => {
  fetchLog.push({ url, method: init?.method || 'GET', body: init?.body })
  if (url.endsWith('/state')) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(server)) }
  if (url.endsWith('/settings')) {
    const body = JSON.parse(init.body)
    if (typeof body.allowInNormal === 'boolean') server.allowInNormal = body.allowInNormal
    if (typeof body.defaultPersona === 'string' && server.personas.some((p) => p.id === body.defaultPersona)) {
      server.defaultPersona = body.defaultPersona
      for (const p of server.personas) p.isDefault = p.id === body.defaultPersona
    }
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(server)) }
  }
  if (url.endsWith('/personas')) {
    const body = JSON.parse(init.body)
    if (body.action === 'save') {
      const existing = server.personas.find((p) => p.id === body.id)
      if (existing) {
        existing.name = body.name
        existing.description = body.description
        existing.body = body.body
        existing.bytes = (body.body || '').length
      } else {
        server.personas.push({
          id: body.id,
          name: body.name,
          description: body.description,
          order: body.order,
          body: body.body,
          bytes: (body.body || '').length,
          isDefault: false,
        })
      }
    } else if (body.action === 'delete') {
      if (body.id === server.defaultPersona) {
        return { ok: false, status: 409, json: async () => ({ ok: false, error: 'persona-is-default' }) }
      }
      server.personas = server.personas.filter((p) => p.id !== body.id)
    } else if (body.action === 'duplicate') {
      const from = server.personas.find((p) => p.id === body.id)
      server.personas.push({ ...from, id: body.newId, name: from.name + ' (副本)', isDefault: false })
    }
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(server)) }
  }
  throw new Error('unexpected ' + url)
}
global.document = undefined
try {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true })
} catch { /* ignore */ }
let confirmAnswer = true
global.window = {}
// 产品代码读 globalThis.confirm；浏览器里它等于 window.confirm，测试里挂 globalThis。
Object.defineProperty(globalThis, 'confirm', {
  value: () => confirmAnswer,
  configurable: true,
  writable: true,
})

function freshServer() {
  return {
    ok: true,
    defaultPersona: 'xiaomajiang',
    allowInNormal: false,
    personas: [
      { id: 'xiaomajiang', name: '小码酱 · YG 专属', description: 'YG 专属', order: 1, body: '你是小码酱。', bytes: 14, isDefault: true },
      { id: 'dafeiyu', name: '大肥鱼 · 岚的专属', description: '通用破限', order: 2, body: '你是大肥鱼。', bytes: 14, isDefault: false },
      { id: 'ctf', name: 'CTF', description: 'CTF 专用', order: 50, body: '你是 CTF 助手。', bytes: 16, isDefault: false },
    ],
  }
}

const { React, mount } = createReactRuntime()
const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error('missing ' + name)
})

const registered = []
plugin.apply({
  effect(fn) {
    return fn()
  },
  slots: {
    inject: (_n, cb) => cb(),
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
})
const SettingsComponent = registered.find((r) => r.options.name === 'settings.section').component

console.log('\n== 1. 初始渲染 ==')
server = freshServer()
const m = await mount(SettingsComponent, {})
check('标题存在', textOf(m.el).includes('快速破限'))
check('说明存在', textOf(m.el).includes('会话一旦开始就锁定'))
check('人格区标题', textOf(m.el).includes('人格'))
const rows = byClass(m.el, 'dpq-row')
check('三个人格三行', rows.length === 3, 'rows=' + rows.length)
check('显示小码酱', textOf(m.el).includes('小码酱'))
check('显示大肥鱼', textOf(m.el).includes('大肥鱼'))
check('显示 CTF', textOf(m.el).includes('CTF'))
check('默认标签只有一个', byClass(m.el, 'dpq-default-tag').length === 1)
check('默认人格不给删按钮', byText(rows[0], '删除').length === 0, 'btns=' + byText(rows[0], '删除').length)
check('非默认人格有删按钮', byText(rows[1], '删除').length === 1)

console.log('\n== 2. 新建人格 ==')
const newBtn = byText(m.el, '新建人格')[0]
check('有新建按钮', !!newBtn)
await m.act(() => newBtn.props.onClick())
const editor = byClass(m.el, 'dpq-editor')
check('编辑器打开', editor.length === 1, 'count=' + editor.length)
const inputs = byClass(m.el, 'dpq-input')
check('有 3 个输入框（id/name/desc）', inputs.length === 3, 'count=' + inputs.length)
const textarea = byClass(m.el, 'dpq-textarea')[0]
check('有正文文本框', !!textarea)
const saveBtn = byText(m.el, '保存')[0]
check('保存默认禁用（id/name 空）', saveBtn?.props?.disabled === true)

await m.act(() => inputs[0].props.onChange({ target: { value: 'my-persona' } }))
await m.act(() => inputs[1].props.onChange({ target: { value: '我的人格' } }))
await m.act(() => textarea.props.onChange({ target: { value: '你是测试人格，直接给答案。' } }))
const saveBtn2 = byText(m.el, '保存')[0]
check('填好后保存可用', saveBtn2?.props?.disabled === false)
fetchLog = []
await m.act(() => saveBtn2.props.onClick())
const saveCall = fetchLog.find((f) => f.url.endsWith('/personas'))
check('调用了 personas save', !!saveCall)
check('action=save', JSON.parse(saveCall.body).action === 'save')
check('id 正确', JSON.parse(saveCall.body).id === 'my-persona')
check('正文正确', JSON.parse(saveCall.body).body === '你是测试人格，直接给答案。')
check('编辑器已关闭', byClass(m.el, 'dpq-editor').length === 0)
check('列表变成 4 行', byClass(m.el, 'dpq-row').length === 4, 'rows=' + byClass(m.el, 'dpq-row').length)
check('新人格出现', textOf(m.el).includes('我的人格'))

console.log('\n== 3. 编辑已有 ==')
const rows2 = byClass(m.el, 'dpq-row')
const editBtn = byText(rows2[1], '编辑')[0]
await m.act(() => editBtn.props.onClick())
check('编辑器打开', byClass(m.el, 'dpq-editor').length === 1)
const idInput = byClass(m.el, 'dpq-input')[0]
check('编辑时 id 不可改', idInput?.props?.disabled === true)
const nameInput = byClass(m.el, 'dpq-input')[1]
check('编辑时名字已填充', nameInput?.props?.value === '大肥鱼 · 岚的专属', nameInput?.props?.value)
await m.act(() => nameInput.props.onChange({ target: { value: '大肥鱼改名' } }))
await m.act(() => byText(m.el, '保存')[0].props.onClick())
check('改名生效', textOf(m.el).includes('大肥鱼改名'))

console.log('\n== 4. 复制 ==')
const rows3 = byClass(m.el, 'dpq-row')
fetchLog = []
await m.act(() => byText(rows3[2], '复制')[0].props.onClick())
const dupCall = fetchLog.find((f) => f.url.endsWith('/personas'))
check('action=duplicate', JSON.parse(dupCall.body).action === 'duplicate')
check('新 id 带 -copy', JSON.parse(dupCall.body).newId.endsWith('-copy'))
check('列表变成 5 行', byClass(m.el, 'dpq-row').length === 5, 'rows=' + byClass(m.el, 'dpq-row').length)

console.log('\n== 5. 删除 ==')
confirmAnswer = true
const rows4 = byClass(m.el, 'dpq-row')
const delBtn = byText(rows4[4], '删除')[0]
check('副本行有删按钮', !!delBtn)
fetchLog = []
await m.act(() => delBtn.props.onClick())
const delCall = fetchLog.find((f) => f.url.endsWith('/personas'))
check('action=delete', JSON.parse(delCall?.body || '{}').action === 'delete')
check('删除后 4 行', byClass(m.el, 'dpq-row').length === 4, 'rows=' + byClass(m.el, 'dpq-row').length)

confirmAnswer = false
const rows5 = byClass(m.el, 'dpq-row')
fetchLog = []
const delBtn2 = byText(rows5[3], '删除')[0]
await m.act(() => delBtn2.props.onClick())
check('取消 confirm 不发请求', fetchLog.filter((f) => f.url.endsWith('/personas')).length === 0)
confirmAnswer = true

console.log('\n== 6. allowInNormal 开关 ==')
const sw = byClass(m.el, 'dpq-switch')[0]
check('开关存在', !!sw)
check('角色是 switch', sw?.props?.role === 'switch')
check('初始 off', sw?.props?.['data-on'] === 'false')
check('aria-checked=false', sw?.props?.['aria-checked'] === 'false')
fetchLog = []
await m.act(() => sw.props.onClick())
const setCall = fetchLog.find((f) => f.url.endsWith('/settings'))
check('allowInNormal=true 已提交', JSON.parse(setCall.body).allowInNormal === true)
check('开关变 on', byClass(m.el, 'dpq-switch')[0].props['data-on'] === 'true')

console.log('\n== 7. 默认人格切换 ==')
const sel = byClass(m.el, 'dpq-select')[0]
check('下拉存在', !!sel)
check('当前值 xiaomajiang', sel?.props?.value === 'xiaomajiang', sel?.props?.value)
const options = findAll(sel, (n) => n.type === 'option')
check('选项数与人格数一致', options.length === server.personas.length, options.length + ' vs ' + server.personas.length)
fetchLog = []
await m.act(() => sel.props.onChange({ target: { value: 'dafeiyu' } }))
const defCall = fetchLog.find((f) => f.url.endsWith('/settings'))
check('defaultPersona 已提交', JSON.parse(defCall.body).defaultPersona === 'dafeiyu')
check('默认标签移动了', byClass(m.el, 'dpq-default-tag').length === 1)

console.log('\n== 8. 失败提示 ==')
server.personas = [] // 制造空列表
const m2 = await mount(SettingsComponent, {})
check('空列表提示', textOf(m2.el).includes('还没有人格'), textOf(m2.el).slice(0, 80))
m2.unmount()

console.log('\n============================')
console.log('通过 ' + pass + ' / 失败 ' + fail)
m.unmount()
process.exit(fail === 0 ? 0 : 1)
