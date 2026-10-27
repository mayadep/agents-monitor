const fs = require('fs'), assert = require('assert')
const html = fs.readFileSync(process.argv[2], 'utf8')
const js = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'))
// Minimal DOM: an element counts its writes and grows "<div></div>" children
const make = () => {
  const el = { writes: 0, children: [], dataset: {}, classList: { add() {}, remove() {} }, value: '', _h: '' }
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._h,
    set: v => { el._h = v; el.writes++; if (/^(<div><\/div>)+$/.test(v)) el.children = v.match(/<div><\/div>/g).map(make) },
  })
  return el
}
const els = {}
const document = { getElementById: id => (els[id] ??= make()) }
const sandbox = new Function('document', 'localStorage', 'fetch', 'EventSource', 'setInterval', 'confirm',
  js.replace(/connect\(\)\s*render\(\)\s*$/, '') +
  '; return { apply, render, get selected() { return selected }, set selected(v) { selected = v }, set agents(v) { AGENTS = v } }')
const api = sandbox(document, { getItem: () => null, setItem() {} }, () => Promise.reject(), function () {}, () => 0, () => true)
api.agents = ['architect', 'tester']
const T = Date.now() - 5000
const ev = o => ({ ts: T, session: 's1', agent_type: 'tester', ...o })
const check = (name, fn) => { try { fn(); console.log('PASS', name) } catch (e) { console.log('FAIL', name, e.message); process.exitCode = 1 } }

api.apply(ev({ event: 'SubagentStart', agent_id: 't1' }))
api.apply(ev({ event: 'PreToolUse', agent_id: 't1', tool: 'Bash', tool_use_id: 'c1', input: 'npm test' }))
api.apply(ev({ ts: T + 1, event: 'SubagentStart', agent_id: 't2' }))
api.apply(ev({ ts: T + 2, event: 'PreToolUse', agent_id: 't2', tool: 'Read', tool_use_id: 'c2', input: 'a.js' }))
api.apply(ev({ ts: T + 3, event: 'SubagentStart', agent_id: 'a1', agent_type: 'architect', session: 's2' }))
api.render()

const card = i => els.cards.children[i].innerHTML
check('agents list from server drives the cards', () => assert.equal(els.cards.children.length, 3))
check('two tester runs at once: count and both tools shown', () => {
  assert.match(card(2), /동시 실행 2개/); assert.match(card(2), /npm test/); assert.match(card(2), /a\.js/)
})
check('session options list both sessions', () => {
  assert.match(els.session.innerHTML, /value="s1"/); assert.match(els.session.innerHTML, /value="s2"/)
})
check('filter to s2 hides the tester runs and their events', () => {
  api.selected = 's2'; api.render()
  assert.match(card(1), /architect[\s\S]*실행/); assert.match(card(2), /아직 실행 기록 없음/)
  assert.doesNotMatch(els.feed.innerHTML, /npm test/)
  assert.equal(els.sRun.textContent, 1)
})
check('unchanged cards are not rewritten on the next render', () => {
  api.selected = ''; api.apply(ev({ ts: T + 4, event: 'SubagentStop', agent_id: 'a1', agent_type: 'architect', session: 's2' }))
  api.render()
  const before = els.cards.children.map(c => c.writes), feedBefore = els.feed.writes, selBefore = els.session.writes
  api.render() // nothing new; only running tester elapsed may tick, architect is done
  const after = els.cards.children.map(c => c.writes)
  assert.equal(after[1], before[1], 'architect card rewritten')
  assert.equal(els.feed.writes, feedBefore, 'feed rewritten'); assert.equal(els.session.writes, selBefore, 'session list rewritten')
})
