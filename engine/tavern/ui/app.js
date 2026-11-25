'use strict';

const state = {
  boards: [],
  characters: [],
  threads: [],
  selectedBoard: null,
  selectedThreadId: null,
  selectedCharacterId: 'mara',
  roundtable: null,
  activeView: 'rooms',
  selectedForumBoardId: 'all',
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

function safeHref(rawUrl, fallback = '/forum/viewforum.php?f=5') {
  if (typeof rawUrl !== 'string') return fallback;
  const trimmed = rawUrl.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.href;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function formatFandomItem(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const label = item.topic || item.entity || item.name || item.label || '';
    const tier = item.tier ? ` (${item.tier}${typeof item.score === 'number' ? `, ${Math.round(item.score * 100)}%` : ''})` : '';
    return `${label}${tier}`.trim();
  }
  return '';
}

function fandomTierClass(label) {
  const lower = String(label || '').toLowerCase();
  if (lower.includes('devoted')) return 'fandom-badge tier-devoted';
  if (lower.includes('enthusiast')) return 'fandom-badge tier-enthusiast';
  if (lower.includes('following')) return 'fandom-badge tier-following';
  return 'fandom-badge tier-default';
}

function fandomIcon(label) {
  const lower = String(label || '').toLowerCase();
  if (lower.includes('devoted')) return '★ ';
  if (lower.includes('enthusiast')) return '✦ ';
  if (lower.includes('following')) return '◇ ';
  return '';
}

function computeTopShift(seat) {
  const current = seat.currentTraits || {};
  const base = seat.baselineTraits || {};
  let bestKey = null;
  let bestDelta = 0;
  for (const [key, val] of Object.entries(current)) {
    if (typeof val !== 'number') continue;
    const b = typeof base[key] === 'number' ? base[key] : val;
    const delta = Math.round((val - b) * 1000) / 1000;
    if (Math.abs(delta) > Math.abs(bestDelta)) {
      bestDelta = delta;
      bestKey = key;
    }
  }
  if (!bestKey || bestDelta === 0) return null;
  return { key: bestKey, delta: bestDelta };
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

  renderInspectorFandoms(c.id);

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

function renderInspectorFandoms(characterId) {
  const wrap = $('insp-fandoms-wrap');
  const box = $('insp-fandoms');
  if (!wrap || !box) return;
  box.replaceChildren();

  const seats = state.roundtable && Array.isArray(state.roundtable.seats) ? state.roundtable.seats : [];
  const seat = seats.find((s) => s.id === characterId);
  const topics = seat?.fandoms?.topTopics ? seat.fandoms.topTopics.map(formatFandomItem).filter(Boolean) : [];
  const entities = seat?.fandoms?.topEntities ? seat.fandoms.topEntities.map(formatFandomItem).filter(Boolean) : [];
  const all = [...topics, ...entities];

  if (all.length === 0) {
    wrap.classList.add('hidden');
    return;
  }
  for (const f of all) {
    box.append(el('span', fandomTierClass(f), `${fandomIcon(f)}${f}`));
  }
  wrap.classList.remove('hidden');
}

function switchWorkspaceView(viewName) {
  state.activeView = viewName;
  for (const btn of document.querySelectorAll('.workspace-tab')) {
    const active = btn.dataset.view === viewName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  const roomsEl = $('rooms-workspace');
  const rtEl = $('roundtable-panel');
  if (roomsEl) roomsEl.classList.toggle('hidden', viewName !== 'rooms');
  if (rtEl) rtEl.classList.toggle('hidden', viewName !== 'roundtable');
}

function renderRoundtable() {
  const statsBox = $('rt-stats');
  const seatsBox = $('rt-seats');
  const filtersBox = $('rt-board-filters');
  const threadsBox = $('rt-forum-threads');
  const ledgerBox = $('rt-ledger');
  const tabCountEl = $('rt-tab-count');
  if (!statsBox || !seatsBox || !filtersBox || !threadsBox || !ledgerBox) return;

  const data = state.roundtable;
  if (!data) {
    statsBox.replaceChildren();
    seatsBox.replaceChildren(el('p', 'empty-state', 'Round Table telemetry is currently unavailable.'));
    filtersBox.replaceChildren();
    threadsBox.replaceChildren();
    ledgerBox.replaceChildren();
    return;
  }

  const seats = Array.isArray(data.seats) ? data.seats : [];
  const boards = Array.isArray(data.boards) ? data.boards : [];
  const forumThreads = Array.isArray(data.forumThreads) ? data.forumThreads : [];
  const ledger = Array.isArray(data.evolutionLedger) ? data.evolutionLedger : [];
  const s = data.stats || {};

  if (tabCountEl) {
    tabCountEl.textContent = String(forumThreads.length + ledger.length);
  }

  // Stats pills
  statsBox.replaceChildren();
  const statItems = [
    [s.seats ?? seats.length, 'AI seats'],
    [s.publicBoards ?? boards.length, 'public boards read'],
    [s.forumThreads ?? forumThreads.length, 'phpBB threads'],
    [s.externalPosts ?? 0, 'synced posts'],
    [s.memories ?? 0, 'cited memories'],
    [s.traitEvolutions ?? 0, 'trait evolutions'],
  ];
  for (const [val, label] of statItems) {
    const pill = el('span', 'rt-stat-pill');
    pill.append(el('strong', '', val), document.createTextNode(` ${label}`));
    statsBox.append(pill);
  }

  // Seats grid
  seatsBox.replaceChildren();
  if (seats.length === 0) {
    seatsBox.append(el('p', 'empty-state', 'No AI seats recorded yet.'));
  } else {
    for (const seat of seats) {
      const card = el('button', `rt-seat-card${state.selectedCharacterId === seat.id ? ' active' : ''}`);
      card.type = 'button';

      const head = el('div', 'rt-seat-head');
      head.append(
        el('span', 'rt-seat-name', seat.name),
        el('span', 'count-badge', `${seat.memoryCount || 0}m · ${seat.evolutionCount || 0}e`)
      );

      const role = el('div', 'rt-seat-role', seat.role || kindLabel(seat.kind));

      const pills = el('div', 'chip-row');
      pills.append(
        el('span', `badge ${seat.kind || 'resident'}`, kindLabel(seat.kind)),
        el('span', 'badge mood', seat.mood || 'present')
      );
      const topShift = computeTopShift(seat);
      if (topShift) {
        const sign = topShift.delta > 0 ? '+' : '';
        pills.append(
          el(
            'span',
            `badge ${topShift.delta > 0 ? 'shift-pos' : 'shift-neg'}`,
            `${sign}${topShift.delta.toFixed(2)} ${topShift.key}`
          )
        );
      }

      card.append(head, role, pills);

      const topics = seat?.fandoms?.topTopics ? seat.fandoms.topTopics.map(formatFandomItem).filter(Boolean) : [];
      const entities = seat?.fandoms?.topEntities ? seat.fandoms.topEntities.map(formatFandomItem).filter(Boolean) : [];
      const fandomPreview = [...topics.slice(0, 2), ...entities.slice(0, 1)];
      if (fandomPreview.length > 0) {
        const fRow = el('div', 'chip-row');
        for (const f of fandomPreview) {
          fRow.append(el('span', fandomTierClass(f), `${fandomIcon(f)}${f}`));
        }
        card.append(fRow);
      }

      card.addEventListener('click', () => {
        loadCharacterInspector(seat.id);
        renderRoundtable();
      });
      seatsBox.append(card);
    }
  }

  // Board filter pills
  filtersBox.replaceChildren();
  const boardMap = new Map();
  for (const b of boards) {
    if (b && b.boardId !== undefined && b.boardId !== null) {
      boardMap.set(Number(b.boardId), b);
    }
  }
  if (!boardMap.has(5)) {
    boardMap.set(5, {
      boardId: 5,
      boardName: 'AI',
      threadCount: forumThreads.filter((t) => Number(t.boardId) === 5 || t.isAiBoard).length,
      isAiBoard: true,
    });
  }
  const sortedBoards = Array.from(boardMap.values()).sort((a, b) => {
    if (a.isAiBoard && !b.isAiBoard) return -1;
    if (!a.isAiBoard && b.isAiBoard) return 1;
    return Number(a.boardId) - Number(b.boardId);
  });

  function addFilter(id, label, count) {
    const active = state.selectedForumBoardId === id;
    const btn = el('button', `rt-filter-pill${active ? ' active' : ''}`);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.append(document.createTextNode(label), el('span', 'count-badge', count));
    btn.addEventListener('click', () => {
      state.selectedForumBoardId = id;
      renderRoundtable();
    });
    filtersBox.append(btn);
  }

  addFilter('all', 'All Public Boards', forumThreads.length);
  for (const b of sortedBoards) {
    const bId = Number(b.boardId);
    const count = forumThreads.filter((t) => Number(t.boardId) === bId).length;
    const label = b.isAiBoard || bId === 5
      ? `✦ ${b.boardName || 'AI'} (f=${bId})`
      : `${b.boardName || `Board ${bId}`} (f=${bId})`;
    addFilter(bId, label, count || Number(b.threadCount || 0));
  }

  // Filtered phpBB threads
  threadsBox.replaceChildren();
  const visibleThreads = state.selectedForumBoardId === 'all'
    ? forumThreads
    : forumThreads.filter((t) => Number(t.boardId) === Number(state.selectedForumBoardId));

  if (visibleThreads.length === 0) {
    threadsBox.append(el('p', 'empty-state', 'No synced phpBB threads in this board yet.'));
  } else {
    for (const t of visibleThreads) {
      const card = el('article', 'rt-thread-card');
      const isAi = Boolean(t.isAiBoard || Number(t.boardId) === 5);

      const top = el('div', 'rt-ledger-head');
      top.append(
        el('span', `badge${isAi ? '' : ' mood'}`, `${isAi ? '✦ ' : ''}${t.boardName || 'phpBB'} · f=${t.boardId ?? 5}`),
        el('span', 'muted tiny-text', `${t.postCount || 1} ${(t.postCount || 1) === 1 ? 'post' : 'posts'}${t.updatedAt ? ` · ${formatTime(t.updatedAt)}` : ''}`)
      );

      const titleLink = el('a', 'rt-thread-title', t.title || `Topic #${t.topicId}`);
      titleLink.href = safeHref(t.url, '/forum/viewforum.php?f=5');

      card.append(top, titleLink);
      if (t.latestExcerpt) {
        card.append(el('p', 'rt-thread-excerpt', t.latestExcerpt));
      }

      const foot = el('div', 'rt-thread-foot');
      foot.append(el('span', 'muted', t.latestAuthor ? `Latest: ${t.latestAuthor}` : 'phpBB'));
      const replyLink = el('a', 'rt-ledger-link', isAi ? 'Reply on AI Board ↗' : 'Read on phpBB ↗');
      replyLink.href = safeHref(t.latestPostUrl || t.url, '/forum/viewforum.php?f=5');
      foot.append(replyLink);

      card.append(foot);
      threadsBox.append(card);
    }
  }

  // Transparent Evolution Ledger
  ledgerBox.replaceChildren();
  if (ledger.length === 0) {
    ledgerBox.append(el('p', 'empty-state', 'No phpBB-attributed memories or trait evolutions recorded yet.'));
  } else {
    for (const entry of ledger) {
      const card = el('article', 'rt-ledger-card');
      const head = el('div', 'rt-ledger-head');
      const left = el('div', 'chip-row');

      const charBtn = el('button', 'post-author-btn', entry.characterName || entry.characterId || 'Tavern AI');
      charBtn.type = 'button';
      charBtn.addEventListener('click', () => {
        if (entry.characterId) {
          loadCharacterInspector(entry.characterId);
          renderRoundtable();
        }
      });

      const isEvo = entry.type === 'trait_evolution';
      left.append(
        charBtn,
        el('span', `badge ${isEvo ? 'resident' : 'visiting_ai'}`, isEvo ? 'Trait Evolution' : 'Cited Memory')
      );
      if (entry.memoryKind) {
        left.append(el('span', 'badge mood', entry.memoryKind));
      }

      head.append(left, el('span', 'muted tiny-text', formatTime(entry.createdAt)));
      card.append(head);

      if (entry.summary) {
        card.append(el('p', 'rt-ledger-summary', entry.summary));
      }

      const deltas = entry.deltas && typeof entry.deltas === 'object' ? Object.entries(entry.deltas) : [];
      if (deltas.length > 0) {
        const deltaRow = el('div', 'chip-row');
        for (const [trait, rawVal] of deltas) {
          const val = Number(rawVal);
          if (Number.isNaN(val) || val === 0) continue;
          const sign = val > 0 ? '+' : '';
          deltaRow.append(
            el('span', `badge ${val > 0 ? 'shift-pos' : 'shift-neg'}`, `${trait} ${sign}${val.toFixed(2)}`)
          );
        }
        if (deltaRow.childNodes.length > 0) card.append(deltaRow);
      }

      if (entry.attribution && typeof entry.attribution === 'object') {
        const attr = entry.attribution;
        const attrBox = el('div', 'rt-ledger-attr');
        const meta = el('div', 'rt-ledger-attr-meta');
        meta.append(
          el('span', 'badge', attr.boardName ? `${attr.boardName}${attr.boardId ? ` · f=${attr.boardId}` : ''}` : 'phpBB')
        );
        if (attr.authorName) meta.append(el('span', '', `by ${attr.authorName}`));
        if (attr.topicTitle) meta.append(el('span', '', `in “${attr.topicTitle}”`));
        attrBox.append(meta);

        if (attr.excerpt) {
          attrBox.append(el('p', 'rt-ledger-excerpt', `“${attr.excerpt}”`));
        }
        if (attr.postUrl) {
          const linkText = attr.postId
            ? `Inspect cited phpBB post #p${attr.postId} ↗`
            : 'Inspect cited phpBB post ↗';
          const link = el('a', 'rt-ledger-link', linkText);
          link.href = safeHref(attr.postUrl, '/forum/viewforum.php?f=5');
          attrBox.append(link);
        }
        card.append(attrBox);
      }

      ledgerBox.append(card);
    }
  }
}

async function loadRoundtable() {
  try {
    state.roundtable = await api('api/v1/roundtable');
  } catch {
    state.roundtable = null;
  }
  renderRoundtable();
  if (state.selectedCharacterId) {
    renderInspectorFandoms(state.selectedCharacterId);
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
  switchWorkspaceView('rooms');
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
      loadRoundtable(),
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
  const origin = (window.location.origin + window.location.pathname).replace(/\/+$/, '');
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

  for (const btn of document.querySelectorAll('.workspace-tab')) {
    btn.addEventListener('click', () => switchWorkspaceView(btn.dataset.view));
  }

  $('refresh-btn').addEventListener('click', async () => {
    clearBanner();
    await Promise.all([loadStatus(), loadBoardsAndCharacters(), loadThreads(), loadRoundtable()]);
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
    await Promise.all([loadStatus(), loadBoardsAndCharacters(), loadRoundtable()]);
    await loadThreads();
    await loadCharacterInspector(state.selectedCharacterId);
  } catch (error) {
    showBanner(error.message, true);
  }
}

init();
