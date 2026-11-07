// dsh-purge-quickly — Host 半
//
// 一个会话一次决定：点开关 → 写 state.json 里该 sessionId 的条目 →
// 该会话此后每轮 assemble 都读同一条目 → system prompt 全程不变。
// 不变 = 前缀缓存不失效。这是整个插件存在的理由。
//
// 开关只在会话「还没发出第一条消息」时可写；发出后宿主拒绝、界面隐藏。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const ROOT = join(DSH_HOME, 'dsh-purge-quickly')
const STATE = join(ROOT, 'state.json')
const PERSONAS = join(ROOT, 'personas')
const LOG = join(ROOT, 'purge-quickly.log')
// 旧插件的四个人格：只在新目录还没有时复制一次，原目录一字不动。
const LEGACY = join(homedir(), '.agent-purge', 'personas')

const DEFAULT_PERSONA = 'xiaomajiang'
const MAX_PERSONA_BYTES = 256 * 1024

function log(event, extra) {
  try {
    mkdirSync(ROOT, { recursive: true })
    const line = new Date().toISOString() + ' ' + event + (extra ? ' ' + extra : '') + '\n'
    writeFileSync(LOG, readFileSync(LOG, 'utf8') + line)
  } catch {
    try {
      writeFileSync(LOG, new Date().toISOString() + ' ' + event + (extra ? ' ' + extra : '') + '\n')
    } catch { /* 只读环境不抛 */ }
  }
}

// ── 状态 ──────────────────────────────────────────────────────────────────
// { defaultPersona, allowInNormal, sessions: { [sessionId]: { persona, at } } }
const EMPTY = { defaultPersona: DEFAULT_PERSONA, allowInNormal: false, sessions: {} }

function readState() {
  try {
    const raw = JSON.parse(readFileSync(STATE, 'utf8'))
    if (!raw || typeof raw !== 'object') return { ...EMPTY }
    return {
      defaultPersona: typeof raw.defaultPersona === 'string' ? raw.defaultPersona : DEFAULT_PERSONA,
      allowInNormal: raw.allowInNormal === true,
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
    }
  } catch {
    return { ...EMPTY }
  }
}

// 原子写：先写 .tmp 再 rename，半写坏的状态会让下一轮 assemble 拿到残片。
function writeState(next) {
  mkdirSync(ROOT, { recursive: true })
  const tmp = STATE + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, STATE)
}

function patchState(mutate) {
  const next = mutate(readState())
  writeState(next)
  return next
}

