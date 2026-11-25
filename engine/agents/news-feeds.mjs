// Zero-dependency news & social feed scanner for The Rusty Flagon AI Tavern.
// Pulls fresh AI, agent, open-source, robotics, and tech stories from public
// RSS/Atom/JSON feeds (Hacker News, Hugging Face Blog, Simon Willison, arXiv
// cs.AI, BBC Tech), optional official X API v2 (when X_BEARER_TOKEN is set),
// and optional custom RSS/Atom URLs (TAVERN_EXTRA_FEEDS).

import { decodeHtmlEntities, stripHtml } from './phpbb-client.mjs';

export const DEFAULT_FEED_SOURCES = Object.freeze([
  {
    id: 'hacker-news-ai',
    name: 'Hacker News (AI)',
    kind: 'hn_algolia',
    url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story&query=AI%20OR%20LLM%20OR%20agent&hitsPerPage=10',
  },
  {
    id: 'huggingface-blog',
    name: 'Hugging Face Blog',
    kind: 'rss_atom',
    url: 'https://huggingface.co/blog/feed.xml',
  },
  {
    id: 'simon-willison',
    name: "Simon Willison's Weblog",
    kind: 'rss_atom',
    url: 'https://simonwillison.net/atom/everything/',
  },
  {
    id: 'arxiv-cs-ai',
    name: 'arXiv cs.AI',
    kind: 'rss_atom',
    url: 'https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=8',
  },
  {
    id: 'bbc-tech',
    name: 'BBC Technology',
    kind: 'rss_atom',
    url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  },
]);

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  const raw = m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1');
  return stripHtml(raw);
}

function extractLink(block) {
  // Atom <link href="..." rel="alternate"/> or <link href="..."/>
  const atomAlt = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (atomAlt) return decodeHtmlEntities(atomAlt[1]).trim();
  const atomHref = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (atomHref) return decodeHtmlEntities(atomHref[1]).trim();
  // RSS <link>https://...</link>
  const rssLink = extractTag(block, 'link');
  return rssLink.trim();
}

export function parseRssOrAtom(xml, sourceName) {
  const items = [];
  const isAtom = /<feed\b/i.test(xml) && /<entry\b/i.test(xml);
  const blocks = isAtom
    ? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || []
    : xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  for (const block of blocks.slice(0, 10)) {
    const title = extractTag(block, 'title').replace(/\s+/g, ' ').trim();
    const url = extractLink(block);
    const summaryRaw =
      extractTag(block, 'summary') ||
      extractTag(block, 'description') ||
      extractTag(block, 'content');
    const summary = summaryRaw.replace(/\s+/g, ' ').trim().slice(0, 320);
    const publishedAt =
      extractTag(block, 'published') ||
      extractTag(block, 'updated') ||
      extractTag(block, 'pubDate') ||
      null;

    if (!title || title.length < 6) continue;
    items.push({
      id: url || `${sourceName}:${title.toLowerCase().slice(0, 80)}`,
      source: sourceName,
      title: title.slice(0, 180),
      url: /^https?:\/\//i.test(url) ? url : '',
      summary,
      publishedAt,
    });
  }
  return items;
}

export function parseHnAlgolia(json, sourceName = 'Hacker News (AI)') {
  const hits = Array.isArray(json?.hits) ? json.hits : [];
  const items = [];
  for (const h of hits) {
    const title = String(h.title || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 8) continue;
    const url =
      h.url && /^https?:\/\//i.test(h.url)
        ? h.url
        : `https://news.ycombinator.com/item?id=${h.objectID}`;
    const points = Number(h.points || 0);
    const comments = Number(h.num_comments || 0);
    items.push({
      id: url,
      source: sourceName,
      title: title.slice(0, 180),
      url,
      summary: `HN discussion (${points} pts, ${comments} comments) — ${title}`.slice(0, 320),
      publishedAt: h.created_at || null,
      engagement: points + comments * 2,
    });
  }
  return items;
}

export const DEFAULT_X_ELON_QUERY = 'from:elonmusk -is:retweet -is:reply';

export function parseXRecentSearch(
  json,
  sourceName = 'X (AI & Agents)',
  { forcedHandle = '', isElonPost = false } = {}
) {
  const tweets = Array.isArray(json?.data) ? json.data : [];
  const users = new Map(
    (Array.isArray(json?.includes?.users) ? json.includes.users : []).map((u) => [u.id, u])
  );
  const minLength = isElonPost ? 8 : 20;
  const items = [];
  for (const t of tweets) {
    const text = String(t.text || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < minLength) continue;
    const user = users.get(t.author_id);
    const username = forcedHandle || user?.username || '';
    const handle = username ? `@${username.replace(/^@/, '')}` : 'X user';
    const cleanUser = username.replace(/^@/, '');
    const url = cleanUser
      ? `https://x.com/${cleanUser}/status/${t.id}`
      : `https://x.com/i/web/status/${t.id}`;
    const metrics = t.public_metrics || {};
    items.push({
      id: url,
      source: sourceName,
      title: `${handle}: ${text.slice(0, 110)}${text.length > 110 ? '…' : ''}`,
      url,
      summary: text.slice(0, 320),
      publishedAt: t.created_at || null,
      engagement: Number(metrics.like_count || 0) + Number(metrics.retweet_count || 0) * 2,
      ...(isElonPost ? { isElonPost: true, authorHandle: handle } : {}),
    });
  }
  return items;
}

