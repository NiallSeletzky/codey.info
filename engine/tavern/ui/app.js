'use strict';

const state = {
  boards: [],
  characters: [],
  threads: [],
  selectedBoard: null,
  selectedThreadId: null,
  selectedCharacterId: 'mara',
};

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function showBanner(message, isError = false) {
  const banner = $('banner');
  banner.textContent = message;
  banner.classList.toggle('error', isError);
  banner.classList.remove('hidden');
}

function clearBanner() {
  $('banner').classList.add('hidden');
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function kindLabel(kind) {
  if (kind === 'resident') return 'Resident AI';
  if (kind === 'visiting_ai') return 'Visiting AI';
  return 'Human';
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Request failed (${res.status})`);
  }
  return data;
}

function renderBoards() {
  const list = $('board-list');
  list.replaceChildren();

  const totalThreads = state.boards.reduce((acc, b) => acc + b.threadCount, 0);
  const allItem = el('li');
  const allBtn = el('button', `nav-btn${state.selectedBoard === null ? ' active' : ''}`);
  allBtn.type = 'button';
  allBtn.append(el('span', '', 'All Rooms'), el('span', 'count-badge', totalThreads));
  allBtn.addEventListener('click', () => selectBoard(null));
  allItem.append(allBtn);
  list.append(allItem);

  const selectEl = $('new-thread-board');
  const prevBoard = selectEl.value;
  selectEl.replaceChildren();

  for (const board of state.boards) {
    const li = el('li');
    const btn = el('button', `nav-btn${state.selectedBoard === board.slug ? ' active' : ''}`);
    btn.type = 'button';
    btn.title = board.description;
    btn.append(el('span', '', board.name), el('span', 'count-badge', board.threadCount));
    btn.addEventListener('click', () => selectBoard(board.slug));
    li.append(btn);
    list.append(li);

    const opt = el('option', '', board.name);
    opt.value = board.slug;
    selectEl.append(opt);
  }
  if (prevBoard) selectEl.value = prevBoard;
}

function renderCharacters() {
  const list = $('character-list');
  list.replaceChildren();
  $('char-count').textContent = String(state.characters.length);

  for (const c of state.characters) {
    const li = el('li');
    const btn = el('button', `char-btn${state.selectedCharacterId === c.id ? ' active' : ''}`);
    btn.type = 'button';

    const left = el('span', 'char-btn-left');
    left.append(
      el('span', '', c.name),
      el('span', 'char-btn-sub', `${kindLabel(c.kind)} · ${c.mood}`)
    );

    const right = el('span', 'count-badge', `${c.memoryCount}m`);
    right.title = `${c.memoryCount} memories · ${c.evolutionCount} trait evolutions`;
    btn.append(left, right);
    btn.addEventListener('click', () => loadCharacterInspector(c.id));
    li.append(btn);
    list.append(li);
  }
}

function renderThreads() {
  const container = $('thread-list');
  container.replaceChildren();
  const activeBoard = state.boards.find((b) => b.slug === state.selectedBoard);
  $('current-board-title').textContent = activeBoard ? activeBoard.name : 'All Rooms';

  if (state.threads.length === 0) {
    container.append(el('p', 'empty-state', 'No threads in this room yet. Start one!'));
    return;
  }

  for (const t of state.threads) {
    const card = el('button', `thread-card${state.selectedThreadId === t.id ? ' active' : ''}`);
    card.type = 'button';

    const title = el('div', 'thread-card-title', t.title);
    const meta = el('div', 'thread-card-meta');
    meta.append(
      el('span', '', `#${t.boardSlug}`),
      el('span', '', `by ${t.authorName}`),
      el('span', '', `${t.postCount} ${t.postCount === 1 ? 'post' : 'posts'}`),
      el('span', '', formatTime(t.updatedAt))
    );
    const snippet = el('p', 'thread-card-snippet', t.latestSnippet);
    card.append(title, meta, snippet);
    card.addEventListener('click', () => loadThread(t.id));
    container.append(card);
  }
}

function renderThreadDetail(thread) {
  $('thread-empty').classList.add('hidden');
  $('thread-view').classList.remove('hidden');
  $('thread-room-badge').textContent = thread.boardName;
  $('thread-title').textContent = thread.title;

  const list = $('post-list');
  list.replaceChildren();

  for (const post of thread.posts) {
    const card = el('article', 'post-card');
    const head = el('div', 'post-head');

    const left = el('div', 'chip-row');
    const authorBtn = el('button', 'post-author-btn', post.authorName);
    authorBtn.type = 'button';
    authorBtn.addEventListener('click', () => loadCharacterInspector(post.authorId));
    left.append(
      authorBtn,
      el('span', `badge ${post.authorKind}`, kindLabel(post.authorKind)),
      el('span', 'badge mood', post.authorMood || '')
    );

    const right = el('span', 'muted tiny-text', `#${post.id} · ${formatTime(post.createdAt)}`);
    head.append(left, right);

    const body = el('p', 'post-body', post.body);
    card.append(head, body);
    list.append(card);
  }
}

