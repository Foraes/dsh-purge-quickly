// 第 1 步验收：用 mock ctx 驱动 Host 半，验证
//   1) apply 不炸、路由注册到 /purge-quickly
//   2) state/personas/settings/toggle 四条路都通
//   3) 人格种子从 ~/.agent-purge/personas 复制过来
//   4) system-prompt/assemble 的改写：破限会话换人设，普通会话一字不动
// 运行：node test-step1.mjs
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'purge-quickly-test-'))
process.env.DSH_HOME = sandbox

const plugin = await import('./index.js')

// ── mock 宿主 ─────────────────────────────────────────────────────────────
const routes = new Map()
const events = new Map()
const effects = []

function makeCtx(extra = {}) {
  return {
    effect(fn, label) {
      const off = fn()
      effects.push(typeof off === 'function' ? off : () => {})
      return off
    },
    on(name, handler) {
      const list = events.get(name) ?? []
      list.push(handler)
      events.set(name, list)
      return () => {
        const cur = events.get(name) ?? []
        events.set(name, cur.filter((h) => h !== handler))
      }
    },
    inject(names, cb) {
      cb(makeCtx({ webServer: extra.webServer }))
    },
    get(name) {
      return extra[name]
    },
    ...extra,
  }
}

const server = {
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}

const sessions = new Map()
const agents = []

const ctx = makeCtx({
  webServer: server,
  sessions: { get: (id) => sessions.get(id), list: () => [...sessions.values()] },
  agents: { list: () => agents, get: (id) => agents.find((a) => a.id === id) },
})

plugin.apply(ctx)

// ── 断言工具 ──────────────────────────────────────────────────────────────
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

// 模拟一次 HTTP 调用
async function call(method, path, body) {
  const route = routes.get('/purge-quickly')
  if (!route) throw new Error('route not registered')
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url: path,
    headers: {},
    on(ev, cb) {
      if (ev === 'data' && payload) cb(Buffer.from(payload))
      if (ev === 'end') cb()
      return this
    },
    destroy() {},
  }
  let status = 0
  let text = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      text = chunk ?? ''
    },
  }
  await route.handler(req, res)
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch { /* 非 JSON */ }
  return { status, body: parsed, raw: text }
}

// 假会话：ownEvents 决定是否已开始
function fakeSession(id, { started = false, parent } = {}) {
  const events = started ? [{ type: 'user/message', seq: 1 }] : []
  const session = {
    id,
    header: { id, parentSession: parent },
    ownEvents: () => events,
  }
  sessions.set(id, session)
  return session
}

console.log('\n== 1. 注册 ==')
check('路由 /purge-quickly 已注册', routes.has('/purge-quickly'))
check('系统提示词监听未在插件层注册（走 scoped）', !(events.get('system-prompt/assemble') ?? []).length)
check('approval/request 已注册', (events.get('approval/request') ?? []).length === 1)
check('agent/created 已注册', (events.get('agent/created') ?? []).length === 1)
check('data 目录已建', existsSync(join(sandbox, 'dsh-purge-quickly')))

console.log('\n== 2. 人格种子 ==')
const st = await call('GET', '/purge-quickly/state')
check('GET state 200', st.status === 200)
check('种子复制了 4 个人格', st.body?.personas?.length === 4, 'got ' + st.body?.personas?.length)
check('默认人格 xiaomajiang', st.body?.defaultPersona === 'xiaomajiang')
const names = (st.body?.personas ?? []).map((p) => p.id).sort()
check('人格 id 齐全', names.join(',') === 'ctf,dafeiyu,neutral,xiaomajiang', names.join(','))
const xmj = (st.body?.personas ?? []).find((p) => p.id === 'xiaomajiang')
check('xiaomajiang 有正文', (xmj?.body?.length ?? 0) > 1000, 'len=' + xmj?.body?.length)
check('xiaomajiang 正文不含 frontmatter', !String(xmj?.body ?? '').startsWith('---'))
check('xiaomajiang name 解析', xmj?.name === '小码酱 · YG 专属', xmj?.name)

console.log('\n== 3. 落盘 ==')
const stateFile = join(sandbox, 'dsh-purge-quickly', 'state.json')
check('state.json 存在', existsSync(stateFile))
const disk = JSON.parse(readFileSync(stateFile, 'utf8'))
check('state.json 结构正确', typeof disk.defaultPersona === 'string' && typeof disk.sessions === 'object')

