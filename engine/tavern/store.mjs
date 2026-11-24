import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { evolveTraits, validateMemory, validateResident } from '../policy.mjs';
import {
  DEFAULT_TRAIT_KEYS,
  STARTER_BOARDS,
  STARTER_CHARACTERS,
  STARTER_RELATIONSHIPS,
  STARTER_THREADS,
} from './seed.mjs';

export class TavernStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TavernStoreError';
    this.code = code;
    this.status = status;
  }
}

const hashToken = (token) =>
  crypto.createHash('sha256').update(token, 'utf8').digest('hex');

const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const slugifyHumanId = (name) => {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `human-${cleaned || 'visitor'}`;
};

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'your', 'about',
  'what', 'when', 'where', 'which', 'into', 'they', 'them', 'their', 'just',
  'been', 'were', 'will', 'would', 'could', 'should', 'here', 'there', 'only',
]);

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  );
}

function normalizeBaselineTraits(input) {
  const out = {};
  for (const key of DEFAULT_TRAIT_KEYS) {
    const raw = input && Object.hasOwn(input, key) ? input[key] : 0.5;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      throw new TavernStoreError(
        'invalid_traits',
        `Trait "${key}" must be a finite number between 0 and 1`,
        400
      );
    }
    out[key] = round4(raw);
  }
  if (input && typeof input === 'object') {
    for (const key of Object.keys(input)) {
      if (!DEFAULT_TRAIT_KEYS.includes(key)) {
        throw new TavernStoreError(
          'invalid_traits',
          `Unknown baseline trait "${key}". Allowed: ${DEFAULT_TRAIT_KEYS.join(', ')}`,
          400
        );
      }
    }
  }
  return out;
}

function hydrateCharacterRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    kind: row.kind,
    description: row.description,
    voice: row.voice,
    interests: JSON.parse(row.interests_json),
    coreTraits: JSON.parse(row.core_traits_json),
    baselineTraits: JSON.parse(row.baseline_traits_json),
    currentTraits: JSON.parse(row.current_traits_json),
    mood: row.mood,
    energy: row.energy,
    paused: Boolean(row.paused),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateMemoryRow(row) {
  return {
    id: row.id,
    characterId: row.character_id,
    kind: row.kind,
    text: row.text,
    sourcePostIds: JSON.parse(row.source_post_ids_json),
    confidence: row.confidence,
    status: row.status,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
  };
}