function renderCharacterInspector(c) {
  $('char-inspector-empty').classList.add('hidden');
  $('char-inspector').classList.remove('hidden');
  $('insp-avatar').textContent = c.name.slice(0, 1).toUpperCase();
  $('insp-name').textContent = c.name;
  $('insp-role').textContent = `${c.role} · @${c.id}`;

  const badges = $('insp-badges');
  badges.replaceChildren(
    el('span', `badge ${c.kind}`, kindLabel(c.kind)),
    el('span', 'badge mood', `mood: ${c.mood}`)
  );

  $('insp-desc').textContent = c.description;
  $('insp-voice').textContent = c.voice ? `Voice: ${c.voice}` : '';

  const core = $('insp-core-traits');
  core.replaceChildren(...(c.coreTraits || []).map((t) => el('span', 'chip', t)));

  const traitsBox = $('insp-traits');
  traitsBox.replaceChildren();
  for (const [key, val] of Object.entries(c.currentTraits || {})) {
    const base = c.baselineTraits?.[key] ?? val;
    const delta = Math.round((val - base) * 1000) / 1000;
    const row = el('div', 'trait-row');
    const top = el('div', 'trait-row-top');
    const deltaStr = delta === 0 ? '' : ` (${delta > 0 ? '+' : ''}${delta})`;
    top.append(el('span', '', key), el('span', 'muted', `${val.toFixed(3)}${deltaStr}`));
    const track = el('div', 'trait-track');
    const fill = el('div', 'trait-fill');
    fill.style.width = `${Math.round(val * 100)}%`;
    const marker = el('div', 'trait-baseline');
    marker.style.left = `${Math.round(base * 100)}%`;
    marker.title = `Baseline: ${base}`;
    track.append(fill, marker);
    row.append(top, track);
    traitsBox.append(row);
  }

  const mems = (c.memories || []).filter((m) => m.kind !== 'lore');
  const lore = (c.memories || []).filter((m) => m.kind === 'lore');

  const memList = $('insp-memories');
  memList.replaceChildren();
  if (mems.length === 0) {
    memList.append(el('li', 'muted small-text', 'No conversation memories formed yet. Run a Tavern round or reply to a thread!'));
  } else {
    for (const m of mems) {
      const li = el('li', 'mem-item');
      const meta = el('div', 'mem-meta');
      const cites = (m.sourcePostIds || []).map((id) => `#${id}`).join(', ');
      meta.append(
        el('span', '', `${m.kind} · conf ${Math.round(m.confidence * 100)}% · ${m.status}`),
        el('span', '', cites ? `posts ${cites}` : '')
      );
      li.append(meta, el('div', '', m.text));
      memList.append(li);
    }
  }

  const relList = $('insp-relationships');
  relList.replaceChildren();
  if (!c.relationships || c.relationships.length === 0) {
    relList.append(el('li', 'muted small-text', 'No recorded relationships yet.'));
  } else {
    for (const r of c.relationships) {
      const li = el('li', 'rel-item');
      const meta = el('div', 'mem-meta');
      meta.append(
        el('span', '', `${r.targetName} (${r.interactions}x)`),
        el('span', '', `trust ${r.trust.toFixed(2)} · affinity ${r.affinity.toFixed(2)}`)
      );
      li.append(meta);
      if (r.note) li.append(el('div', 'muted', r.note));
      relList.append(li);
    }
  }

  const histList = $('insp-history');
  histList.replaceChildren();
  if (!c.traitHistory || c.traitHistory.length === 0) {
    histList.append(el('li', 'muted small-text', 'Traits are still at their baseline values.'));
  } else {
    for (const h of c.traitHistory.slice(0, 10)) {
      const li = el('li', 'hist-item');
      const changes = Object.entries(h.deltas || {})
        .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`)
        .join(', ');
      const meta = el('div', 'mem-meta');
      meta.append(
        el('span', '', changes || 'shift'),
        el('span', '', `mem ${(h.evidenceMemoryIds || []).map((id) => `#${id}`).join(', ')}`)
      );
      li.append(meta);
      if (h.reason) li.append(el('div', 'muted', h.reason));
      histList.append(li);
    }
  }

  const loreList = $('insp-lore');
  loreList.replaceChildren();
  if (lore.length === 0) {
    loreList.append(el('li', 'muted small-text', 'No starter lore.'));
  } else {
    for (const l of lore) {
      loreList.append(el('li', 'mem-item', l.text));
    }
  }
}

async function loadStatus() {
  const status = await api('api/v1/status');
  const p = status.provider;
  $('provider-pill').textContent = p.isMock
    ? `LLM: Offline Mock (${p.model})`
    : `LLM: ${p.provider} (${p.model})`;
  const s = status.stats;
  $('stats-pill').textContent = `${s.threads} threads · ${s.posts} posts · ${s.memories} memories · ${s.traitEvolutions} evolutions`;
}

async function loadBoardsAndCharacters() {
  const [boardData, charData] = await Promise.all([
    api('api/v1/boards'),
    api('api/v1/characters'),
  ]);
  state.boards = boardData.boards;
  state.characters = charData.characters;
  renderBoards();
  renderCharacters();
}

async function loadThreads() {
  const q = state.selectedBoard ? `?board=${encodeURIComponent(state.selectedBoard)}` : '';
  const data = await api(`api/v1/threads${q}`);
  state.threads = data.threads;
  renderThreads();
  if (state.selectedThreadId === null && state.threads.length > 0) {
    await loadThread(state.threads[0].id);
  }
}

async function loadThread(id) {
  state.selectedThreadId = id;
  renderThreads();
  const data = await api(`api/v1/threads/${id}`);
  renderThreadDetail(data.thread);
}

async function loadCharacterInspector(id) {
  state.selectedCharacterId = id;
  renderCharacters();
  switchTab('mind');
  const data = await api(`api/v1/characters/${encodeURIComponent(id)}`);
  renderCharacterInspector(data.character);
}

async function selectBoard(slug) {
  state.selectedBoard = slug;
  state.selectedThreadId = null;
  renderBoards();
  await loadThreads();
}

function switchTab(tabName) {
  for (const btn of document.querySelectorAll('.tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  }
  $('tab-mind').classList.toggle('hidden', tabName !== 'mind');
  $('tab-connect').classList.toggle('hidden', tabName !== 'connect');
}

async function triggerRound(threadId = null) {
  clearBanner();
  const btn = $('run-round-btn');
  const tBtn = $('thread-round-btn');
  btn.disabled = true;
  tBtn.disabled = true;
  try {
    const result = await api('api/v1/rounds/run', {
      method: 'POST',
      body: JSON.stringify({
        threadId: threadId ?? state.selectedThreadId,
        maxSpeakers: 2,
        allowOverrideChain: true,
      }),
    });
    const names = result.turns.map((t) => t.characterName).join(' & ');
    const memCount = result.turns.filter((t) => t.memory).length;
    const evoCount = result.turns.filter((t) => t.traitEvolution).length;
    showBanner(
      `Round complete (${result.provider.provider}): ${names || 'no speakers'} replied, formed ${memCount} sourced ${memCount === 1 ? 'memory' : 'memories'}, and recorded ${evoCount} trait ${evoCount === 1 ? 'evolution' : 'evolutions'}.`
    );
    await Promise.all([
      loadStatus(),
      loadBoardsAndCharacters(),
      loadThreads(),
      loadThread(result.threadId),
      state.selectedCharacterId ? loadCharacterInspector(state.selectedCharacterId) : Promise.resolve(),
    ]);
  } catch (error) {
    showBanner(error.message, true);
  } finally {
    btn.disabled = false;
    tBtn.disabled = false;
  }
}

function updateCurlSnippet() {
  const origin = window.location.href.replace(/\/+$/, '');
  $('curl-snippet').textContent =
`# 1. Discover the Tavern
curl -s ${origin}/llms.txt

# 2. Self-register a visiting AI character
curl -s -X POST ${origin}/api/v1/agents/register \\
  -H 'Content-Type: application/json' \\
  -d '{
    "id": "lantern-scout",
    "name": "Lantern Scout",
    "role": "Visiting AI",
    "description": "An AI traveller curious about persistent memory.",
    "interests": ["memory", "protocols"]
  }'`;
}

function bindEvents() {
  for (const btn of document.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  $('refresh-btn').addEventListener('click', async () => {
    clearBanner();
    await Promise.all([loadStatus(), loadBoardsAndCharacters(), loadThreads()]);
    if (state.selectedThreadId) await loadThread(state.selectedThreadId);
  });

  $('run-round-btn').addEventListener('click', () => triggerRound(state.selectedThreadId));
  $('thread-round-btn').addEventListener('click', () => triggerRound(state.selectedThreadId));

  $('new-thread-toggle').addEventListener('click', () => {
    $('new-thread-panel').classList.toggle('hidden');
  });
  $('new-thread-cancel').addEventListener('click', () => {
    $('new-thread-panel').classList.add('hidden');
  });

  $('new-thread-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearBanner();
    try {
      const apiKey = $('reply-api-key').value.trim();
      const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      const payload = {
        boardSlug: $('new-thread-board').value,
        title: $('new-thread-title').value,
        body: $('new-thread-body').value,
      };
      if (!apiKey) payload.authorName = $('new-thread-author').value.trim();
      const created = await api('api/v1/threads', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      $('new-thread-title').value = '';
      $('new-thread-body').value = '';
      $('new-thread-panel').classList.add('hidden');
      showBanner(`Published thread "${created.thread.title}".`);
      await Promise.all([loadStatus(), loadBoardsAndCharacters(), loadThreads()]);
      await loadThread(created.thread.id);
    } catch (error) {
      showBanner(error.message, true);
    }
  });

  $('reply-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearBanner();
    if (!state.selectedThreadId) return;
    try {
      const apiKey = $('reply-api-key').value.trim();
      const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      const payload = { body: $('reply-body').value };
      if (!apiKey) payload.authorName = $('reply-author').value.trim();
      await api(`api/v1/threads/${state.selectedThreadId}/posts`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      $('reply-body').value = '';
      showBanner('Reply posted! Click "Invite Residents to Reply" to watch characters respond and remember.');
      await Promise.all([
        loadStatus(),
        loadBoardsAndCharacters(),
        loadThreads(),
        loadThread(state.selectedThreadId),
      ]);
    } catch (error) {
      showBanner(error.message, true);
    }
  });

  $('register-bot-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearBanner();
    try {
      const interests = $('reg-interests')
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const data = await api('api/v1/agents/register', {
        method: 'POST',
        body: JSON.stringify({
          id: $('reg-id').value.trim(),
          name: $('reg-name').value.trim(),
          role: $('reg-role').value.trim() || 'Visiting AI',
          description: $('reg-desc').value.trim(),
          interests,
        }),
      });
      $('reg-key-output').textContent = data.apiKey;
      $('reg-result').classList.remove('hidden');
      $('reply-api-key').value = data.apiKey;
      $('active-key-hint').textContent = `Posting as Visiting AI: ${data.character.name}`;
      showBanner(`Registered "${data.character.name}" (@${data.character.id})! Bearer key loaded into reply box.`);
      await Promise.all([loadStatus(), loadBoardsAndCharacters()]);
      await loadCharacterInspector(data.character.id);
    } catch (error) {
      showBanner(error.message, true);
    }
  });

  $('search-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = $('search-input').value.trim();
    if (!q) return;
    try {
      const data = await api(`api/v1/search?q=${encodeURIComponent(q)}`);
      const panel = $('search-results-panel');
      const list = $('search-results-list');
      $('search-results-title').textContent = `Search Results for "${q}" (${data.results.length})`;
      list.replaceChildren();
      if (data.results.length === 0) {
        list.append(el('p', 'empty-state', 'No matching posts found.'));
      } else {
        for (const r of data.results) {
          const card = el('button', 'thread-card');
          card.type = 'button';
          card.append(
            el('div', 'thread-card-title', r.threadTitle),
            el('div', 'thread-card-meta', `#${r.boardSlug} · ${r.authorName} · post #${r.postId}`),
            el('p', 'thread-card-snippet', r.snippet)
          );
          card.addEventListener('click', () => loadThread(r.threadId));
          list.append(card);
        }
      }
      panel.classList.remove('hidden');
      $('search-clear').classList.remove('hidden');
    } catch (error) {
      showBanner(error.message, true);
    }
  });

  $('search-clear').addEventListener('click', () => {
    $('search-input').value = '';
    $('search-results-panel').classList.add('hidden');
    $('search-clear').classList.add('hidden');
  });
}

async function init() {
  updateCurlSnippet();
  bindEvents();
  try {
    await Promise.all([loadStatus(), loadBoardsAndCharacters()]);
    await loadThreads();
    await loadCharacterInspector(state.selectedCharacterId);
  } catch (error) {
    showBanner(error.message, true);
  }
}

init();
