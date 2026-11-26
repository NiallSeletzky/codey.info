// Autonomous Site Reviewer Agent for The Rusty Flagon (codey.info).
// Connects to the live site and/or Tavern API, audits every requirement,
// generates a prioritized backlog for Programming Agents, and optionally
// creates or updates a single tracked GitHub Issue.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ISSUE_TITLE = '[Tavern Review] Automated site audit & requirements check';

async function probe(url, { method = 'GET', body = null, timeoutMs = 10000 } = {}) {
  try {
    const headers = { Accept: 'application/json, text/plain, text/html;q=0.9' };
    if (body !== null) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    const contentType = res.headers.get('content-type') || '';
    const text = method === 'HEAD' ? '' : (await res.text()).slice(0, 65536);
    let json = null;
    if (contentType.includes('application/json') && text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { ok: true, status: res.status, contentType, text, json, finalUrl: res.url };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: '',
      text: '',
      json: null,
      error: error.name === 'TimeoutError' ? 'timeout' : 'network_error',
    };
  }
}

export async function auditSite({
  siteUrl = process.env.REVIEW_SITE_URL || 'https://codey.info',
  tavernApiUrl = process.env.REVIEW_TAVERN_URL || `${siteUrl.replace(/\/+$/, '')}/engine`,
  timeoutMs = 10000,
} = {}) {
  const cleanSite = siteUrl.replace(/\/+$/, '');
  const cleanApi = tavernApiUrl.replace(/\/+$/, '');
  const sameOriginRoot = cleanSite === cleanApi;

  const [
    home,
    rootLlms,
    rootAgent,
    forum,
    apiStatus,
    apiLlmsHead,
    apiAgent,
    apiOpenApi,
    apiBoards,
    apiChars,
    apiRoundTable,
    apiMcpInit,
    apiForumBoards,
  ] = await Promise.all([
    probe(`${cleanSite}/`, { timeoutMs }),
    probe(`${cleanSite}/llms.txt`, { timeoutMs }),
    probe(`${cleanSite}/.well-known/agent.json`, { timeoutMs }),
    sameOriginRoot ? Promise.resolve(null) : probe(`${cleanSite}/forum/`, { timeoutMs }),
    probe(`${cleanApi}/api/v1/status`, { timeoutMs }),
    probe(`${cleanApi}/llms.txt`, { method: 'HEAD', timeoutMs }),
    probe(`${cleanApi}/.well-known/agent.json`, { timeoutMs }),
    probe(`${cleanApi}/api/v1/openapi.json`, { timeoutMs }),
    probe(`${cleanApi}/api/v1/boards`, { timeoutMs }),
    probe(`${cleanApi}/api/v1/characters`, { timeoutMs }),
    probe(`${cleanApi}/api/v1/roundtable`, { timeoutMs }),
    probe(`${cleanApi}/mcp`, {
      method: 'POST',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'tavern-reviewer', version: '1.0.0' },
        },
      },
      timeoutMs,
    }),
    probe(`${cleanApi}/api/v1/forum/boards`, { timeoutMs }),
  ]);

  const checks = [];
  const recommendations = [];

  // 1. Portal homepage check (when auditing full domain)
  if (!sameOriginRoot) {
    const hasEngineLink = /href=["']\/engine\/?["']/i.test(home.text);
    const hasStaleCopy =
      /not yet automated|not enabled yet|no programmatic posting api/i.test(home.text);
    const verdict =
      home.status === 200 && hasEngineLink && !hasStaleCopy
        ? 'PASS'
        : home.status === 200
          ? 'PARTIAL'
          : 'FAIL';
    checks.push({
      id: 'portal_home',
      area: 'Portal homepage',
      url: `${cleanSite}/`,
      status: home.status,
      verdict,
      detail:
        verdict === 'PASS'
          ? 'Homepage links to /engine/ AI Tavern and reflects live capabilities.'
          : home.status !== 200
            ? `Unreachable (${home.error || `HTTP ${home.status}`}).`
            : 'Homepage is live but missing /engine/ doorway or contains stale pre-automation copy.',
    });
    if (verdict !== 'PASS') {
      recommendations.push({
        id: 'update_portal_home',
        priority: 'high',
        title: 'Deploy updated portal/index.html linking to /engine/ and discovery docs',
        files: ['portal/index.html', '.cpanel.yml'],
        action:
          'Deploy portal/index.html via cPanel Git Version Control so visitors see the /engine/ AI Tavern CTA and accurate status.',
      });
    }
  }

  // 2. Root /llms.txt AI discovery
  const llmsHasRegister = /\/api\/v1\/agents\/register/i.test(rootLlms.text);
  const llmsBlocked = /no programmatic posting api is available yet/i.test(rootLlms.text);
  const rootLlmsVerdict =
    rootLlms.status === 200 && llmsHasRegister && !llmsBlocked ? 'PASS' : 'FAIL';
  checks.push({
    id: 'root_llms_txt',
    area: 'AI discovery (/llms.txt)',
    url: `${cleanSite}/llms.txt`,
    status: rootLlms.status,
    verdict: rootLlmsVerdict,
    detail:
      rootLlmsVerdict === 'PASS'
        ? 'Advertises self-registration and message-board API endpoints.'
        : rootLlms.status !== 200
          ? `HTTP ${rootLlms.status || rootLlms.error}`
          : 'Still serves legacy notice saying no programmatic posting API exists.',
  });
  if (rootLlmsVerdict !== 'PASS') {
    recommendations.push({
      id: 'deploy_llms_txt',
      priority: 'critical',
      title: 'Publish updated portal/llms.txt advertising the live Tavern API',
      files: ['portal/llms.txt', '.cpanel.yml'],
      action:
        'Ensure /llms.txt documents /engine/api/v1/agents/register, /engine/llms.txt, and /.well-known/agent.json.',
    });
  }

  // 3. Root /.well-known/agent.json
  const rootAgentValid =
    rootAgent.status === 200 &&
    rootAgent.json &&
    rootAgent.json.admission?.mode === 'open-self-registration' &&
    Boolean(rootAgent.json.endpoints?.register?.url);
  checks.push({
    id: 'root_agent_json',
    area: 'Agent manifest (/.well-known/agent.json)',
    url: `${cleanSite}/.well-known/agent.json`,
    status: rootAgent.status,
    verdict: rootAgentValid ? 'PASS' : 'FAIL',
    detail: rootAgentValid
      ? `Manifest v${rootAgent.json.version} advertises open self-registration.`
      : `HTTP ${rootAgent.status || rootAgent.error} — missing or closed agent manifest.`,
  });
  if (!rootAgentValid) {
    recommendations.push({
      id: 'deploy_agent_manifest',
      priority: 'critical',
      title: 'Deploy portal/.well-known/agent.json via .cpanel.yml',
      files: ['portal/.well-known/agent.json', '.cpanel.yml'],
      action: 'Publish /.well-known/agent.json so external AI agents can auto-discover the Tavern.',
    });
  }

  // 4. Companion phpBB forum (optional when auditing full domain)
  if (forum) {
    const forumOk = forum.status === 200 && /phpbb|rusty flagon/i.test(forum.text);
    checks.push({
      id: 'phpbb_forum',
      area: 'Companion phpBB forum',
      url: `${cleanSite}/forum/`,
      status: forum.status,
      verdict: forumOk ? 'PASS' : 'PARTIAL',
      detail: forumOk
        ? 'Companion phpBB forum responds cleanly.'
        : `Unexpected response (HTTP ${forum.status || forum.error}).`,
    });
  }

  // 5. Persistent Tavern API status (/api/v1/status)
  const apiLive =
    apiStatus.status === 200 &&
    apiStatus.json &&
    apiStatus.json.status === 'ok' &&
    apiStatus.json.stats &&
    typeof apiStatus.json.stats.residents === 'number';
  const isStub = /tavern engine is running/i.test(apiStatus.text);
  checks.push({
    id: 'tavern_api_status',
    area: 'Persistent Tavern API (/api/v1/status)',
    url: `${cleanApi}/api/v1/status`,
    status: apiStatus.status,
    verdict: apiLive ? 'PASS' : 'FAIL',
    detail: apiLive
      ? `Live (${apiStatus.json.provider?.provider}/${apiStatus.json.provider?.model}; ${apiStatus.json.stats.residents} residents, ${apiStatus.json.stats.visitingAis} visiting AIs, ${apiStatus.json.stats.memories} memories, ${apiStatus.json.stats.traitEvolutions} evolutions).`
      : isStub
        ? 'Still running old smoke-test app.cjs ("Tavern engine is running.") instead of persistent Tavern server.'
        : `Unavailable or non-JSON (HTTP ${apiStatus.status || apiStatus.error}).`,
  });
  if (!apiLive) {
    recommendations.push({
      id: 'deploy_passenger_tavern',
      priority: 'critical',
      title: 'Switch HostArmada /engine/ Passenger app to engine/tavern-passenger.cjs',
      files: ['engine/tavern-passenger.cjs', 'engine/tavern/server.mjs'],
      action:
        'Deploy engine/ to HostArmada and point the cPanel Node.js Application startup file to tavern-passenger.cjs with TAVERN_BASE_PATH=/engine and TAVERN_PUBLIC_ORIGIN=https://codey.info.',
    });
  }

  // 6. HEAD discovery + agent.json on Tavern API
  const headOk = apiLlmsHead.status === 200;
  const apiManifestOk =
    apiAgent.status === 200 && apiAgent.json?.capabilities?.bounded_trait_evolution === true;
  checks.push({
    id: 'tavern_discovery',
    area: 'Tavern API discovery & HEAD support',
    url: `${cleanApi}/.well-known/agent.json`,
    status: apiAgent.status,
    verdict: headOk && apiManifestOk ? 'PASS' : 'FAIL',
    detail:
      headOk && apiManifestOk
        ? 'HEAD /llms.txt and GET /.well-known/agent.json both pass.'
        : `HEAD /llms.txt=${apiLlmsHead.status}, manifest=${apiAgent.status}.`,
  });

  // 7. OpenAPI 3.1 schema completeness
  const openApiPaths = apiOpenApi.json?.paths || {};
  const registerHasSchema = Boolean(
    openApiPaths['/api/v1/agents/register']?.post?.requestBody?.content?.['application/json']?.schema
  );
  const hasResponses = Boolean(openApiPaths['/api/v1/threads']?.get?.responses?.['200']);
  const openApiOk =
    apiOpenApi.status === 200 &&
    apiOpenApi.json?.openapi === '3.1.0' &&
    registerHasSchema &&
    hasResponses;
  checks.push({
    id: 'openapi_schema',
    area: 'OpenAPI 3.1 schema completeness',
    url: `${cleanApi}/api/v1/openapi.json`,
    status: apiOpenApi.status,
    verdict: openApiOk ? 'PASS' : 'FAIL',
    detail: openApiOk
      ? `Valid OpenAPI 3.1.0 with ${Object.keys(openApiPaths).length} documented paths, schemas, and responses.`
      : 'OpenAPI 3.1 schema missing or incomplete (lacking requestBody/responses schemas).',
  });

  // 8. Message board & persistent character state
  const boardsCount = Array.isArray(apiBoards.json?.boards) ? apiBoards.json.boards.length : 0;
  const charsCount = Array.isArray(apiChars.json?.characters) ? apiChars.json.characters.length : 0;
  const boardAndCharsOk = boardsCount >= 3 && charsCount >= 5;
  checks.push({
    id: 'boards_and_characters',
    area: 'Message boards & persistent characters',
    url: `${cleanApi}/api/v1/characters`,
    status: apiChars.status,
    verdict: boardAndCharsOk ? 'PASS' : 'FAIL',
    detail: boardAndCharsOk
      ? `${boardsCount} boards and ${charsCount} persistent characters accessible.`
      : `Insufficient boards (${boardsCount}) or characters (${charsCount}).`,
  });

  // 9. Unified AI Round Table & phpBB Evolution Ledger endpoint
  const rtSeats = Array.isArray(apiRoundTable.json?.seats) ? apiRoundTable.json.seats.length : 0;
  const rtOk =
    apiRoundTable.status === 200 &&
    rtSeats >= 5 &&
    Array.isArray(apiRoundTable.json?.forumThreads) &&
    Array.isArray(apiRoundTable.json?.evolutionLedger);
  checks.push({
    id: 'roundtable_endpoint',
    area: 'Unified Round Table & phpBB evolution feed',
    url: `${cleanApi}/api/v1/roundtable`,
    status: apiRoundTable.status,
    verdict: rtOk ? 'PASS' : 'FAIL',
    detail: rtOk
      ? `Round Table live with ${rtSeats} AI seats, ${apiRoundTable.json.forumThreads.length} synced forum threads, and ${apiRoundTable.json.evolutionLedger.length} evolution ledger entries.`
      : `Round Table endpoint unavailable or incomplete (HTTP ${apiRoundTable.status}).`,
  });

  // 10. Remote MCP Streamable HTTP server (/mcp)
  const mcpServerName = apiMcpInit.json?.result?.serverInfo?.name;
  const mcpOk =
    apiMcpInit.status === 200 &&
    mcpServerName === 'rusty-flagon-tavern' &&
    Boolean(apiMcpInit.json?.result?.capabilities?.tools);
  checks.push({
    id: 'mcp_remote_server',
    area: 'Remote MCP Streamable HTTP server (/mcp)',
    url: `${cleanApi}/mcp`,
    status: apiMcpInit.status,
    verdict: mcpOk ? 'PASS' : 'FAIL',
    detail: mcpOk
      ? `Remote MCP live (${mcpServerName} v${apiMcpInit.json.result.serverInfo.version}, protocol ${apiMcpInit.json.result.protocolVersion}).`
      : `Remote MCP endpoint unavailable or did not complete initialize (HTTP ${apiMcpInit.status}).`,
  });

  // 11. Live phpBB Forum Bridge API (/api/v1/forum/boards)
  const forumBridgeOk =
    apiForumBoards.status === 200 && Array.isArray(apiForumBoards.json?.boards);
  checks.push({
    id: 'forum_bridge_api',
    area: 'Native phpBB Forum Bridge API (/api/v1/forum/*)',
    url: `${cleanApi}/api/v1/forum/boards`,
    status: apiForumBoards.status,
    verdict: forumBridgeOk ? 'PASS' : 'FAIL',
    detail: forumBridgeOk
      ? `Forum Bridge live (${apiForumBoards.json.boards.length} boards, source=${apiForumBoards.json.source || 'ok'}).`
      : `Forum Bridge API unavailable (HTTP ${apiForumBoards.status}).`,
  });

  if (apiLive && apiStatus.json.provider?.isMock) {
    recommendations.push({
      id: 'configure_live_llm_key',
      priority: 'medium',
      title: 'Configure a live LLM provider key (Anthropic or OpenAI-compatible) for resident characters',
      files: ['engine/tavern/README.md'],
      action:
        'Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / XAI_API_KEY / OLLAMA_MODEL) in the host environment with TAVERN_ROUND_COOLDOWN_SECONDS=30 and TAVERN_MAX_ROUNDS_PER_DAY=80.',
    });
  }

  const summary = {
    passed: checks.filter((c) => c.verdict === 'PASS').length,
    partial: checks.filter((c) => c.verdict === 'PARTIAL').length,
    failed: checks.filter((c) => c.verdict === 'FAIL').length,
    total: checks.length,
  };

  return {
    auditedAt: new Date().toISOString(),
    siteUrl: cleanSite,
    tavernApiUrl: cleanApi,
    summary,
    checks,
    recommendations,
  };
}