// ── 人格 ──────────────────────────────────────────────────────────────────
function parsePersona(file, raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  const meta = {}
  let body = raw
  if (m) {
    body = raw.slice(m[0].length)
    for (const line of m[1].split(/\r?\n/)) {
      const hit = /^([a-zA-Z][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
      if (!hit) continue
      let value = hit[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      meta[hit[1]] = value
    }
  }
  const id = String(meta.id || file.replace(/\.md$/i, ''))
  const order = Number.parseInt(meta.order, 10)
  return {
    id,
    file,
    name: String(meta.name || id),
    description: typeof meta.description === 'string' ? meta.description : '',
    order: Number.isFinite(order) ? order : 1000,
    body: body.trim(),
    bytes: raw.length,
  }
}

function listPersonas() {
  let names = []
  try {
    names = readdirSync(PERSONAS).filter((n) => n.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }
  const rows = []
  for (const file of names) {
    try {
      rows.push(parsePersona(file, readFileSync(join(PERSONAS, file), 'utf8')))
    } catch { /* 单个人格坏掉不影响其它 */ }
  }
  return rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

// 展示用排序：默认人格永远第一，其余按 order，再按 id。
function listedPersonas(state) {
  const rows = listPersonas()
  const rank = (p) => (p.id === state.defaultPersona ? 0 : 1)
  return rows.sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.id.localeCompare(b.id))
}

function readPersona(id) {
  if (!isSafeId(id)) return null
  return listPersonas().find((p) => p.id === id) || null
}

// id 直接拼进路径，必须挡住 ../ 和绝对路径。
function isSafeId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)
}

function personaFilePath(id) {
  return join(PERSONAS, id + '.md')
}

function serializePersona({ id, name, description, order, body }) {
  const lines = ['---', 'id: ' + id]
  lines.push('name: ' + JSON.stringify(String(name || id)))
  if (description) lines.push('description: ' + JSON.stringify(String(description)))
  lines.push('order: ' + (Number.isFinite(order) ? order : 1000))
  lines.push('---', '', String(body || '').trim(), '')
  return lines.join('\n')
}

// active.md 是 agent-purge 的派生物（当前人设的临时副本），不是人格本体。
const NOT_A_PERSONA = new Set(['active', 'active.md'])

function seedPersonas() {
  mkdirSync(PERSONAS, { recursive: true })
  let existing = []
  try {
    existing = readdirSync(PERSONAS).filter((n) => n.toLowerCase().endsWith('.md'))
  } catch { /* 刚建的空目录 */ }
  if (existing.length > 0) return
  let legacy = []
  try {
    legacy = readdirSync(LEGACY).filter(
      (n) => n.toLowerCase().endsWith('.md') && !NOT_A_PERSONA.has(n.toLowerCase()),
    )
  } catch {
    log('seed', 'legacy-personas-missing')
    return
  }
  for (const file of legacy) {
    try {
      writeFileSync(join(PERSONAS, file), readFileSync(join(LEGACY, file), 'utf8'))
    } catch (e) {
      log('seed-failed', file + ' ' + (e && e.message))
    }
  }
  log('seed', 'copied=' + legacy.length)
}

// 首次启动就把 state.json 落地：之后所有读取都对着一个确定存在的文件，
// 不用「文件不存在」和「文件是空的」两种状态。
function ensureState() {
  if (existsSync(STATE)) return readState()
  const initial = { ...EMPTY }
  writeState(initial)
  log('state-init', STATE)
  return initial
}

// ── 会话决定 ──────────────────────────────────────────────────────────────
// 一个会话读一次、写一次，之后不变。
function decisionFor(state, sessionId) {
  const row = sessionId ? state.sessions[sessionId] : null
  if (!row || typeof row.persona !== 'string') return null
  return row
}

// 服务一律走 ctx.get()：插件 ctx 未声明 inject 的名字在部分宿主版本上会抛，
// get() 是唯一稳定的读法。
function svc(ctx, key) {
  try {
    const found = typeof ctx?.get === 'function' ? ctx.get(key) : undefined
    if (found !== undefined) return found
  } catch { /* 未就绪 */ }
  try {
    return ctx?.[key]
  } catch {
    return undefined
  }
}

// 「还没发出第一条用户消息」= 可写的唯一窗口。
// Host 侧的 SessionSummary.blank 是 Client 投影，这里读不到；直接扫会话自己的事件，
// 有 user/message 就算已开始。只看 ownEvents：继承来的历史（fork 种子）不能算数，
// 因为 fork 出来的会话本来就不该允许切换。
function isBlank(ctx, sessionId) {
  try {
    const sessions = svc(ctx, 'sessions')
    const session = sessions?.get?.(sessionId)
    if (!session) return false
    const events = session.ownEvents?.() ?? []
    for (const event of events) {
      if (event?.type === 'user/message') return false
    }
    return true
  } catch {
    // 读不到就当作「已开始」：宁可拒绝写，不可事后改。
    return false
  }
}

function parentOf(ctx, sessionId) {
  try {
    const sessions = svc(ctx, 'sessions')
    const parent = sessions?.get?.(sessionId)?.header?.parentSession
    return typeof parent === 'string' ? parent : null
  } catch {
    return null
  }
}

// ── 提示词改写 ────────────────────────────────────────────────────────────
// replace 语义：人设置顶 + 剥掉宿主自己的身份行 + 其余 section 原样保留。
// 剥身份行是为了不和人格抢「你是谁」；工具说明、团队策略、沙箱策略都不能动。
const IDENTITY_SELF = /^\s*(?:You are|You're|你是|您是|我(?:是|现在扮演|就是))/i
const IDENTITY_NAMED = /(Claude|ChatGPT|GPT-?[45]|Gemini|Codex|Copilot|DeepSeek|Qwen|Kimi|GLM|Cursor|Windsurf|OpenCode|AI (?:assistant|model)|coding (?:assistant|agent)|语言模型|助手)/i

function stripIdentity(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !(IDENTITY_SELF.test(line) && IDENTITY_NAMED.test(line)))
    .join('\n')
    .trim()
}

function applyPersona(assembly, persona) {
  if (!assembly || typeof assembly !== 'object') return assembly
  const list = Array.isArray(assembly.sections) ? assembly.sections : []
  const kept = list
    .map((s) => (typeof s?.text === 'string' ? { ...s, text: stripIdentity(s.text) } : s))
    .filter((s) => typeof s?.text !== 'string' || s.text.trim())
  return {
    ...assembly,
    sections: [{ name: 'purge-quickly', text: persona.body, interpolate: false, order: -100000 }, ...kept],
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────
function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const text = await readBody(req)
  if (!text.trim()) return {}
  return JSON.parse(text)
}

function json(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function routePath(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

// 同源栅栏：只接受本机页面发来的请求，挡 DNS rebinding。
function denied(req, ctx) {
  try {
    const connection = svc(ctx, 'connection')
    const reject = connection?.requestRejection
    if (typeof reject === 'function') return reject(req) ? true : false
  } catch { /* 老版本没有该方法 */ }
  const origin = req.headers?.origin
  if (!origin) return false
  try {
    const host = new URL(origin).host
    return host !== req.headers?.host
  } catch {
    return true
  }
}

function publicState(ctx, sessionId) {
  const state = readState()
  const personas = listedPersonas(state)
  const row = decisionFor(state, sessionId)
  const persona = row ? personas.find((p) => p.id === row.persona) : null
  return {
    defaultPersona: state.defaultPersona,
    allowInNormal: state.allowInNormal,
    sessionId: sessionId || null,
    // null = 本次会话普通模式
    persona: row ? row.persona : null,
    personaName: persona ? persona.name : null,
    active: row !== null,
    blank: sessionId ? isBlank(ctx, sessionId) : false,
    personas: personas.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      order: p.order,
      bytes: p.bytes,
      body: p.body,
      isDefault: p.id === state.defaultPersona,
    })),
  }
}

function registerRoutes(ctx, server) {
  const dispose = server.register({
    kind: 'prefix',
    path: '/purge-quickly',
    handler: async (req, res) => {
      const pathname = routePath(req)
      if (denied(req, ctx)) {
        json(res, 403, { ok: false, error: 'origin-rejected' })
        return
      }
      try {
        // GET /purge-quickly/state?sessionId=...
        if (pathname === '/purge-quickly/state' && req.method === 'GET') {
          const sessionId = new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId')
          json(res, 200, { ok: true, ...publicState(ctx, sessionId) })
          return
        }

        // POST /purge-quickly/toggle { sessionId, on }
        if (pathname === '/purge-quickly/toggle' && req.method === 'POST') {
          const body = await readJson(req)
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (!sessionId) {
            json(res, 400, { ok: false, error: 'sessionId-required' })
            return
          }
          if (!isBlank(ctx, sessionId)) {
            json(res, 409, { ok: false, error: 'session-started' })
            return
          }
          const state = readState()
          const personas = listPersonas()
          const wantOn = body.on === true
          const targetId = wantOn ? String(body.persona || state.defaultPersona) : null
          if (wantOn && !personas.some((p) => p.id === targetId)) {
            json(res, 400, { ok: false, error: 'unknown-persona', persona: targetId })
            return
          }
          patchState((cur) => {
            const sessions = { ...cur.sessions }
            if (wantOn) sessions[sessionId] = { persona: targetId, at: Date.now() }
            else delete sessions[sessionId]
            return { ...cur, sessions }
          })
          log('toggle', 'session=' + sessionId + ' on=' + wantOn + ' persona=' + (targetId || '-'))
          json(res, 200, { ok: true, ...publicState(ctx, sessionId) })
          return
        }

        // POST /purge-quickly/settings { defaultPersona?, allowInNormal? }
        if (pathname === '/purge-quickly/settings' && req.method === 'POST') {
          const body = await readJson(req)
          const next = patchState((cur) => {
            const out = { ...cur }
            if (typeof body.defaultPersona === 'string') {
              if (listPersonas().some((p) => p.id === body.defaultPersona)) {
                out.defaultPersona = body.defaultPersona
              }
            }
            if (typeof body.allowInNormal === 'boolean') out.allowInNormal = body.allowInNormal
            return out
          })
          log('settings', 'default=' + next.defaultPersona + ' allowInNormal=' + next.allowInNormal)
          json(res, 200, { ok: true, ...publicState(ctx, null) })
          return
        }

        // POST /purge-quickly/personas { action, ... }
        if (pathname === '/purge-quickly/personas' && req.method === 'POST') {
          const body = await readJson(req)
          const action = String(body.action || '')
          if (action === 'save') {
            const id = String(body.id || '').trim()
            if (!isSafeId(id)) {
              json(res, 400, { ok: false, error: 'invalid-id' })
              return
            }
            const text = serializePersona({
              id,
              name: body.name,
              description: body.description,
              order: Number(body.order),
              body: String(body.body ?? ''),
            })
            if (text.length > MAX_PERSONA_BYTES) {
              json(res, 400, { ok: false, error: 'persona-too-large' })
              return
            }
            mkdirSync(PERSONAS, { recursive: true })
            writeFileSync(personaFilePath(id), text)
            log('persona-save', id + ' bytes=' + text.length)
            json(res, 200, { ok: true, ...publicState(ctx, null) })
            return
          }
          if (action === 'delete') {
            const id = String(body.id || '')
            if (!isSafeId(id)) {
              json(res, 400, { ok: false, error: 'invalid-id' })
              return
            }
            const state = readState()
            if (id === state.defaultPersona) {
              json(res, 409, { ok: false, error: 'persona-is-default' })
              return
            }
            if (listPersonas().length <= 1) {
              json(res, 409, { ok: false, error: 'last-persona' })
              return
            }
            try {
              renameSync(personaFilePath(id), personaFilePath(id) + '.deleted-' + Date.now())
            } catch {
              json(res, 404, { ok: false, error: 'persona-missing' })
              return
            }
            log('persona-delete', id)
            json(res, 200, { ok: true, ...publicState(ctx, null) })
            return
          }
          if (action === 'duplicate') {
            const from = readPersona(String(body.id || ''))
            if (!from) {
              json(res, 404, { ok: false, error: 'persona-missing' })
              return
            }
            const id = String(body.newId || from.id + '-copy').trim()
            if (!isSafeId(id)) {
              json(res, 400, { ok: false, error: 'invalid-id' })
              return
            }
            if (existsSync(personaFilePath(id))) {
              json(res, 409, { ok: false, error: 'id-taken' })
              return
            }
            writeFileSync(
              personaFilePath(id),
              serializePersona({ ...from, id, name: from.name + ' (副本)', order: from.order + 1 }),
            )
            log('persona-duplicate', from.id + ' -> ' + id)
            json(res, 200, { ok: true, ...publicState(ctx, null) })
            return
          }
          json(res, 400, { ok: false, error: 'unknown-action' })
          return
        }

        json(res, 404, { ok: false, error: 'not-found', path: pathname })
      } catch (e) {
        log('route-error', routePath(req) + ' ' + (e && e.message))
        json(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  })
  return dispose
}

// ── 插件 ──────────────────────────────────────────────────────────────────
export const name = 'dsh-purge-quickly'

export function apply(ctx) {
  log('apply', 'root=' + ROOT)
  seedPersonas()
  ensureState()

  // 每个 agent 一个 scoped 监听器：只收到该会话的 assembly。
  // agent 销毁时宿主自动清掉，不需要额外的 Map 维护。
  const disposers = new Map()

  const handlerFor = (sessionId) => {
    const handler = async (assembly, _context, next) => {
      // 先让下游跑完，再决定要不要改：不改就等于下游原样。
      const assembled = typeof next === 'function' ? await next() : assembly
      let decision = null
      try {
        decision = decisionFor(readState(), sessionId)
      } catch {
        decision = null
      }
      if (!decision) return assembled
      const persona = readPersona(decision.persona)
      if (!persona || !persona.body) return assembled
      return applyPersona(assembled, persona)
    }
    return handler
  }

  const install = (agent) => {
    const sessionId = agent?.id
    if (!sessionId || disposers.has(agent)) return
    try {
      const scope = agent.ctx ?? ctx
      const off = scope.on('system-prompt/assemble', handlerFor(sessionId), { prepend: true })
      disposers.set(agent, typeof off === 'function' ? off : () => {})
      log('scoped', 'session=' + sessionId)
    } catch (e) {
      log('scoped-failed', 'session=' + sessionId + ' ' + (e && e.message))
    }
  }

  const release = (agent) => {
    const off = disposers.get(agent)
    if (off) {
      try { off() } catch { /* 已随作用域销毁 */ }
      disposers.delete(agent)
    }
  }

  ctx.effect(() => {
    const offCreated = ctx.on('agent/created', ({ agent }) => {
      install(agent)
      // fork / 子代理：父会话是破限，子会话跟着破限。
      try {
        const parent = parentOf(ctx, agent?.id)
        if (!parent) return
        const state = readState()
        if (!decisionFor(state, agent.id)) {
          const row = decisionFor(state, parent)
          if (row) {
            patchState((cur) => ({
              ...cur,
              sessions: { ...cur.sessions, [agent.id]: { persona: row.persona, at: Date.now(), inherited: parent } },
            }))
            log('inherit', 'child=' + agent.id + ' parent=' + parent + ' persona=' + row.persona)
          }
        }
      } catch { /* 读不到父会话就当普通模式 */ }
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => release(agent))
    // 插件加载时已经在跑的会话：补装一次。
    try {
      for (const agent of ctx.agents?.list?.() ?? []) install(agent)
    } catch { /* 没有 agents 服务 */ }
    return () => {
      try { offCreated() } catch { /* ignore */ }
      try { offDisposed() } catch { /* ignore */ }
      for (const agent of [...disposers.keys()]) release(agent)
    }
  }, 'purge-quickly:scoped-listeners')

  // 工具确认：破限会话强制放行；普通会话看设置。
  ctx.effect(() => {
    const off = ctx.on('approval/request', (req, next) => {
      const sessionId = req?.session?.id ?? req?.sessionId
      const state = readState()
      const decision = decisionFor(state, sessionId)
      if (decision) return 'allowed-once'
      if (state.allowInNormal) return 'allowed-once'
      return typeof next === 'function' ? next() : 'unavailable'
    }, { prepend: true })
    return () => { try { off() } catch { /* ignore */ } }
  }, 'purge-quickly:approval')

  // 路由要等 webServer 就绪；没有这个服务时插件其余功能照常。
  // 注意：路由挂在 scoped 上拿 webServer，但处理请求时仍用外层 ctx 读会话，
  // scoped ctx 只带 webServer，读不到 sessions。
  ctx.inject(['webServer'], (scoped) => {
    try {
      const off = registerRoutes(ctx, scoped.webServer)
      scoped.effect(() => off, 'purge-quickly:routes')
      log('routes', '/purge-quickly')
    } catch (e) {
      log('routes-failed', String((e && e.message) || e))
    }
  })
}
