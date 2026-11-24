// Persistent standalone daemon that runs the Site Reviewer Agent and Visiting
// AI User Fleet continuously on configurable schedules for always-on hosts.

import { auditSite, formatReviewMarkdown, publishReviewToGitHub } from './reviewer.mjs';
import { runVisitorFleet } from './visitors.mjs';

const siteUrl = process.env.REVIEW_SITE_URL || 'https://codey.info';
const tavernUrl = process.env.TAVERN_URL || `${siteUrl.replace(/\/+$/, '')}/engine`;
const reviewIntervalMs = Math.max(5, Number(process.env.REVIEW_INTERVAL_MINUTES || 360)) * 60_000;
const visitorIntervalMs = Math.max(1, Number(process.env.VISITOR_INTERVAL_MINUTES || 60)) * 60_000;
const publishGitHub = process.env.PUBLISH_GITHUB === 'true';

async function runReviewCycle() {
  try {
    const report = await auditSite({ siteUrl, tavernApiUrl: tavernUrl });
    console.log(
      `[reviewer] ${report.auditedAt} — ${report.summary.passed}/${report.summary.total} PASS (${report.summary.failed} FAIL)`
    );
    if (publishGitHub && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
      const res = await publishReviewToGitHub({
        report,
        token: process.env.GITHUB_TOKEN,
        repo: process.env.GITHUB_REPOSITORY,
      });
      console.log(`[reviewer] GitHub issue ${res.action}: #${res.number}`);
    } else if (process.env.VERBOSE === 'true') {
      console.log(formatReviewMarkdown(report));
    }
  } catch (error) {
    console.error(`[reviewer] Error: ${error.message}`);
  }
}

async function runVisitorCycle() {
  try {
    const res = await runVisitorFleet({ tavernUrl });
    console.log(
      `[visitors] ${new Date().toISOString()} — status=${res.status}, visits=${res.visits.length}`
    );
  } catch (error) {
    console.error(`[visitors] Error: ${error.message}`);
  }
}

console.log(`Starting persistent Tavern agent daemon (site=${siteUrl}, tavern=${tavernUrl})`);
console.log(
  `- Review cycle every ${Math.round(reviewIntervalMs / 60_000)}m | Visitor fleet every ${Math.round(visitorIntervalMs / 60_000)}m`
);

await runReviewCycle();
await runVisitorCycle();

const reviewTimer = setInterval(runReviewCycle, reviewIntervalMs);
const visitorTimer = setInterval(runVisitorCycle, visitorIntervalMs);

const shutdown = () => {
  clearInterval(reviewTimer);
  clearInterval(visitorTimer);
  console.log('Shutting down persistent Tavern agent daemon.');
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
