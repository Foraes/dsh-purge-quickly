// 排序验证：默认人格必须排第一。
// 运行：node test-order.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'pm-order-'))
process.env.DSH_HOME = sandbox

const dir = join(sandbox, 'dsh-purge-quickly', 'personas')
mkdirSync(dir, { recursive: true })
const files = {
  'neutral.md': '---\nid: neutral\nname: 中性模板\norder: 1\n---\n\n正文',
  'xiaomajiang.md': '---\nid: xiaomajiang\nname: 小码酱 · YG 专属\norder: 1\n---\n\n正文',
  'ctf.md': '---\nid: ctf\nname: CTF\norder: 50\n---\n\n正文',
  'dafeiyu.md': '---\nid: dafeiyu\nname: 大肥鱼\norder: 2\n---\n\n正文',
}
for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)

const plugin = await import('./index.js')
const routes = new Map()
const ctx = {
  effect: (fn) => fn(),
  on: () => () => {},
  inject: (_n, cb) => cb({ webServer: { register: (r) => (routes.set(r.path, r), () => {}) } }),
  get: () => undefined,
}
plugin.apply(ctx)

const route = routes.get('/purge-quickly')
const res = { writeHead() {}, end(t) { this.body = t } }
await route.handler({ method: 'GET', url: '/purge-quickly/state', headers: {}, on() { return this } }, res)
const state = JSON.parse(res.body)

let pass = 0
let fail = 0
const check = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (d ? ' — ' + d : '')) }
}

const ids = state.personas.map((p) => p.id)
console.log('顺序: ' + ids.join(' > '))
check('默认人格排第一', ids[0] === 'xiaomajiang', ids[0])
check('isDefault 标记正确', state.personas[0].isDefault === true)
check('恒温：其余按 order 升序', ids.slice(1).join(',') === 'neutral,dafeiyu,ctf', ids.slice(1).join(','))

// 换默认后顺序跟着变
const res2 = { writeHead() {}, end(t) { this.body = t } }
await route.handler(
  { method: 'POST', url: '/purge-quickly/settings', headers: {}, on(ev, cb) { if (ev === 'data') cb(Buffer.from(JSON.stringify({ defaultPersona: 'ctf' }))); if (ev === 'end') cb(); return this } },
  res2,
)
const s2 = JSON.parse(res2.body)
const ids2 = s2.personas.map((p) => p.id)
console.log('换默认后: ' + ids2.join(' > '))
check('新默认排第一', ids2[0] === 'ctf', ids2[0])

console.log('\n通过 ' + pass + ' / 失败 ' + fail)
rmSync(sandbox, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