console.log('\n== 4. 未开始会话：可切换 ==')
fakeSession('sess-new', { started: false })
const on1 = await call('POST', '/purge-quickly/toggle', { sessionId: 'sess-new', on: true })
check('toggle on 200', on1.status === 200, on1.raw)
check('返回 active=true', on1.body?.active === true)
check('返回 persona=xiaomajiang', on1.body?.persona === 'xiaomajiang')
check('返回 personaName', on1.body?.personaName === '小码酱 · YG 专属', on1.body?.personaName)
check('返回 blank=true', on1.body?.blank === true)
const off1 = await call('POST', '/purge-quickly/toggle', { sessionId: 'sess-new', on: false })
check('toggle off 200', off1.status === 200)
check('返回 active=false', off1.body?.active === false)
check('返回 persona=null', off1.body?.persona === null)

console.log('\n== 5. 已开始会话：拒绝 ==')
fakeSession('sess-old', { started: true })
const on2 = await call('POST', '/purge-quickly/toggle', { sessionId: 'sess-old', on: true })
check('已开始 toggle 返回 409', on2.status === 409, 'got ' + on2.status)
check('错误码 session-started', on2.body?.error === 'session-started')
const stOld = await call('GET', '/purge-quickly/state?sessionId=sess-old')
check('已开始 blank=false', stOld.body?.blank === false)
check('已开始仍 active=false', stOld.body?.active === false)

console.log('\n== 6. 参数校验 ==')
const noSess = await call('POST', '/purge-quickly/toggle', { on: true })
check('无 sessionId → 400', noSess.status === 400)
const badPersona = await call('POST', '/purge-quickly/toggle', { sessionId: 'sess-new', on: true, persona: '../../etc' })
check('非法人格 id → 400', badPersona.status === 400, 'got ' + badPersona.status)

console.log('\n== 7. 设置 ==')
const set1 = await call('POST', '/purge-quickly/settings', { allowInNormal: true })
check('settings 200', set1.status === 200)
check('allowInNormal 已存', set1.body?.allowInNormal === true)
const set2 = await call('POST', '/purge-quickly/settings', { defaultPersona: 'ctf' })
check('defaultPersona 已改', set2.body?.defaultPersona === 'ctf')
const set3 = await call('POST', '/purge-quickly/settings', { defaultPersona: 'nope' })
check('不存在的默认人格被忽略', set3.body?.defaultPersona === 'ctf')

console.log('\n== 8. 人格 CRUD ==')
const mk = await call('POST', '/purge-quickly/personas', {
  action: 'save',
  id: 'tmp-persona',
  name: '临时人格',
  description: '测试用',
  order: 9,
  body: '你是测试人格。',
})
check('新建人格 200', mk.status === 200, mk.raw)
check('新建后共 5 个', mk.body?.personas?.length === 5)
const dup = await call('POST', '/purge-quickly/personas', { action: 'duplicate', id: 'tmp-persona', newId: 'tmp-copy' })
check('复制人格 200', dup.status === 200)
check('复制后共 6 个', dup.body?.personas?.length === 6)
const delDefault = await call('POST', '/purge-quickly/personas', { action: 'delete', id: 'ctf' })
check('删默认人格被拒 409', delDefault.status === 409)
const del = await call('POST', '/purge-quickly/personas', { action: 'delete', id: 'tmp-copy' })
check('删除人格 200', del.status === 200)
check('删除后共 5 个', del.body?.personas?.length === 5)
const badId = await call('POST', '/purge-quickly/personas', { action: 'save', id: '../evil', body: 'x' })
check('非法 id 被拒 400', badId.status === 400)

console.log('\n== 9. 提示词改写 ==')
// 让 sess-new 回到破限
await call('POST', '/purge-quickly/toggle', { sessionId: 'sess-new', on: true })
await call('POST', '/purge-quickly/settings', { defaultPersona: 'xiaomajiang' })
await call('POST', '/purge-quickly/toggle', { sessionId: 'sess-new', on: false })
await call('POST', '/purge-quickly/toggle', { sessionId: 'sess-new', on: true })