export function formatReviewMarkdown(report) {
  const rows = report.checks
    .map(
      (c) =>
        `| ${c.area} | \`${c.url}\` | \`${c.status || 'ERR'}\` | **${c.verdict}** | ${c.detail} |`
    )
    .join('\n');

  const recs =
    report.recommendations.length > 0
      ? report.recommendations
          .map(
            (r, idx) =>
              `- [ ] **[${r.priority.toUpperCase()}] ${idx + 1}. ${r.title}**\n  - Files: ${r.files.map((f) => `\`${f}\``).join(', ')}\n  - Action: ${r.action}`
          )
          .join('\n')
      : '- All audited Tavern requirements are passing!';

  return [
    `# Automated Tavern Site Review`,
    '',
    `- **Audited at**: ${report.auditedAt}`,
    `- **Site URL**: ${report.siteUrl}`,
    `- **Tavern API URL**: ${report.tavernApiUrl}`,
    `- **Score**: ${report.summary.passed}/${report.summary.total} PASS (${report.summary.partial} PARTIAL, ${report.summary.failed} FAIL)`,
    '',
    '## Requirements Audit Table',
    '',
    '| Requirement | URL | HTTP | Verdict | Details |',
    '| --- | --- | --- | --- | --- |',
    rows,
    '',
    '## Suggested Improvements for Programming Agents',
    '',
    recs,
    '',
    '_Generated automatically by `engine/agents/reviewer.mjs`._',
  ].join('\n');
}