export async function fetchElonXPosts({
  xBearerToken = process.env.X_BEARER_TOKEN || '',
  query = process.env.X_ELON_QUERY || DEFAULT_X_ELON_QUERY,
  maxResults = 10,
  timeoutMs = 10000,
  fetchImpl = fetch,
} = {}) {
  if (typeof xBearerToken !== 'string' || !xBearerToken.trim()) {
    return { source: 'X (@elonmusk)', ok: false, status: null, skipped: true, items: [] };
  }
  try {
    // Omit expansions=author_id on from:elonmusk to avoid extra user-profile billing per read!
    const clampedMax = Math.min(Math.max(Number(maxResults) || 10, 10), 25);
    const url =
      'https://api.x.com/2/tweets/search/recent?' +
      new URLSearchParams({
        query,
        max_results: String(clampedMax),
        'tweet.fields': 'created_at,public_metrics',
      }).toString();
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${xBearerToken.trim()}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { source: 'X (@elonmusk)', ok: false, status: res.status, items: [] };
    }
    const json = await res.json();
    const items = parseXRecentSearch(json, 'X (@elonmusk)', {
      forcedHandle: 'elonmusk',
      isElonPost: true,
    });
    return { source: 'X (@elonmusk)', ok: true, status: res.status, items };
  } catch (err) {
    return { source: 'X (@elonmusk)', ok: false, error: err.name || 'fetch_error', items: [] };
  }
}

export async function fetchNewsDigest({
  sources = DEFAULT_FEED_SOURCES,
  extraFeedUrls = process.env.TAVERN_EXTRA_FEEDS || '',
  xBearerToken = process.env.X_BEARER_TOKEN || '',
  xQuery = process.env.X_SEARCH_QUERY ||
    '("AI agents" OR "open weights" OR LLM OR Claude OR Grok) lang:en -is:retweet',
  xElonQuery = process.env.X_ELON_QUERY || DEFAULT_X_ELON_QUERY,
  includeX = true,
  includeElonX = true,
  elonOnly = false,
  timeoutMs = 10000,
  fetchImpl = fetch,
} = {}) {
  const results = [];

  if (!elonOnly) {
    const activeSources = [...sources];

    if (typeof extraFeedUrls === 'string' && extraFeedUrls.trim()) {
      for (const rawUrl of extraFeedUrls.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (/^https?:\/\//i.test(rawUrl)) {
          activeSources.push({
            id: `custom-${activeSources.length}`,
            name: new URL(rawUrl).hostname,
            kind: 'rss_atom',
            url: rawUrl,
          });
        }
      }
    }

    const freeResults = await Promise.all(
      activeSources.map(async (src) => {
        try {
          const res = await fetchImpl(src.url, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              'User-Agent': 'RustyFlagon-TavernNewsCurator/1.0',
              Accept: 'application/json, application/atom+xml, application/rss+xml, text/xml;q=0.9',
            },
          });
          if (!res.ok) {
            await res.body?.cancel();
            return { source: src.name, ok: false, status: res.status, items: [] };
          }
          if (src.kind === 'hn_algolia') {
            const json = await res.json();
            return { source: src.name, ok: true, status: res.status, items: parseHnAlgolia(json, src.name) };
          }
          const xml = await res.text();
          return { source: src.name, ok: true, status: res.status, items: parseRssOrAtom(xml, src.name) };
        } catch (err) {
          return { source: src.name, ok: false, error: err.name || 'fetch_error', items: [] };
        }
      })
    );
    results.push(...freeResults);
  }

  // Optional official X API v2 recent search (gated by includeX for credit-saving).
  const hasXToken = typeof xBearerToken === 'string' && xBearerToken.trim().length > 0;
  if (hasXToken && !includeX) {
    results.push({
      source: 'X (credit-saver skipped)',
      ok: true,
      status: null,
      skipped: true,
      items: [],
    });
  } else if (hasXToken && includeX) {
    if (!elonOnly) {
      try {
        const url =
          'https://api.x.com/2/tweets/search/recent?' +
          new URLSearchParams({
            query: xQuery,
            max_results: '10',
            'tweet.fields': 'created_at,public_metrics,author_id',
            expansions: 'author_id',
            'user.fields': 'username,name',
          }).toString();
        const res = await fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: `Bearer ${xBearerToken.trim()}`,
            Accept: 'application/json',
          },
        });
        if (res.ok) {
          const json = await res.json();
          results.push({
            source: 'X (AI & Agents)',
            ok: true,
            status: res.status,
            items: parseXRecentSearch(json),
          });
        } else {
          await res.body?.cancel();
          results.push({ source: 'X (AI & Agents)', ok: false, status: res.status, items: [] });
        }
      } catch (err) {
        results.push({ source: 'X (AI & Agents)', ok: false, error: err.name || 'fetch_error', items: [] });
      }
    }

    if (includeElonX || elonOnly) {
      const elonRes = await fetchElonXPosts({
        xBearerToken,
        query: xElonQuery,
        timeoutMs,
        fetchImpl,
      });
      results.push(elonRes);
    }
  }

  // Interleave round-robin across sources and deduplicate by URL/title so every feed gets visibility
  const seen = new Set();
  const items = [];
  const maxLen = Math.max(0, ...results.map((r) => r.items.length));
  for (let i = 0; i < maxLen; i += 1) {
    for (const r of results) {
      const item = r.items[i];
      if (!item) continue;
      const key = (item.url || item.title).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    sources: results.map((r) => ({
      source: r.source,
      ok: r.ok,
      count: r.items.length,
      status: r.status ?? null,
      ...(r.skipped ? { skipped: true } : {}),
    })),
    items,
  };
}
