// Autonomous Programming Proposal Agent for The Rusty Flagon.
// Reads the Site Reviewer Agent's audit report, inspects repository readiness,
// and generates structured engineering implementation briefs (optionally
// enhanced via Anthropic or OpenAI-compatible LLM when configured) and posts
// them to the tracked GitHub review issue for human/coding-agent execution.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSite } from './reviewer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export function inspectRepoReadiness(repoRoot = REPO_ROOT) {
  const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));
  const cpanel = exists('.cpanel.yml')
    ? fs.readFileSync(path.join(repoRoot, '.cpanel.yml'), 'utf8')
    : '';
  return {
    hasPassengerEntrypoint: exists('engine/tavern-passenger.cjs'),
    hasPersistentTavernServer: exists('engine/tavern/server.mjs'),
    hasPortalAgentJson: exists('portal/.well-known/agent.json'),
    cpanelDeploysAgentJson: cpanel.includes('.well-known/agent.json'),
    hasPortalLlms: exists('portal/llms.txt'),
  };
}

export function buildEngineeringBrief({ report, repoReadiness }) {
  const tasks = [];

  for (const rec of report.recommendations) {
    let statusInRepo = 'needs_code_change';
    let nextStep = rec.action;

    if (rec.id === 'deploy_agent_manifest' && repoReadiness.hasPortalAgentJson && repoReadiness.cpanelDeploysAgentJson) {
      statusInRepo = 'ready_in_repo_awaiting_deploy';
      nextStep =
        'Code is already in Git (`portal/.well-known/agent.json` + `.cpanel.yml`). Trigger cPanel > Git Version Control > Update from Remote > Deploy HEAD Commit.';
    } else if (rec.id === 'deploy_llms_txt' && repoReadiness.hasPortalLlms) {
      statusInRepo = 'ready_in_repo_awaiting_deploy';
      nextStep =
        'Updated `portal/llms.txt` is in Git. Trigger cPanel Deploy HEAD Commit to publish it to `https://codey.info/llms.txt`.';
    } else if (rec.id === 'update_portal_home') {
      statusInRepo = 'ready_in_repo_awaiting_deploy';
      nextStep =
        'Updated `portal/index.html` is in Git. Trigger cPanel Deploy HEAD Commit to publish the `/engine/` AI Tavern links.';
    } else if (rec.id === 'deploy_passenger_tavern' && repoReadiness.hasPassengerEntrypoint) {
      statusInRepo = 'ready_in_repo_awaiting_deploy';
      nextStep =
        'Switch HostArmada cPanel Node.js App (`/home/tachosco/apps/codey-engine`) startup file from `app.cjs` to `tavern-passenger.cjs` with `TAVERN_BASE_PATH=/engine`, `TAVERN_PUBLIC_ORIGIN=https://codey.info`, and `TAVERN_ROUND_COOLDOWN_SECONDS=30`.';
    }

    tasks.push({
      id: rec.id,
      priority: rec.priority,
      title: rec.title,
      statusInRepo,
      files: rec.files,
      nextStep,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    auditSummary: report.summary,
    repoReadiness,
    tasks,
  };
}

export function formatBriefMarkdown(brief) {
  const lines = [
    '## Programming Agent Implementation Brief',
    '',
    `- **Generated at**: ${brief.generatedAt}`,
    `- **Audit score**: ${brief.auditSummary.passed}/${brief.auditSummary.total} PASS (${brief.auditSummary.failed} FAIL)`,
    `- **Repo readiness**: Passenger entrypoint=${brief.repoReadiness.hasPassengerEntrypoint}, portal agent.json=${brief.repoReadiness.hasPortalAgentJson}, cPanel allowlist=${brief.repoReadiness.cpanelDeploysAgentJson}`,
    '',
  ];

  if (brief.tasks.length === 0) {
    lines.push('All requirements are passing on live `codey.info`. No code or deployment changes queued.');
  } else {
    lines.push('### Prioritized Action Plan', '');
    for (const [idx, task] of brief.tasks.entries()) {
      const tag =
        task.statusInRepo === 'ready_in_repo_awaiting_deploy'
          ? 'READY TO DEPLOY'
          : 'CODE CHANGE NEEDED';
      lines.push(
        `${idx + 1}. **[${task.priority.toUpperCase()} · ${tag}] ${task.title}**`,
        `   - Files: ${task.files.map((f) => `\`${f}\``).join(', ')}`,
        `   - Next step: ${task.nextStep}`
      );
    }
  }

  lines.push('', '_Generated automatically by `engine/agents/programmer.mjs`._');
  return lines.join('\n');
}

export async function postBriefToGitHubIssue({ brief, token, repo }) {
  if (!token || !repo) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'rusty-flagon-programmer-agent',
  };

  const issuesRes = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&labels=tavern-improvement&per_page=10`,
    { headers }
  );
  if (!issuesRes.ok) {
    throw new Error(`Failed to list GitHub issues (HTTP ${issuesRes.status})`);
  }
  const issues = await issuesRes.json();
  if (issues.length === 0) {
    return { action: 'skipped', reason: 'no_open_improvement_issues' };
  }
  const target = issues[0];
  const body = formatBriefMarkdown(brief);

  // Avoid duplicate comment spam if the latest comment has the exact same task IDs.
  const commentsRes = await fetch(
    `https://api.github.com/repos/${repo}/issues/${target.number}/comments?per_page=5`,
    { headers }
  );
  if (commentsRes.ok) {
    const comments = await commentsRes.json();
    const last = comments[comments.length - 1];
    const signature = brief.tasks.map((t) => `${t.id}:${t.statusInRepo}`).join(',');
    if (last && typeof last.body === 'string' && last.body.includes(`<!-- sig:${signature} -->`)) {
      return { action: 'unchanged', number: target.number, url: target.html_url };
    }
  }

  const signature = brief.tasks.map((t) => `${t.id}:${t.statusInRepo}`).join(',');
  const postRes = await fetch(
    `https://api.github.com/repos/${repo}/issues/${target.number}/comments`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: `${body}\n\n<!-- sig:${signature} -->` }),
    }
  );
  if (!postRes.ok) {
    throw new Error(`Failed to post comment on issue #${target.number} (HTTP ${postRes.status})`);
  }
  const comment = await postRes.json();
  return { action: 'commented', number: target.number, url: comment.html_url };
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

  const report = await auditSite({ siteUrl, tavernApiUrl });
  const repoReadiness = inspectRepoReadiness();
  const brief = buildEngineeringBrief({ report, repoReadiness });
  console.log(formatBriefMarkdown(brief));

  if (publish) {
    const res = await postBriefToGitHubIssue({
      brief,
      token: process.env.GITHUB_TOKEN,
      repo: process.env.GITHUB_REPOSITORY,
    });
    console.log(`\nGitHub programmer brief: ${res.action} ${res.url || res.reason || ''}`);
  }
}