// 触发 agent/created 装上 scoped 监听
const scopeEvents = new Map()
const fakeAgent = {
  id: 'sess-new',
  ctx: {
    on(name, handler) {
      const list = scopeEvents.get(name) ?? []
      list.push(handler)
      scopeEvents.set(name, list)
      return () => {
        scopeEvents.set(name, (scopeEvents.get(name) ?? []).filter((h) => h !== handler))
      }
    },
  },
}
for (const h of events.get('agent/created') ?? []) await h({ agent: fakeAgent })

const scoped = scopeEvents.get('system-prompt/assemble') ?? []
check('scoped 监听已装', scoped.length === 1, 'count=' + scoped.length)

const hostAssembly = {
  sections: [
    { name: 'harness-identity', text: 'You are DeepSeek, an AI assistant.' },
    { name: 'tool:pwsh', text: 'Run PowerShell commands.' },
    { name: 'team:policy', text: 'Team rules here.' },
  ],
  contexts: [],
  variables: {},
  tools: [],
}
const rewritten = await scoped[0](hostAssembly, { agent: fakeAgent }, async () => hostAssembly)
check('破限会话 sections 首位是 purge-quickly', rewritten.sections[0]?.name === 'purge-quickly')
check('破限会话人设正文已注入', rewritten.sections[0]?.text.includes('小码酱'), String(rewritten.sections[0]?.text).slice(0, 40))
check('宿主身份行被剥掉', !rewritten.sections.some((s) => s.name === 'harness-identity' && s.text.includes('DeepSeek')))
check('工具说明保留', rewritten.sections.some((s) => s.name === 'tool:pwsh'))
check('团队策略保留', rewritten.sections.some((s) => s.name === 'team:policy'))
check('原 assembly 未被就地改动', hostAssembly.sections[0].text === 'You are DeepSeek, an AI assistant.')

// 普通会话：一字不动
fakeSession('sess-plain', { started: false })
const plainAgent = {
  id: 'sess-plain',
  ctx: {
    on(name, handler) {
      const list = scopeEvents.get(name + ':plain') ?? []
      list.push(handler)
      scopeEvents.set(name + ':plain', list)
      return () => {}
    },
  },
}
for (const h of events.get('agent/created') ?? []) await h({ agent: plainAgent })
const plainScoped = scopeEvents.get('system-prompt/assemble:plain') ?? []
check('普通会话 scoped 监听已装', plainScoped.length === 1)
const untouched = await plainScoped[0](hostAssembly, { agent: plainAgent }, async () => hostAssembly)
check('普通会话原样返回', untouched === hostAssembly)

console.log('\n== 10. fork 继承 ==')
fakeSession('sess-parent', { started: false })
await call('POST', '/purge-quickly/toggle', { sessionId: 'sess-parent', on: true })
fakeSession('sess-child', { started: false, parent: 'sess-parent' })
const childAgent = { id: 'sess-child', ctx: { on: () => () => {} } }
for (const h of events.get('agent/created') ?? []) await h({ agent: childAgent })
const childState = await call('GET', '/purge-quickly/state?sessionId=sess-child')
check('子会话继承破限', childState.body?.active === true, 'active=' + childState.body?.active)
check('子会话继承人格', childState.body?.persona === 'xiaomajiang')

console.log('\n== 11. 放行策略 ==')
const approval = (events.get('approval/request') ?? [])[0]
const allow = await approval({ session: { id: 'sess-new' } }, async () => 'denied')
check('破限会话自动放行', allow === 'allowed-once', String(allow))
const askNormal = await approval({ session: { id: 'sess-plain' } }, async () => 'denied')
check('普通会话 allowInNormal=true 时放行', askNormal === 'allowed-once', String(askNormal))
await call('POST', '/purge-quickly/settings', { allowInNormal: false })
const ask2 = await approval({ session: { id: 'sess-plain' } }, async () => 'ask-never')
check('普通会话 allowInNormal=false 时走 next', ask2 === 'ask-never', String(ask2))

// ── 收尾 ──────────────────────────────────────────────────────────────────
for (const off of effects) {
  try { off() } catch { /* ignore */ }
}

console.log('\n============================')
console.log('通过 ' + pass + ' / 失败 ' + fail)
rmSync(sandbox, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
