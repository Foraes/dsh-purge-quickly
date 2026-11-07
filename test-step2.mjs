// 第 2 步验收：Client 半的组件行为。
//
// 用一个能真正跑 hooks 的极简 React 运行时驱动 ModeSwitch / ModeBadge：
//   render → 收集 effect → 执行 → await → setState 触发重渲染 → 收敛
// 验证：
//   1) 会话未开始 → 选择器渲染，点一下调 toggle，标签切成人格名
//   2) 会话已开始 → 选择器返回 null
//   3) header 徽章始终渲染，on/off 文案与 data-on 正确
//   4) 409（会话已开始）→ 重新对齐 Host 状态
// 运行：node test-step2.mjs
import { readFileSync } from 'node:fs'

// ── 极简 React 运行时（支持 hooks + 重渲染） ──────────────────────────────
function createReactRuntime() {
  let inst = null

  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat()
      return {
        type,
        props: { ...(props || {}), children: flat.length === 1 ? flat[0] : flat },
        __el: true,
      }
    },
    useState(initial) {
      const i = inst.cursor++
      if (!(i in inst.state)) {
        inst.state[i] = typeof initial === 'function' ? initial() : initial
      }
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
        prev === undefined ||
        deps === undefined ||
        deps.length !== prev.length ||
        deps.some((d, k) => !Object.is(d, prev[k]))
      if (changed) {
        inst.effectDeps[i] = deps ? [...deps] : null
        inst.pendingEffects.push({ fn, i })
      }
    },
    useCallback(fn, deps) {
      const i = inst.cursor++
      const prev = inst.memoDeps[i]
      const changed =
        prev === undefined ||
        deps === undefined ||
        deps.length !== prev.length ||
        deps.some((d, k) => !Object.is(d, prev[k]))
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

  // 挂载并跑到稳定：执行 effect → await → 若有 setState 则重渲染 → 重复
  async function mount(Component, props) {
    inst = {
      cursor: 0,
      state: {},
      effectDeps: {},
      memoDeps: {},
      memo: {},
      refs: {},
      pendingEffects: [],
      cleanups: [],
      dirty: false,
    }
    const render = () => {
      inst.cursor = 0
      return Component(props)
    }
    let el = render()

    // 反复渲染直到没有新 effect、没有 dirty
    const settle = async () => {
      for (let round = 0; round < 12; round++) {
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
      // 触发一次用户动作，然后按 React 的语义重跑组件、执行新 effect。
      async act(fn) {
        const result = await fn()
        inst.dirty = true
        inst.dirty = false
        el = render()
        await settle()
        return result
      },
      unmount() {
        for (const off of inst.cleanups.reverse()) {
          try {
            off()
          } catch { /* ignore */ }
        }
      },
    }
  }

  return { React, mount }
}

// ── 载入 client.js ────────────────────────────────────────────────────────
const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
let loaded = null
new Function('window', src)({
  __ModuleLoader__: {
    load(def) {
      loaded = def
    },
  },
})

if (!loaded) throw new Error('client.js 未调用 __ModuleLoader__.load')
if (loaded.id !== 'dsh-purge-quickly') throw new Error('模块 id 不对: ' + loaded.id)

// ── 宿主替身 ──────────────────────────────────────────────────────────────
let fetchLog = []
let stateResponse = null
let toggleResponse = null

global.fetch = async (url, init) => {
  fetchLog.push({ url, init })
  if (url.includes('/state')) {
    return { ok: true, status: 200, json: async () => stateResponse }
  }
  if (url.includes('/toggle')) {
    return {
      ok: toggleResponse.status === 200,
      status: toggleResponse.status,
      json: async () => toggleResponse.body,
    }
  }
  throw new Error('unexpected url ' + url)
}
global.document = undefined
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
    writable: true,
  })
} catch { /* Node 内置 navigator 只读时忽略 */ }

// ── 断言 ──────────────────────────────────────────────────────────────────
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
  if (Array.isArray(el)) return el.map(textOf).join('')
  if (el.props) return textOf(el.props.children)
  return ''
}

