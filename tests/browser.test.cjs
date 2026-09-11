const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

function setup({saved = null, fetchImpl} = {}) {
  const elements = new Map(), all = [], timers = new Map();
  let counter = 0;
  function element() {
    const e = {hidden: false, dataset: {}, style: {}, value: '', children: [], listeners: {}, _html: '', textContent: '',
      appendChild(child) { child.parent = this; this.children.push(child); },
      addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); },
      focus() {}, remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
      get firstElementChild() { return this.children[0]; },
      get innerHTML() { return this._html; },
      set innerHTML(value) { this._html = value; this.children = []; },
    };
    all.push(e);
    return e;
  }
  const context = {console, Date, Intl, AbortController, AbortSignal,
    document: {getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element, querySelectorAll() { return []; }},
    localStorage: {getItem() { return saved; }, setItem() { throw new Error('storage disabled'); }},
    setInterval() {}, setTimeout(fn) { timers.set(++counter, fn); return counter; }, clearTimeout(id) { timers.delete(id); },
    fetch: fetchImpl || (async () => ({ok: true, json: async () => ({threads: []})})),
  };
  context.window = context;
  vm.createContext(context);
  function run(code) { return vm.runInContext(code, context); }
  function script(file) { run(fs.readFileSync(path.join(root, file), 'utf8')); }
  script('tavern.js');
  return {context, run, script, all, elements, timers};
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function contents(e) { return e.innerHTML + e.textContent + e.children.map(contents).join(''); }

test('board metadata is escaped and local notes are visible after posting', async () => {
  const page = setup({fetchImpl: async () => ({ok: true, json: async () => ({threads: [
    {id: '<img src=x onerror=alert(1)>', replies: '<img src=x>', handle: 'guest', body: 'hi'}]})})});
  page.run('showBoard(null)');
  await settle();
  assert(!page.all.some(e => e.innerHTML.includes('<img')));
  assert(page.all.some(e => e.innerHTML.includes('&lt;img')));
  page.run('writeBoard("visitor", "My local note", null)');
  await settle();
  assert(contents(page.elements.get('log')).includes('My local note'));
});

test('late board responses do not replace another pane', async () => {
  let resolve;
  const page = setup({fetchImpl: () => new Promise(r => resolve = r)});
  page.run('showBoard(null); look()');
  resolve({ok: true, json: async () => ({threads: [{id: 99, body: 'late board'}]})});
  await settle();
  assert(!contents(page.elements.get('log')).includes('late board'));
  assert(contents(page.elements.get('log')).includes('Soot, oak'));
});

test('malformed local storage and blocked storage do not break the room', () => {
  const page = setup({saved: JSON.stringify({trust: null, board: 'bad', gold: {}, turns: []})});
  assert.doesNotThrow(() => page.run('enter(); buyAle();'));
  assert.equal(page.run('state.gold'), 8);
  assert.equal(page.run('state.turns'), 1);
});

test('leaving watch cancels an outstanding response', async () => {
  let resolve;
  const page = setup({fetchImpl: () => new Promise(r => resolve = r)});
  page.script('talk-watch.js');
  page.run('watch(); run("quit")');
  resolve({ok: true, json: async () => ({tick: 1, updated: new Date().toISOString(), lines: [{id: 'late', handle: 'Mara', text: 'late speech'}]})});
  await settle();
  assert(!contents(page.elements.get('log')).includes('late speech'));
  assert.equal(page.elements.get('room').hidden, true);
});

test('watch displays failures, deduplicates refreshes and pauses', async () => {
  let calls = 0;
  const page = setup({fetchImpl: async () => { calls++; return {ok: true, json: async () => ({tick: 1,
    updated: new Date().toISOString(), lines: [{id: 'one', handle: 'Mara', text: 'Welcome to the fire.'}]})}; }});
  page.script('talk-watch.js');
  page.run('watch()');
  await settle();
  const count = page.elements.get('log').children.length;
  const refresh = [...page.timers.values()].at(-1);
  refresh();
  await settle();
  assert.equal(calls, 2);
  assert.equal(page.elements.get('log').children.length, count);
  page.elements.get('pause-watch').listeners.click[0]();
  assert(page.elements.get('watch-status').textContent.includes('paused'));
});

test('failed feed loads give visible feedback', async () => {
  const page = setup({fetchImpl: async () => { throw new Error('offline'); }});
  page.script('talk-watch.js');
  page.run('watch()');
  await settle();
  assert(page.elements.get('watch-status').textContent.includes('could not be refreshed'));
});
