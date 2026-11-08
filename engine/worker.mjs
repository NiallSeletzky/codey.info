import { canSchedule } from './policy.mjs';

const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const published = (value) => value?.status === 'published' &&
  Number.isSafeInteger(value.postId) && value.postId > 0;

// One job only. No autonomous loop or implicit retries. The gateway is authoritative.
export async function runTick({ gateway, generator }) {
  if (!Number.isSafeInteger(generator?.maximumPence) || generator.maximumPence < 1) {
    throw new Error('Generator must declare a positive maximum cost in pence');
  }
  const { job } = await gateway.claim();
  if (job === null) return { status: 'idle' };
  if (!job || ![job.id, job.leaseToken, job.publicationKey].every(identifier) ||
      !['mara', 'aldric'].includes(job.characterId)) throw new Error('Invalid claimed job');
  // Account IDs and topic IDs are deliberately absent: PHP maps them from this job.
  const lease = { jobId: job.id, leaseToken: job.leaseToken, publicationKey: job.publicationKey };
  const context = await gateway.context(lease);
  if (!context.policyState || !Array.isArray(context.posts) || context.posts.length > 20 ||
      context.posts.some(p => !Number.isSafeInteger(p.id) || p.id < 1 ||
        typeof p.text !== 'string' || p.text.length > 4000)) throw new Error('Invalid job context');
  const eligibility = canSchedule({ ...context.policyState, estimatedPence: generator.maximumPence });
  if (!eligibility.allow) return { status: 'blocked', reason: eligibility.reason };
  const reservation = await gateway.reserve(lease, generator.maximumPence);
  if (reservation.status !== 'reserved' || reservation.maximumPence !== generator.maximumPence) {
    return { status: 'blocked', reason: 'reservation_denied' };
  }

  let output;
  try {
    output = await generator.generate({ characterId: job.characterId, posts: context.posts });
  } catch {
    return { status: 'reconciliation_required', reason: 'generation_outcome_unknown' };
  }
  if (!output || !Number.isSafeInteger(output.actualPence) || output.actualPence < 0 ||
      output.actualPence > generator.maximumPence ||
      !(output.text === null || (typeof output.text === 'string' && output.text.trim() && output.text.length <= 2000))) {
    return { status: 'reconciliation_required', reason: 'invalid_generation_result' };
  }
  let receipt = null;
  if (output.text !== null) {
    try {
      receipt = await gateway.publish(lease, output.text.trim());
    } catch (error) {
      if ([401, 403].includes(error.status)) {
        return { status: 'reconciliation_required', reason: 'publication_permission_denied' };
      }
      // Publication may have succeeded before the connection broke. Query; never repost.
    }
    if (!published(receipt)) {
      try { receipt = await gateway.publication(lease); } catch { /* Keep uncertain reservation. */ }
    }
    if (!published(receipt)) return { status: 'reconciliation_required', reason: 'publication_outcome_unknown' };
  }
  try {
    const done = await gateway.complete(lease, {
      actualPence: output.actualPence, postId: receipt?.postId ?? null,
      outcome: receipt ? 'published' : 'silence',
    });
    if (done.status !== 'completed') throw new Error('Completion not confirmed');
  } catch {
    return { status: 'reconciliation_required', reason: 'completion_outcome_unknown', postId: receipt?.postId ?? null };
  }
  return { status: receipt ? 'published' : 'silent', postId: receipt?.postId ?? null };
}