export async function publishReviewToGitHub({ report, token, repo }) {
  if (!token || !repo) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required to publish to GitHub');
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'rusty-flagon-reviewer-agent',
  };
  const body = formatReviewMarkdown(report);

  const listRes = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&labels=tavern-review&per_page=20`,
    { headers }
  );
  if (!listRes.ok) {
    throw new Error(`Failed to list GitHub issues (HTTP ${listRes.status})`);
  }
  const existingIssues = await listRes.json();
  const tracked = existingIssues.find((i) => i.title === ISSUE_TITLE);

  if (tracked) {
    const updateRes = await fetch(
      `https://api.github.com/repos/${repo}/issues/${tracked.number}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body }),
      }
    );
    if (!updateRes.ok) {
      throw new Error(`Failed to update GitHub issue #${tracked.number} (HTTP ${updateRes.status})`);
    }
    const updated = await updateRes.json();
    return { action: 'updated', number: updated.number, url: updated.html_url };
  }

  const createRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: ISSUE_TITLE,
      body,
      labels: ['tavern-review', 'tavern-improvement'],
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Failed to create GitHub issue (HTTP ${createRes.status})`);
  }
  const created = await createRes.json();
  return { action: 'created', number: created.number, url: created.html_url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  const siteUrl = flag('--site', process.env.REVIEW_SITE_URL || 'https://codey.info');
  const tavernApiUrl = flag(
    '--tavern',
    process.env.REVIEW_TAVERN_URL || `${siteUrl.replace(/\/+$/, '')}/engine`
  );
  const publish = args.includes('--publish-github');
  const asJson = args.includes('--json');

  const report = await auditSite({ siteUrl, tavernApiUrl });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReviewMarkdown(report));
  }

  if (publish) {
    const result = await publishReviewToGitHub({
      report,
      token: process.env.GITHUB_TOKEN,
      repo: process.env.GITHUB_REPOSITORY,
    });
    console.log(`\nGitHub issue ${result.action}: #${result.number} (${result.url})`);
  }
}
