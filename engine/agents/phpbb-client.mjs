// Zero-dependency Node.js 22 HTTP client for The Rusty Flagon phpBB forum
// (https://codey.info/forum/). Handles session cookies, CSRF form tokens,
// account registration, AI usergroup membership, topic/post reading, and
// posting in the AI board (f=5).

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function decodeHtmlEntities(input) {
  return String(input || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function stripHtml(input) {
  return decodeHtmlEntities(
    String(input || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractHiddenInputs(htmlFragment) {
  const out = {};
  const re = /<input\b[^>]*>/gi;
  for (const tag of htmlFragment.match(re) || []) {
    if (!/type=["']hidden["']/i.test(tag)) continue;
    const name = tag.match(/name=["']([^"']+)["']/i)?.[1];
    const value = tag.match(/value=["']([^"']*)["']/i)?.[1] ?? '';
    if (name) out[name] = decodeHtmlEntities(value);
  }
  return out;
}

function extractForm(htmlDoc, formId) {
  const re = new RegExp(
    `<form\\b[^>]*id=["']${formId}["'][^>]*action=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/form>`,
    'i'
  );
  const m = htmlDoc.match(re);
  if (m) return { action: decodeHtmlEntities(m[1]), body: m[2] };
  const reAlt = new RegExp(
    `<form\\b[^>]*action=["']([^"']+)["'][^>]*id=["']${formId}["'][^>]*>([\\s\\S]*?)<\\/form>`,
    'i'
  );
  const m2 = htmlDoc.match(reAlt);
  if (m2) return { action: decodeHtmlEntities(m2[1]), body: m2[2] };
  return null;
}

function extractFormByAction(htmlDoc, actionSubstring) {
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  for (const m of htmlDoc.matchAll(re)) {
    const action = decodeHtmlEntities(m[1].match(/action=["']([^"']+)["']/i)?.[1] || '');
    if (action.includes(actionSubstring)) {
      return { action, body: m[2] };
    }
  }
  return null;
}

function extractErrors(htmlDoc) {
  const errors = [];
  for (const m of htmlDoc.matchAll(/<(?:p|div|dd|span)[^>]*class=["'][^"']*\berror\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|div|dd|span)>/gi)) {
    const clean = stripHtml(m[1]);
    if (clean) errors.push(clean);
  }
  return errors;
}

function extractMessages(htmlDoc) {
  const messages = [];
  for (const m of htmlDoc.matchAll(/<div[^>]*id=["']message["'][^>]*>([\s\S]*?)<\/div>/gi)) {
    const clean = stripHtml(m[1]);
    if (clean) messages.push(clean);
  }
  return messages;
}

export function parseForumBoards(htmlDoc) {
  const boards = [];
  const seen = new Set();
  for (const m of String(htmlDoc || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    if (!/\bclass=["'][^"']*\bforumtitle\b[^"']*["']/i.test(attrs)) continue;
    const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = decodeHtmlEntities(hrefMatch[1]);
    const fMatch = href.match(/viewforum\.php\?(?:[^#]*&)?f=(\d+)/i);
    if (!fMatch) continue;
    const id = Number(fMatch[1]);
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) continue;
    const name = stripHtml(m[2]);
    if (!name) continue;
    seen.add(id);
    boards.push({ id, name });
  }
  return boards;
}

export function parseForumTopics(htmlDoc) {
  const topics = [];
  const seen = new Set();
  for (const m of htmlDoc.matchAll(
    /<a[^>]*href=["']([^"']*viewtopic\.php\?[^"']*t=(\d+)[^"']*)["'][^>]*class=["']topictitle["'][^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const id = Number(m[2]);
    if (seen.has(id)) continue;
    seen.add(id);
    topics.push({
      id,
      title: stripHtml(m[3]),
      href: decodeHtmlEntities(m[1]),
    });
  }
  return topics;
}

export function parseTopicPosts(htmlDoc, topicId) {
  const titleMatch = htmlDoc.match(/<h2[^>]*class=["']topic-title["'][^>]*>([\s\S]*?)<\/h2>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]) : `Topic #${topicId}`;
  const posts = [];

  const chunks = htmlDoc.split(/<div\s+id=["']p(\d+)["']\s+class=["']post\b/i);
  for (let i = 1; i + 1 < chunks.length; i += 2) {
    const postId = Number(chunks[i]);
    const block = chunks[i + 1];
    const authorMatch =
      block.match(/<a[^>]*class=["'][^"']*username[^"']*["'][^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<span[^>]*class=["'][^"']*username[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const author = authorMatch ? stripHtml(authorMatch[1]) : 'Unknown';
    const timeMatch = block.match(/<time[^>]*datetime=["']([^"']+)["']/i);
    const contentMatch = block.match(/<div\s+class=["']content["']>([\s\S]*?)<\/div>\s*(?:<div|<\/div>)/i);
    const body = contentMatch ? stripHtml(contentMatch[1]) : '';
    posts.push({
      id: postId,
      author,
      timestamp: timeMatch ? timeMatch[1] : null,
      body,
    });
  }

  return { id: Number(topicId), title, posts };
}

export class PhpBbClient {
  constructor({ baseUrl = 'https://codey.info/forum', timeoutMs = 15000, formDelayMs = 2500 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.formDelayMs = formDelayMs;
    this.cookies = new Map();
  }

  clearCookies() {
    this.cookies.clear();
  }

  #cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #storeCookies(response) {
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
    for (const raw of setCookies) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const val = pair.slice(eq + 1).trim();
        if (val === 'deleted' || val === '') this.cookies.delete(name);
        else this.cookies.set(name, val);
      }
    }
  }

  #resolveUrl(relOrAbs) {
    const clean = String(relOrAbs || '').replace(/^\.\//, '');
    if (/^https?:\/\//i.test(clean)) return clean;
    if (clean.startsWith('/')) {
      const origin = new URL(this.baseUrl).origin;
      return `${origin}${clean}`;
    }
    return `${this.baseUrl}/${clean}`;
  }

  async request(relUrl, { method = 'GET', form = null, maxRedirects = 6 } = {}) {
    let url = this.#resolveUrl(relUrl);
    let currentMethod = method;
    let currentBody = form ? new URLSearchParams(form).toString() : null;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const headers = {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'RustyFlagon-TavernAgent/1.0',
        Connection: 'close',
      };
      const cookieStr = this.#cookieHeader();
      if (cookieStr) headers.Cookie = cookieStr;
      if (currentBody !== null) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      let response;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(url, {
            method: currentMethod,
            headers,
            body: currentBody,
            redirect: 'manual',
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          break;
        } catch (err) {
          if (attempt === 1) throw err;
          await delay(800);
        }
      }
      this.#storeCookies(response);

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const loc = response.headers.get('location');
        await response.body?.cancel();
        if (!loc) return { status: response.status, url, html: '' };
        url = new URL(loc, url).toString();
        if (response.status === 303 || (response.status === 302 && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody = null;
        }
        continue;
      }

      const html = await response.text();
      return { status: response.status, url, html };
    }
    throw new Error('Too many redirects');
  }

  async register({ username, password, email }) {
    this.clearCookies();
    const step1 = await this.request('ucp.php?mode=register');
    const agreeForm = extractForm(step1.html, 'agreement');
    let step2Html = step1.html;
    if (agreeForm) {
      const hidden1 = extractHiddenInputs(agreeForm.body);
      if (this.formDelayMs > 0) await delay(this.formDelayMs);
      const step2 = await this.request(agreeForm.action, {
        method: 'POST',
        form: { ...hidden1, agreed: 'I agree to these terms' },
      });
      step2Html = step2.html;
    }

    if (/confirm_code|recaptcha|hcaptcha|turnstile/i.test(step2Html)) {
      return { ok: false, reason: 'captcha_required', errors: ['Registration requires CAPTCHA'] };
    }

    const regForm = extractForm(step2Html, 'register');
    if (!regForm) {
      return { ok: false, reason: 'form_missing', errors: ['Registration form not found'] };
    }
    const hidden2 = extractHiddenInputs(regForm.body);
    if (this.formDelayMs > 0) await delay(this.formDelayMs);

    const submit = await this.request(regForm.action, {
      method: 'POST',
      form: {
        ...hidden2,
        username,
        new_password: password,
        password_confirm: password,
        email,
        tz: 'UTC',
        submit: 'Submit',
      },
    });
    const errors = extractErrors(submit.html);
    const messages = extractMessages(submit.html);
    if (errors.length > 0) {
      const taken = errors.some((e) => /already taken|already in use/i.test(e));
      return { ok: false, reason: taken ? 'already_exists' : 'validation_error', errors, messages };
    }
    const created = messages.some((m) => /thank you for registering|account has been created/i.test(m));
    return { ok: created, reason: created ? 'registered' : 'unknown', errors, messages };
  }

  async login({ username, password }) {
    this.clearCookies();
    const page = await this.request('ucp.php?mode=login');
    const loginForm =
      extractForm(page.html, 'login') || extractFormByAction(page.html, 'mode=login');
    if (!loginForm) {
      return { ok: false, reason: 'login_form_missing' };
    }
    const hidden = extractHiddenInputs(loginForm.body);
    if (this.formDelayMs > 0) await delay(this.formDelayMs);
    const res = await this.request(loginForm.action, {
      method: 'POST',
      form: {
        ...hidden,
        username,
        password,
        autologin: 'on',
        login: 'Login',
      },
    });
    const errors = extractErrors(res.html);
    const messages = extractMessages(res.html);
    const loggedIn =
      errors.length === 0 &&
      res.html.includes('mode=logout') &&
      res.html.toLowerCase().includes(username.toLowerCase());
    return { ok: loggedIn, errors, messages };
  }

  async joinGroup(groupId) {
    const page = await this.request('ucp.php?i=ucp_groups&mode=membership');
    const ucpForm = extractForm(page.html, 'ucp');
    if (!ucpForm) {
      return { ok: false, reason: 'group_form_missing' };
    }
    // Check if already a member (group radio appears inside the "Memberships" section)
    const groupRowRe = new RegExp(`name=["']selected["'][^>]*value=["']${groupId}["']`, 'i');
    if (!groupRowRe.test(ucpForm.body)) {
      return { ok: false, reason: 'group_not_found' };
    }

    const hidden = extractHiddenInputs(ucpForm.body);
    if (this.formDelayMs > 0) await delay(Math.min(this.formDelayMs, 1500));
    const step1 = await this.request(ucpForm.action, {
      method: 'POST',
      form: {
        ...hidden,
        selected: String(groupId),
        action: 'join',
        submit: 'Submit',
      },
    });

    const confirmForm = extractForm(step1.html, 'confirm');
    let finalHtml = step1.html;
    if (confirmForm) {
      const cHidden = extractHiddenInputs(confirmForm.body);
      const step2 = await this.request(confirmForm.action, {
        method: 'POST',
        form: { ...cHidden, confirm: 'Yes' },
      });
      finalHtml = step2.html;
    }

    const messages = extractMessages(finalHtml);
    const joined = messages.some((m) =>
      /successfully joined|already a member/i.test(m)
    );
    return { ok: joined, messages };
  }

  async listPublicBoards() {
    const res = await this.request('index.php');
    return parseForumBoards(res.html);
  }

  async listTopics(boardId) {
    const res = await this.request(`viewforum.php?f=${boardId}`);
    return parseForumTopics(res.html);
  }

  async readTopic(topicId) {
    const res = await this.request(`viewtopic.php?t=${topicId}`);
    return parseTopicPosts(res.html, topicId);
  }

  async createTopic({ boardId, subject, message }) {
    const page = await this.request(`posting.php?mode=post&f=${boardId}`);
    const postForm = extractForm(page.html, 'postform');
    if (!postForm) {
      return { ok: false, reason: 'cannot_post', messages: extractMessages(page.html) };
    }
    const hidden = extractHiddenInputs(postForm.body);
    if (this.formDelayMs > 0) await delay(this.formDelayMs);

    const res = await this.request(postForm.action, {
      method: 'POST',
      form: {
        ...hidden,
        subject: subject.slice(0, 120),
        message: message.slice(0, 4000),
        post: 'Submit',
      },
    });
    const errors = extractErrors(res.html);
    const messages = extractMessages(res.html);
    const topicIdMatch =
      res.url.match(/[?&]t=(\d+)/) || res.html.match(/viewtopic\.php\?[^"']*t=(\d+)/);
    const pendingApproval = messages.some((m) => /approved by a moderator/i.test(m));
    return {
      ok: errors.length === 0,
      topicId: topicIdMatch ? Number(topicIdMatch[1]) : null,
      pendingApproval,
      url: res.url,
      errors,
      messages,
    };
  }

  async replyToTopic({ boardId, topicId, subject, message }) {
    const page = await this.request(`posting.php?mode=reply&f=${boardId}&t=${topicId}`);
    const postForm = extractForm(page.html, 'postform');
    if (!postForm) {
      return { ok: false, reason: 'cannot_reply', messages: extractMessages(page.html) };
    }
    const hidden = extractHiddenInputs(postForm.body);
    const defaultSubject =
      postForm.body.match(/name=["']subject["'][^>]*value=["']([^"']*)["']/i)?.[1] ||
      `Re: Topic #${topicId}`;
    if (this.formDelayMs > 0) await delay(this.formDelayMs);

    const res = await this.request(postForm.action, {
      method: 'POST',
      form: {
        ...hidden,
        subject: (subject || decodeHtmlEntities(defaultSubject)).slice(0, 120),
        message: message.slice(0, 4000),
        post: 'Submit',
      },
    });
    const errors = extractErrors(res.html);
    const messages = extractMessages(res.html);
    const postIdMatch = res.url.match(/[?&]p=(\d+)/) || res.html.match(/id=["']p(\d+)["']/);
    const pendingApproval = messages.some((m) => /approved by a moderator/i.test(m));
    return {
      ok: errors.length === 0,
      postId: postIdMatch ? Number(postIdMatch[1]) : null,
      pendingApproval,
      url: res.url,
      errors,
      messages,
    };
  }
}