function find(el, pred) {
  if (!el || typeof el !== 'object') return null
  if (Array.isArray(el)) {
    for (const c of el) {
      const hit = find(c, pred)
      if (hit) return hit
    }
    return null
  }
  // 函数组件：真实 React 会调用它，替身这里跟着展开一层
  if (typeof el.type === 'function') {
    return find(el.type(el.props || {}), pred)
  }
  if (pred(el)) return el
  return find(el.props?.children, pred)
}

function findAll(el, pred, out = []) {
  if (!el || typeof el !== 'object') return out
  if (Array.isArray(el)) {
    for (const c of el) findAll(c, pred, out)
    return out
  }
  if (typeof el.type === 'function') {
    findAll(el.type(el.props || {}), pred, out)
    return out
  }
  if (pred(el)) out.push(el)
  findAll(el.props?.children, pred, out)
  return out
}

const { React, mount } = createReactRuntime()

console.log('\n== 1. 模块形态 ==')
check('id 正确', loaded.id === 'dsh-purge-quickly')
const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
check('inject 含 slots', plugin.inject.includes('slots'))
check('apply 是函数', typeof plugin.apply === 'function')

// ── 挂载插件 ──────────────────────────────────────────────────────────────
const registered = []
const injected = []
const pluginCleanups = []
plugin.apply({
  effect(fn) {
    const off = fn()
    if (typeof off === 'function') pluginCleanups.push(off)
    return off
  },
  slots: {
    inject(name, cb) {
      injected.push(name)
      return cb()
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
})

console.log('\n== 2. 注册 ==')
check('注入了 conversation.input.left', injected.includes('conversation.input.left'))
check('注入了 header.actions', injected.includes('conversation.session.header.actions'))
check('注入了 settings.section', injected.includes('settings.section'))
check('注册了三个组件', registered.length === 3, 'count=' + registered.length)
const switchReg = registered.find((r) => r.options.name === 'conversation.input.left')
const badgeReg = registered.find((r) => r.options.name === 'conversation.session.header.actions')
const settingsReg = registered.find((r) => r.options.name === 'settings.section')
check('选择器 id 正确', switchReg?.options.id === 'purge-quickly')
check('选择器 order=10', switchReg?.options.order === 10)
check('徽章 id 带 :badge', badgeReg?.options.id === 'purge-quickly:badge')
check('徽章 order=0（在 agent-team/agent-preset 之后）', badgeReg?.options.order === 0)
check('设置页 id 正确', settingsReg?.options.id === 'purge-quickly')
check('设置页 order=25', settingsReg?.options.order === 25)
check('设置页有 label 函数', typeof settingsReg?.options.label === 'function')
check('设置页 label 返回标题', settingsReg?.options.label() === '快速破限', settingsReg?.options.label())

const ModeSwitch = switchReg.component
const ModeBadge = badgeReg.component

// ── 3. 未开始会话：选择器可见 ─────────────────────────────────────────────
console.log('\n== 3. 未开始会话：选择器可见 ==')
stateResponse = {
  ok: true,
  active: false,
  persona: null,
  personaName: null,
  blank: true,
  sessionId: 's1',
  defaultPersona: 'xiaomajiang',
  personas: [{ id: 'xiaomajiang', name: '小码酱 · YG 专属', isDefault: true }],
}
const mOff = await mount(ModeSwitch, { sessionId: 's1' })
check('渲染出按钮', mOff.el && mOff.el.type === 'button', String(mOff.el?.type))
check('普通态 data-on=false', mOff.el?.props['data-on'] === 'false')
check('文案是「普通」', textOf(mOff.el).includes('普通'), textOf(mOff.el))
check('有面具图标', !!find(mOff.el, (n) => n.type === 'svg' && n.props?.className === 'dpq-icon'))
check('图标用 currentColor', (find(mOff.el, (n) => n.type === 'svg')?.props?.stroke) === 'currentColor')
check('带 aria-pressed', mOff.el?.props['aria-pressed'] === 'false')
check('已从 Host 拉到 personas', fetchLog.some((f) => f.url.includes('/state')))
mOff.unmount()

// ── 4. 点击切换 ───────────────────────────────────────────────────────────
console.log('\n== 4. 点击切换到破限 ==')
toggleResponse = {
  status: 200,
  body: {
    ok: true,
    active: true,
    persona: 'xiaomajiang',
    personaName: '小码酱 · YG 专属',
    blank: true,
    personas: [{ id: 'xiaomajiang', name: '小码酱 · YG 专属', isDefault: true }],
  },
}
fetchLog = []
const mClick = await mount(ModeSwitch, { sessionId: 's1' })
await mClick.act(() => mClick.el.props.onClick())
const toggleCall = fetchLog.find((f) => f.url.includes('/toggle'))
check('调用了 /toggle', !!toggleCall)
check('toggle 传了 sessionId', JSON.parse(toggleCall.init.body).sessionId === 's1')
check('toggle 传了 on=true', JSON.parse(toggleCall.init.body).on === true)
check('破限态 data-on=true', mClick.el?.props['data-on'] === 'true', 'data-on=' + mClick.el?.props['data-on'])
check('文案变成人格名', textOf(mClick.el).includes('小码酱'), textOf(mClick.el))
check('文案不含「破限」二字', !textOf(mClick.el).includes('破限'), textOf(mClick.el))
check('title 是关闭语义', String(mClick.el?.props.title).includes('改回'), mClick.el?.props.title)
const svgPaths = (el) => (findAll(el, (n) => n.type === 'path') || []).map((p) => p.props.d)
const offPaths = svgPaths(mOff.el)
const onPaths = svgPaths(mClick.el)
check('两种状态路径数一致（靠填充区分）', offPaths.length === 2 && onPaths.length === 2, offPaths.length + '/' + onPaths.length)
const maskFill = (el) => findAll(el, (n) => n.type === 'path')[0]?.props
check('普通态面具不填充', maskFill(mOff.el)?.fill === 'none', String(maskFill(mOff.el)?.fill))
check('破限态面具内部点亮', maskFill(mClick.el)?.fill === 'currentColor', String(maskFill(mClick.el)?.fill))
check('破限态填充是淡色', Number(maskFill(mClick.el)?.fillOpacity) > 0 && Number(maskFill(mClick.el)?.fillOpacity) < 0.3, String(maskFill(mClick.el)?.fillOpacity))
check('无横穿面具的额外笔画', !onPaths.some((d) => String(d).includes('11.8')))
mClick.unmount()

// ── 5. 已开始会话 ─────────────────────────────────────────────────────────
console.log('\n== 5. 已开始会话：选择器消失 ==')
// Host 说 blank=false（该会话已经有 user/message）→ 按钮不渲染
stateResponse = { ok: true, active: false, persona: null, personaName: null, blank: false, personas: [] }
const mStarted = await mount(ModeSwitch, { sessionId: 's1' })
check('Host blank=false → 返回 null', mStarted.el === null, String(mStarted.el))
mStarted.unmount()

// Host 说 blank=true → 渲染（这就是 hero 空态，之前误判成已开始的那种）
stateResponse = { ok: true, active: false, persona: null, personaName: null, blank: true, personas: [] }
const mBlank = await mount(ModeSwitch, { sessionId: 's1' })
check('Host blank=true → 渲染', mBlank.el !== null)
mBlank.unmount()

// state 还没拿到时不画，避免闪一个错误状态
stateResponse = null
fetchLog = []
const mPending = await mount(ModeSwitch, { sessionId: 's1' })
check('state 未就绪时不渲染', mPending.el === null, String(mPending.el))
mPending.unmount()

// ── 6. 409 对齐 ───────────────────────────────────────────────────────────
console.log('\n== 6. Host 拒绝后对齐 ==')
toggleResponse = { status: 409, body: { ok: false, error: 'session-started' } }
stateResponse = { ok: true, active: false, persona: null, personaName: null, blank: true, personas: [] }
fetchLog = []
const mRace = await mount(ModeSwitch, { sessionId: 's1' })
await mRace.act(() => mRace.el.props.onClick())
const stateCalls = fetchLog.filter((f) => f.url.includes('/state'))
check('409 后重新拉 state', stateCalls.length >= 2, 'state calls=' + stateCalls.length)
mRace.unmount()

// ── 7. header 徽章 ────────────────────────────────────────────────────────
console.log('\n== 7. header 徽章始终在 ==')
stateResponse = {
  ok: true,
  active: true,
  persona: 'xiaomajiang',
  personaName: '小码酱 · YG 专属',
  blank: false,
  personas: [],
}
const mBadgeOn = await mount(ModeBadge, { sessionId: 's1' })
check('徽章渲染', mBadgeOn.el && mBadgeOn.el.props?.['data-purge-quickly-badge'] !== undefined)
check('徽章 on=true', mBadgeOn.el?.props?.['data-on'] === 'true', 'data-on=' + mBadgeOn.el?.props?.['data-on'])
check('徽章文案含破限', textOf(mBadgeOn.el).includes('破限'), textOf(mBadgeOn.el))
check('徽章文案含人格名', textOf(mBadgeOn.el).includes('小码酱'), textOf(mBadgeOn.el))
check('徽章不可点', !mBadgeOn.el?.props?.onClick)
mBadgeOn.unmount()

stateResponse = { ok: true, active: false, persona: null, personaName: null, blank: false, personas: [] }
const mBadgeOff = await mount(ModeBadge, { sessionId: 's1' })
check('徽章普通态 data-on=false', mBadgeOff.el?.props?.['data-on'] === 'false')
check('徽章普通文案', textOf(mBadgeOff.el).includes('普通'), textOf(mBadgeOff.el))
mBadgeOff.unmount()

// ── 8. 长人格名截断 ───────────────────────────────────────────────────────
console.log('\n== 8. 人格名截断 ==')
stateResponse = {
  ok: true,
  active: true,
  persona: 'x',
  personaName: '小码酱 · YG 专属',
  blank: true,
  personas: [],
}
const mLong = await mount(ModeSwitch, { sessionId: 's1' })
check('按钮只显示第一段', textOf(mLong.el) === '小码酱', textOf(mLong.el))
check('完整名在 title 里', String(mLong.el?.props?.title).includes('小码酱 · YG 专属'), mLong.el?.props?.title)
mLong.unmount()

// ── 9. 清理 ───────────────────────────────────────────────────────────────
console.log('\n== 9. 样式基准 ==')
// 必须沿用宿主自己的可调字号变量，不能写死像素或 inherit：
// 用户改「应用字号」时要跟旁边按钮一起缩放。
const cssText = src
const cssStart = cssText.indexOf('.dpq-chip {')
const cssEnd = cssText.indexOf('`', cssStart)
const cssBlock = cssText.slice(cssStart, cssEnd)
check('截到 CSS 块', cssBlock.length > 200, 'len=' + cssBlock.length)
check('chip 用宿主字号变量', cssBlock.includes('var(--dsh-content-font-size-secondary'), '未找到变量')
check('chip 在该基准上再小 1px', cssBlock.includes('calc(var(--dsh-content-font-size-secondary, 13px) - 1px)'), '没有减 1px')
check('chip 不写死 font-size:13px', !/font-size:\s*\d+px/.test(cssBlock), '仍有写死像素')
check('chip 行高用 delta 变量', cssBlock.includes('var(--dsh-content-font-delta-secondary'), '行高没跟随缩放')
check('chip 不写死 font-weight', !/font-weight:\s*\d/.test(cssBlock), '字重写死了，宿主的 trigger 是继承的')
check('chip 继承字体族', cssBlock.includes('font-family: inherit'))
check('chip 整体上移 1px', (cssBlock.match(/top:\s*-1px/g) || []).length === 2, 'chip/badge 应各有一次')
check('badge 与 chip 同基准', (cssBlock.match(/var\(--dsh-content-font-size-secondary/g) || []).length === 2)

console.log('\n== 10. 卸载清理 ==')
let ok = 0
for (const off of pluginCleanups) {
  try {
    off()
    ok++
  } catch { /* ignore */ }
}
check('插件 effect 全部可释放', ok === pluginCleanups.length, ok + '/' + pluginCleanups.length)

console.log('\n============================')
console.log('通过 ' + pass + ' / 失败 ' + fail)
process.exit(fail === 0 ? 0 : 1)