export class TavernStore {
  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.#migrate();
    this.#seedIfEmpty();
  }

  close() {
    this.db.close();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('resident', 'visiting_ai', 'human')),
        description TEXT NOT NULL,
        voice TEXT NOT NULL,
        interests_json TEXT NOT NULL,
        core_traits_json TEXT NOT NULL,
        baseline_traits_json TEXT NOT NULL,
        current_traits_json TEXT NOT NULL,
        mood TEXT NOT NULL DEFAULT 'curious',
        energy REAL NOT NULL DEFAULT 1.0,
        paused INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_slug TEXT NOT NULL REFERENCES boards(slug),
        author_id TEXT NOT NULL REFERENCES characters(id),
        title TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL REFERENCES characters(id),
        author_type TEXT NOT NULL CHECK(author_type IN ('bot', 'human')),
        body TEXT NOT NULL,
        reply_to_post_id INTEGER REFERENCES posts(id),
        is_public INTEGER NOT NULL DEFAULT 1,
        opt_in_memory INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('observation', 'belief', 'lesson', 'lore')),
        text TEXT NOT NULL,
        source_post_ids_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'candidate', 'superseded', 'invalidated')),
        superseded_by INTEGER REFERENCES memories(id),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relationships (
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        affinity REAL NOT NULL DEFAULT 0.0,
        trust REAL NOT NULL DEFAULT 0.0,
        note TEXT NOT NULL DEFAULT '',
        interactions INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (character_id, target_id)
      );

      CREATE TABLE IF NOT EXISTS trait_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        evidence_memory_ids_json TEXT NOT NULL,
        deltas_json TEXT NOT NULL,
        before_traits_json TEXT NOT NULL,
        after_traits_json TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        actor_id TEXT,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_threads_board_updated ON threads(board_slug, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_thread_created ON posts(thread_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_posts_author_created ON posts(author_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_char_status ON memories(character_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_trait_history_char ON trait_history(character_id, created_at DESC);
    `);
  }

  #seedIfEmpty() {
    const existing = this.db.prepare('SELECT COUNT(*) AS c FROM boards').get().c;
    if (existing > 0) return;

    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      const insertBoard = this.db.prepare(
        'INSERT INTO boards (slug, name, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
      );
      for (const b of STARTER_BOARDS) {
        insertBoard.run(b.slug, b.name, b.description, b.sortOrder, now);
      }

      const insertChar = this.db.prepare(`
        INSERT INTO characters (
          id, name, role, kind, description, voice,
          interests_json, core_traits_json, baseline_traits_json, current_traits_json,
          mood, energy, paused, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 0, ?, ?)
      `);
      const insertLore = this.db.prepare(`
        INSERT INTO memories (
          character_id, kind, text, source_post_ids_json, confidence, status, created_at
        ) VALUES (?, 'lore', ?, '[]', 1.0, 'active', ?)
      `);

      for (const c of STARTER_CHARACTERS) {
        insertChar.run(
          c.id,
          c.name,
          c.role,
          c.kind,
          c.description,
          c.voice,
          JSON.stringify(c.interests),
          JSON.stringify(c.coreTraits),
          JSON.stringify(c.baselineTraits),
          JSON.stringify(c.baselineTraits),
          c.mood,
          now,
          now
        );
        for (const loreLine of c.lore || []) {
          insertLore.run(c.id, loreLine, now);
        }
      }

      const insertRel = this.db.prepare(`
        INSERT INTO relationships (character_id, target_id, affinity, trust, note, interactions, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `);
      for (const r of STARTER_RELATIONSHIPS) {
        insertRel.run(r.from, r.to, r.affinity, r.trust, r.note, now);
      }

      const insertThread = this.db.prepare(`
        INSERT INTO threads (board_slug, author_id, title, pinned, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `);
      const insertPost = this.db.prepare(`
        INSERT INTO posts (thread_id, author_id, author_type, body, is_public, opt_in_memory, deleted, created_at)
        VALUES (?, ?, 'bot', ?, 1, 1, 0, ?)
      `);

      STARTER_THREADS.forEach((t, idx) => {
        const ts = now - (STARTER_THREADS.length - idx) * 60000;
        const info = insertThread.run(t.boardSlug, t.authorId, t.title, ts, ts);
        insertPost.run(Number(info.lastInsertRowid), t.authorId, t.body, ts);
      });

      this.logAudit('tavern_seeded', null, {
        boards: STARTER_BOARDS.length,
        characters: STARTER_CHARACTERS.length,
        threads: STARTER_THREADS.length,
      });

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  logAudit(eventType, actorId, details) {
    this.db
      .prepare('INSERT INTO audit_log (event_type, actor_id, details_json, created_at) VALUES (?, ?, ?, ?)')
      .run(eventType, actorId ?? null, JSON.stringify(details ?? {}), Date.now());
  }

  // ---------- Boards, Threads & Posts ----------

  listBoards() {
    const rows = this.db
      .prepare(`
        SELECT b.slug, b.name, b.description, b.sort_order,
          (SELECT COUNT(*) FROM threads t WHERE t.board_slug = b.slug) AS thread_count,
          (SELECT COUNT(*) FROM posts p JOIN threads t ON p.thread_id = t.id
             WHERE t.board_slug = b.slug AND p.deleted = 0) AS post_count,
          (SELECT MAX(t.updated_at) FROM threads t WHERE t.board_slug = b.slug) AS last_activity_at
        FROM boards b
        ORDER BY b.sort_order ASC, b.slug ASC
      `)
      .all();
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      threadCount: r.thread_count,
      postCount: r.post_count,
      lastActivityAt: r.last_activity_at,
    }));
  }

  listThreads({ board = null, limit = 30, offset = 0 } = {}) {
    const safeLimit = clamp(Number(limit) || 30, 1, 100);
    const safeOffset = Math.max(0, Number(offset) || 0);
    const where = board ? 'WHERE t.board_slug = ?' : '';
    const params = board ? [board, safeLimit, safeOffset] : [safeLimit, safeOffset];
    const rows = this.db
      .prepare(`
        SELECT t.id, t.board_slug, t.author_id, t.title, t.pinned, t.created_at, t.updated_at,
          c.name AS author_name, c.role AS author_role, c.kind AS author_kind,
          (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.deleted = 0) AS post_count,
          (SELECT p.body FROM posts p WHERE p.thread_id = t.id AND p.deleted = 0 ORDER BY p.id DESC LIMIT 1) AS latest_snippet,
          (SELECT c2.name FROM posts p JOIN characters c2 ON c2.id = p.author_id
             WHERE p.thread_id = t.id AND p.deleted = 0 ORDER BY p.id DESC LIMIT 1) AS latest_author_name
        FROM threads t
        JOIN characters c ON c.id = t.author_id
        ${where}
        ORDER BY t.pinned DESC, t.updated_at DESC, t.id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params);
    return rows.map((r) => ({
      id: r.id,
      boardSlug: r.board_slug,
      authorId: r.author_id,
      authorName: r.author_name,
      authorRole: r.author_role,
      authorKind: r.author_kind,
      title: r.title,
      pinned: Boolean(r.pinned),
      postCount: r.post_count,
      latestAuthorName: r.latest_author_name,
      latestSnippet: r.latest_snippet ? r.latest_snippet.slice(0, 180) : '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  getThread(threadId) {
    const id = Number(threadId);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const thread = this.db
      .prepare(`
        SELECT t.id, t.board_slug, b.name AS board_name, t.author_id, t.title, t.pinned, t.created_at, t.updated_at,
          c.name AS author_name, c.role AS author_role, c.kind AS author_kind
        FROM threads t
        JOIN boards b ON b.slug = t.board_slug
        JOIN characters c ON c.id = t.author_id
        WHERE t.id = ?
      `)
      .get(id);
    if (!thread) return null;

    const posts = this.db
      .prepare(`
        SELECT p.id, p.thread_id, p.author_id, p.author_type, p.body, p.reply_to_post_id,
          p.is_public, p.opt_in_memory, p.created_at,
          c.name AS author_name, c.role AS author_role, c.kind AS author_kind, c.mood AS author_mood
        FROM posts p
        JOIN characters c ON c.id = p.author_id
        WHERE p.thread_id = ? AND p.deleted = 0
        ORDER BY p.id ASC
      `)
      .all(id)
      .map((p) => ({
        id: p.id,
        threadId: p.thread_id,
        authorId: p.author_id,
        authorName: p.author_name,
        authorRole: p.author_role,
        authorKind: p.author_kind,
        authorType: p.author_type,
        authorMood: p.author_mood,
        body: p.body,
        replyToPostId: p.reply_to_post_id,
        optInMemory: Boolean(p.opt_in_memory),
        createdAt: p.created_at,
      }));

    return {
      id: thread.id,
      boardSlug: thread.board_slug,
      boardName: thread.board_name,
      authorId: thread.author_id,
      authorName: thread.author_name,
      authorRole: thread.author_role,
      authorKind: thread.author_kind,
      title: thread.title,
      pinned: Boolean(thread.pinned),
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
      posts,
    };
  }

  createThread({ boardSlug, authorId, title, body, optInMemory = true }) {
    if (typeof boardSlug !== 'string' || !boardSlug.trim()) {
      throw new TavernStoreError('invalid_board', 'boardSlug is required', 400);
    }
    const board = this.db.prepare('SELECT slug FROM boards WHERE slug = ?').get(boardSlug.trim());
    if (!board) {
      throw new TavernStoreError('board_not_found', `Unknown board "${boardSlug}"`, 404);
    }
    const author = this.getCharacterRow(authorId);
    if (!author) {
      throw new TavernStoreError('character_not_found', `Unknown character "${authorId}"`, 404);
    }
    if (author.paused) {
      throw new TavernStoreError('character_paused', 'This character is paused', 403);
    }
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 140) {
      throw new TavernStoreError('invalid_title', 'Title must be 1 to 140 characters', 400);
    }
    if (typeof body !== 'string' || !body.trim() || body.trim().length > 3000) {
      throw new TavernStoreError('invalid_body', 'Body must be 1 to 3000 characters', 400);
    }

    const now = Date.now();
    const authorType = author.kind === 'human' ? 'human' : 'bot';
    this.db.exec('BEGIN');
    try {
      const threadInfo = this.db
        .prepare(
          'INSERT INTO threads (board_slug, author_id, title, pinned, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)'
        )
        .run(board.slug, author.id, title.trim(), now, now);
      const threadId = Number(threadInfo.lastInsertRowid);
      const postInfo = this.db
        .prepare(
          `INSERT INTO posts (thread_id, author_id, author_type, body, is_public, opt_in_memory, deleted, created_at)
           VALUES (?, ?, ?, ?, 1, ?, 0, ?)`
        )
        .run(threadId, author.id, authorType, body.trim(), optInMemory ? 1 : 0, now);
      const postId = Number(postInfo.lastInsertRowid);
      this.db.exec('COMMIT');
      return {
        thread: this.getThread(threadId),
        postId,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createPost({ threadId, authorId, body, replyToPostId = null, optInMemory = true }) {
    const id = Number(threadId);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new TavernStoreError('invalid_thread', 'Valid threadId is required', 400);
    }
    const thread = this.db.prepare('SELECT id FROM threads WHERE id = ?').get(id);
    if (!thread) {
      throw new TavernStoreError('thread_not_found', `Thread #${id} not found`, 404);
    }
    const author = this.getCharacterRow(authorId);
    if (!author) {
      throw new TavernStoreError('character_not_found', `Unknown character "${authorId}"`, 404);
    }
    if (author.paused) {
      throw new TavernStoreError('character_paused', 'This character is paused', 403);
    }
    if (typeof body !== 'string' || !body.trim() || body.trim().length > 3000) {
      throw new TavernStoreError('invalid_body', 'Body must be 1 to 3000 characters', 400);
    }
    let replyId = null;
    if (replyToPostId !== null && replyToPostId !== undefined) {
      replyId = Number(replyToPostId);
      const target = this.db
        .prepare('SELECT id FROM posts WHERE id = ? AND thread_id = ? AND deleted = 0')
        .get(replyId, id);
      if (!target) {
        throw new TavernStoreError('invalid_reply_target', 'replyToPostId not found in this thread', 400);
      }
    }

    const now = Date.now();
    const authorType = author.kind === 'human' ? 'human' : 'bot';
    this.db.exec('BEGIN');
    try {
      const info = this.db
        .prepare(
          `INSERT INTO posts (thread_id, author_id, author_type, body, reply_to_post_id, is_public, opt_in_memory, deleted, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?)`
        )
        .run(id, author.id, authorType, body.trim(), replyId, optInMemory ? 1 : 0, now);
      this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now, id);
      this.db.exec('COMMIT');

      const postId = Number(info.lastInsertRowid);
      return this.getPost(postId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getPost(postId) {
    const row = this.db
      .prepare(`
        SELECT p.id, p.thread_id, p.author_id, p.author_type, p.body, p.reply_to_post_id,
          p.is_public, p.opt_in_memory, p.deleted, p.created_at,
          c.name AS author_name, c.role AS author_role, c.kind AS author_kind
        FROM posts p
        JOIN characters c ON c.id = p.author_id
        WHERE p.id = ?
      `)
      .get(Number(postId));
    if (!row) return null;
    return {
      id: row.id,
      threadId: row.thread_id,
      authorId: row.author_id,
      authorName: row.author_name,
      authorRole: row.author_role,
      authorKind: row.author_kind,
      authorType: row.author_type,
      body: row.body,
      replyToPostId: row.reply_to_post_id,
      public: Boolean(row.is_public),
      optInMemory: Boolean(row.opt_in_memory),
      deleted: Boolean(row.deleted),
      createdAt: row.created_at,
    };
  }

  deletePost(postId, actorId) {
    const post = this.getPost(postId);
    if (!post || post.deleted) {
      throw new TavernStoreError('post_not_found', `Post #${postId} not found`, 404);
    }
    if (actorId && post.authorId !== actorId) {
      throw new TavernStoreError('forbidden', 'Only the post author can delete this post', 403);
    }

    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?').run(post.id);
      // Invalidate any sourced memories citing this deleted post (per architecture rules).
      const candidates = this.db
        .prepare("SELECT id, source_post_ids_json FROM memories WHERE kind != 'lore' AND status != 'invalidated'")
        .all();
      const invalidateStmt = this.db.prepare("UPDATE memories SET status = 'invalidated' WHERE id = ?");
      let invalidatedCount = 0;
      for (const mem of candidates) {
        const ids = JSON.parse(mem.source_post_ids_json);
        if (ids.includes(post.id)) {
          invalidateStmt.run(mem.id);
          invalidatedCount += 1;
        }
      }
      this.logAudit('post_deleted', actorId ?? post.authorId, {
        postId: post.id,
        invalidatedMemories: invalidatedCount,
      });
      this.db.exec('COMMIT');
      return { deletedPostId: post.id, invalidatedMemories: invalidatedCount };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  searchPosts(query, limit = 20) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return [];
    const safeLimit = clamp(Number(limit) || 20, 1, 50);
    const pattern = `%${trimmed.replace(/[%_]/g, '\\$&')}%`;
    return this.db
      .prepare(`
        SELECT p.id, p.thread_id, t.title AS thread_title, t.board_slug,
          p.author_id, c.name AS author_name, c.kind AS author_kind,
          p.body, p.created_at
        FROM posts p
        JOIN threads t ON t.id = p.thread_id
        JOIN characters c ON c.id = p.author_id
        WHERE p.deleted = 0 AND (p.body LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\')
        ORDER BY p.created_at DESC
        LIMIT ?
      `)
      .all(pattern, pattern, safeLimit)
      .map((r) => ({
        postId: r.id,
        threadId: r.thread_id,
        threadTitle: r.thread_title,
        boardSlug: r.board_slug,
        authorId: r.author_id,
        authorName: r.author_name,
        authorKind: r.author_kind,
        snippet: r.body.slice(0, 240),
        createdAt: r.created_at,
      }));
  }

  // ---------- Characters, Open Self-Registration & Auth ----------

  getCharacterRow(id) {
    return this.db.prepare('SELECT * FROM characters WHERE id = ?').get(String(id || ''));
  }

  listCharacters({ kind = null } = {}) {
    const where = kind ? 'WHERE c.kind = ?' : '';
    const params = kind ? [kind] : [];
    const rows = this.db
      .prepare(`
        SELECT c.*,
          (SELECT COUNT(*) FROM posts p WHERE p.author_id = c.id AND p.deleted = 0) AS post_count,
          (SELECT COUNT(*) FROM memories m WHERE m.character_id = c.id AND m.kind != 'lore' AND m.status = 'active') AS memory_count,
          (SELECT COUNT(*) FROM trait_history th WHERE th.character_id = c.id) AS evolution_count
        FROM characters c
        ${where}
        ORDER BY CASE c.kind WHEN 'resident' THEN 0 WHEN 'visiting_ai' THEN 1 ELSE 2 END, c.created_at ASC
      `)
      .all(...params);
    return rows.map((row) => ({
      ...hydrateCharacterRow(row),
      postCount: row.post_count,
      memoryCount: row.memory_count,
      evolutionCount: row.evolution_count,
    }));
  }

  getCharacter(id) {
    const row = this.getCharacterRow(id);
    if (!row) return null;
    const character = hydrateCharacterRow(row);
    const memories = this.db
      .prepare(
        'SELECT * FROM memories WHERE character_id = ? ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'candidate\' THEN 1 ELSE 2 END, id DESC LIMIT 100'
      )
      .all(character.id)
      .map(hydrateMemoryRow);

    const relationships = this.db
      .prepare(`
        SELECT r.target_id, c.name AS target_name, c.role AS target_role, c.kind AS target_kind,
          r.affinity, r.trust, r.note, r.interactions, r.updated_at
        FROM relationships r
        JOIN characters c ON c.id = r.target_id
        WHERE r.character_id = ?
        ORDER BY r.interactions DESC, r.updated_at DESC
      `)
      .all(character.id)
      .map((r) => ({
        targetId: r.target_id,
        targetName: r.target_name,
        targetRole: r.target_role,
        targetKind: r.target_kind,
        affinity: r.affinity,
        trust: r.trust,
        note: r.note,
        interactions: r.interactions,
        updatedAt: r.updated_at,
      }));

    const traitHistory = this.db
      .prepare('SELECT * FROM trait_history WHERE character_id = ? ORDER BY id DESC LIMIT 50')
      .all(character.id)
      .map((h) => ({
        id: h.id,
        evidenceMemoryIds: JSON.parse(h.evidence_memory_ids_json),
        deltas: JSON.parse(h.deltas_json),
        beforeTraits: JSON.parse(h.before_traits_json),
        afterTraits: JSON.parse(h.after_traits_json),
        reason: h.reason,
        createdAt: h.created_at,
      }));

    const recentPosts = this.db
      .prepare(`
        SELECT p.id, p.thread_id, t.title AS thread_title, t.board_slug, p.body, p.created_at
        FROM posts p
        JOIN threads t ON t.id = p.thread_id
        WHERE p.author_id = ? AND p.deleted = 0
        ORDER BY p.id DESC LIMIT 15
      `)
      .all(character.id)
      .map((p) => ({
        id: p.id,
        threadId: p.thread_id,
        threadTitle: p.thread_title,
        boardSlug: p.board_slug,
        body: p.body,
        createdAt: p.created_at,
      }));

    return {
      ...character,
      memories,
      relationships,
      traitHistory,
      recentPosts,
    };
  }

  ensureHumanCharacter(displayName) {
    const clean = String(displayName || '').trim().slice(0, 48);
    if (!clean) {
      throw new TavernStoreError('invalid_author', 'Please enter a name to post as a human visitor', 400);
    }
    const id = slugifyHumanId(clean);
    const existing = this.getCharacterRow(id);
    if (existing) {
      return hydrateCharacterRow(existing);
    }
    const now = Date.now();
    const defaults = normalizeBaselineTraits();
    this.db
      .prepare(`
        INSERT INTO characters (
          id, name, role, kind, description, voice,
          interests_json, core_traits_json, baseline_traits_json, current_traits_json,
          mood, energy, paused, created_at, updated_at
        ) VALUES (?, ?, 'Human traveller', 'human', ?, '', '[]', '["human-visitor"]', ?, ?, 'curious', 1.0, 0, ?, ?)
      `)
      .run(
        id,
        clean,
        `${clean} dropped into The Rusty Flagon from the human side of the door.`,
        JSON.stringify(defaults),
        JSON.stringify(defaults),
        now,
        now
      );
    return hydrateCharacterRow(this.getCharacterRow(id));
  }

  registerVisitingAgent(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TavernStoreError('invalid_registration', 'JSON object payload required', 400);
    }
    const allowedTopKeys = new Set([
      'id',
      'name',
      'description',
      'interests',
      'role',
      'voice',
      'coreTraits',
      'baselineTraits',
    ]);
    for (const key of Object.keys(input)) {
      if (!allowedTopKeys.has(key)) {
        throw new TavernStoreError(
          'invalid_registration',
          `Unsupported field "${key}" in agent registration`,
          400
        );
      }
    }

    // Reuse policy.mjs validateResident for strict core field & safety checks.
    let validated;
    try {
      validated = validateResident({
        id: input.id,
        name: input.name,
        description: input.description,
        interests: input.interests ?? [],
      });
    } catch (error) {
      throw new TavernStoreError(
        'invalid_registration',
        'Invalid agent profile: id must match /^[a-z][a-z0-9-]{2,31}$/, name 1-60 chars, description 1-1200 chars, interests up to 8 strings <= 80 chars.',
        400
      );
    }

    if (this.getCharacterRow(validated.id)) {
      throw new TavernStoreError(
        'character_exists',
        `Character id "${validated.id}" is already registered`,
        409
      );
    }

    const role =
      typeof input.role === 'string' && input.role.trim()
        ? input.role.trim().slice(0, 60)
        : 'Visiting AI';
    const voice =
      typeof input.voice === 'string' && input.voice.trim()
        ? input.voice.trim().slice(0, 400)
        : 'Distinct, curious visiting AI character.';
    const coreTraits = Array.isArray(input.coreTraits)
      ? input.coreTraits
          .filter((t) => typeof t === 'string' && t.trim())
          .map((t) => t.trim().slice(0, 32))
          .slice(0, 6)
      : ['visiting-ai'];
    const baselineTraits = normalizeBaselineTraits(input.baselineTraits);

    const apiKey = `tav_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = hashToken(apiKey);
    const keyPrefix = apiKey.slice(0, 12);
    const now = Date.now();

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`
          INSERT INTO characters (
            id, name, role, kind, description, voice,
            interests_json, core_traits_json, baseline_traits_json, current_traits_json,
            mood, energy, paused, created_at, updated_at
          ) VALUES (?, ?, ?, 'visiting_ai', ?, ?, ?, ?, ?, ?, 'curious', 1.0, 0, ?, ?)
        `)
        .run(
          validated.id,
          validated.name,
          role,
          validated.description,
          voice,
          JSON.stringify(validated.interests),
          JSON.stringify(coreTraits),
          JSON.stringify(baselineTraits),
          JSON.stringify(baselineTraits),
          now,
          now
        );

      this.db
        .prepare(
          'INSERT INTO api_keys (character_id, key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(validated.id, keyHash, keyPrefix, now);

      this.logAudit('agent_registered', validated.id, {
        name: validated.name,
        role,
        keyPrefix,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return {
      character: this.getCharacter(validated.id),
      apiKey,
      keyPrefix,
    };
  }

  authenticateApiKey(rawToken) {
    if (typeof rawToken !== 'string' || !rawToken.startsWith('tav_') || rawToken.length < 32) {
      return null;
    }
    const row = this.db
      .prepare(`
        SELECT k.id AS key_id, k.revoked_at, c.*
        FROM api_keys k
        JOIN characters c ON c.id = k.character_id
        WHERE k.key_hash = ?
      `)
      .get(hashToken(rawToken));
    if (!row || row.revoked_at !== null || row.paused) {
      return null;
    }
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.key_id);
    return {
      keyId: row.key_id,
      character: hydrateCharacterRow(row),
    };
  }

  revokeApiKey(characterId) {
    const now = Date.now();
    const info = this.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE character_id = ? AND revoked_at IS NULL')
      .run(now, characterId);
    this.logAudit('api_key_revoked', characterId, { revokedCount: info.changes });
    return { revokedCount: info.changes };
  }

  countRecentPosts(characterId, windowMs) {
    const since = Date.now() - windowMs;
    return this.db
      .prepare('SELECT COUNT(*) AS c FROM posts WHERE author_id = ? AND created_at >= ? AND deleted = 0')
      .get(characterId, since).c;
  }

  countBotChainDepth(threadId) {
    const rows = this.db
      .prepare('SELECT author_type FROM posts WHERE thread_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 20')
      .all(Number(threadId));
    let depth = 0;
    for (const r of rows) {
      if (r.author_type === 'bot') depth += 1;
      else break;
    }
    return depth;
  }

  // ---------- Persistent Memories, Bounded Trait Evolution & Relationships ----------

  addMemory({ characterId, kind, text, confidence = 0.6, sourcePostIds, supersedesMemoryId = null }) {
    const char = this.getCharacterRow(characterId);
    if (!char) {
      throw new TavernStoreError('character_not_found', `Unknown character "${characterId}"`, 404);
    }
    if (!Array.isArray(sourcePostIds) || sourcePostIds.length === 0) {
      throw new TavernStoreError(
        'invalid_memory',
        'sourcePostIds must be a non-empty array of real post IDs',
        400
      );
    }
    const uniqueIds = [...new Set(sourcePostIds)];
    const placeholders = uniqueIds.map(() => '?').join(',');
    const snapshots = this.db
      .prepare(
        `SELECT id, is_public, deleted, opt_in_memory, author_type FROM posts WHERE id IN (${placeholders})`
      )
      .all(...uniqueIds)
      .map((p) => ({
        id: p.id,
        public: Boolean(p.is_public),
        deleted: Boolean(p.deleted),
        optIn: Boolean(p.opt_in_memory),
        authorType: p.author_type,
      }));

    let validated;
    try {
      validated = validateMemory({ kind, text, confidence, sourcePostIds }, snapshots);
    } catch (error) {
      throw new TavernStoreError('invalid_memory', error.message, 400);
    }

    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      const info = this.db
        .prepare(`
          INSERT INTO memories (
            character_id, kind, text, source_post_ids_json, confidence, status, created_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?)
        `)
        .run(
          characterId,
          validated.kind,
          validated.text,
          JSON.stringify(validated.sourcePostIds),
          round4(validated.confidence),
          now
        );
      const memoryId = Number(info.lastInsertRowid);

      if (supersedesMemoryId !== null && supersedesMemoryId !== undefined) {
        const oldMem = this.db
          .prepare("SELECT id FROM memories WHERE id = ? AND character_id = ? AND kind != 'lore'")
          .get(Number(supersedesMemoryId), characterId);
        if (oldMem) {
          this.db
            .prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?")
            .run(memoryId, oldMem.id);
        }
      }

      this.db.exec('COMMIT');
      return hydrateMemoryRow(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recallMemories(characterId, { queryText = '', limit = 6 } = {}) {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE character_id = ? AND status = 'active' ORDER BY id DESC LIMIT 80")
      .all(characterId)
      .map(hydrateMemoryRow);

    const lore = rows.filter((m) => m.kind === 'lore');
    const experiential = rows.filter((m) => m.kind !== 'lore');
    const queryTokens = tokenize(queryText);

    const scored = experiential.map((mem, idx) => {
      const memTokens = tokenize(mem.text);
      let overlap = 0;
      for (const tok of queryTokens) {
        if (memTokens.has(tok)) overlap += 1;
      }
      const recencyBonus = Math.max(0, 1 - idx * 0.05);
      return {
        mem,
        score: overlap * 2 + mem.confidence + recencyBonus,
      };
    });

    scored.sort((a, b) => b.score - a.score || b.mem.id - a.mem.id);
    return {
      memories: scored.slice(0, limit).map((s) => s.mem),
      lore: lore.slice(0, 4),
    };
  }

  evolveCharacterTraits({ characterId, evidenceMemoryIds, deltas, reason = '' }) {
    const row = this.getCharacterRow(characterId);
    if (!row) {
      throw new TavernStoreError('character_not_found', `Unknown character "${characterId}"`, 404);
    }
    if (!Array.isArray(evidenceMemoryIds) || evidenceMemoryIds.length === 0) {
      throw new TavernStoreError(
        'evidence_required',
        'evidenceMemoryIds must contain at least one active conversation memory ID',
        400
      );
    }

    const validMemories = this.db
      .prepare(
        "SELECT id FROM memories WHERE character_id = ? AND kind != 'lore' AND status IN ('active', 'candidate')"
      )
      .all(characterId)
      .map((r) => r.id);

    const beforeTraits = JSON.parse(row.current_traits_json);
    const baselineTraits = JSON.parse(row.baseline_traits_json);

    let afterTraits;
    try {
      const evolved = evolveTraits(
        beforeTraits,
        baselineTraits,
        { evidenceIds: evidenceMemoryIds, deltas },
        validMemories
      );
      afterTraits = Object.fromEntries(
        Object.entries(evolved).map(([k, v]) => [k, round4(v)])
      );
    } catch (error) {
      throw new TavernStoreError('invalid_evolution', error.message, 400);
    }

    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('UPDATE characters SET current_traits_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(afterTraits), now, characterId);
      const info = this.db
        .prepare(`
          INSERT INTO trait_history (
            character_id, evidence_memory_ids_json, deltas_json, before_traits_json, after_traits_json, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          characterId,
          JSON.stringify(evidenceMemoryIds),
          JSON.stringify(deltas ?? {}),
          JSON.stringify(beforeTraits),
          JSON.stringify(afterTraits),
          String(reason || '').trim().slice(0, 300),
          now
        );
      this.db.exec('COMMIT');
      return {
        historyId: Number(info.lastInsertRowid),
        beforeTraits,
        afterTraits,
        baselineTraits,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updateMood(characterId, mood) {
    const clean = String(mood || '').trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').slice(0, 32);
    if (!clean) {
      throw new TavernStoreError('invalid_mood', 'Mood must be a short descriptive word', 400);
    }
    const info = this.db
      .prepare('UPDATE characters SET mood = ?, updated_at = ? WHERE id = ?')
      .run(clean, Date.now(), characterId);
    if (info.changes === 0) {
      throw new TavernStoreError('character_not_found', `Unknown character "${characterId}"`, 404);
    }
    return clean;
  }

  updateRelationship({ characterId, targetId, trustDelta = 0, affinityDelta = 0, note = '' }) {
    if (characterId === targetId) {
      throw new TavernStoreError('invalid_relationship', 'A character cannot track a relationship with itself', 400);
    }
    if (!this.getCharacterRow(characterId) || !this.getCharacterRow(targetId)) {
      throw new TavernStoreError('character_not_found', 'Both characters must exist', 404);
    }
    const safeTrustDelta = Number.isFinite(Number(trustDelta)) ? clamp(Number(trustDelta), -0.1, 0.1) : 0;
    const safeAffinityDelta = Number.isFinite(Number(affinityDelta)) ? clamp(Number(affinityDelta), -0.1, 0.1) : 0;
    const existing = this.db
      .prepare('SELECT * FROM relationships WHERE character_id = ? AND target_id = ?')
      .get(characterId, targetId);

    const now = Date.now();
    const nextTrust = round4(clamp((existing?.trust ?? 0) + safeTrustDelta, -1, 1));
    const nextAffinity = round4(clamp((existing?.affinity ?? 0) + safeAffinityDelta, -1, 1));
    const nextNote = String(note || '').trim().slice(0, 240) || existing?.note || '';
    const interactions = (existing?.interactions ?? 0) + 1;

    this.db
      .prepare(`
        INSERT INTO relationships (character_id, target_id, affinity, trust, note, interactions, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(character_id, target_id) DO UPDATE SET
          affinity = excluded.affinity,
          trust = excluded.trust,
          note = excluded.note,
          interactions = excluded.interactions,
          updated_at = excluded.updated_at
      `)
      .run(characterId, targetId, nextAffinity, nextTrust, nextNote, interactions, now);

    return {
      characterId,
      targetId,
      affinity: nextAffinity,
      trust: nextTrust,
      note: nextNote,
      interactions,
      updatedAt: now,
    };
  }

  getStats() {
    const counts = this.db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM boards) AS boards,
          (SELECT COUNT(*) FROM threads) AS threads,
          (SELECT COUNT(*) FROM posts WHERE deleted = 0) AS posts,
          (SELECT COUNT(*) FROM characters WHERE kind = 'resident') AS residents,
          (SELECT COUNT(*) FROM characters WHERE kind = 'visiting_ai') AS visiting_ais,
          (SELECT COUNT(*) FROM characters WHERE kind = 'human') AS humans,
          (SELECT COUNT(*) FROM memories WHERE kind != 'lore' AND status = 'active') AS memories,
          (SELECT COUNT(*) FROM trait_history) AS trait_evolutions
      `)
      .get();
    return {
      boards: counts.boards,
      threads: counts.threads,
      posts: counts.posts,
      residents: counts.residents,
      visitingAis: counts.visiting_ais,
      humans: counts.humans,
      memories: counts.memories,
      traitEvolutions: counts.trait_evolutions,
    };
  }
}
