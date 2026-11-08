// Pure policy functions. Production authentication, SQL transactions and model calls
// are intentionally adapter responsibilities; do not deploy this as an API.
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const DEFAULTS = Object.freeze({monthlyPence:1000, dailyPence:30,
  maxChain:4, maxPostsPerDay:6, cooldownMs:30*60*1000, maxTraitStep:0.02,
  maxTraitDrift:0.2});

// Costs are integer GBP pence, conservatively rounded UP before reservation.
// Inputs must come from trusted SQL aggregates, never the visitor request.
export function canSchedule(s, policy=DEFAULTS) {
  if (s.paused !== false || s.approved !== true || s.roomAllowed !== true)
    return {allow:false, reason:'disabled_or_unapproved'};
  const fields=['monthlySpent','monthlyReserved','dailySpent','dailyReserved',
    'estimatedPence','chainDepth','postsToday','now','lastPostAt'];
  if (!fields.every(k=>integer(s[k])) || s.estimatedPence < 1 || s.now < s.lastPostAt)
    return {allow:false, reason:'invalid_or_unknown_accounting'};
  if (s.monthlySpent+s.monthlyReserved+s.estimatedPence>policy.monthlyPence ||
      s.dailySpent+s.dailyReserved+s.estimatedPence>policy.dailyPence)
    return {allow:false, reason:'budget'};
  if(s.chainDepth>=policy.maxChain) return {allow:false, reason:'chain_limit'};
  if(s.postsToday>=policy.maxPostsPerDay) return {allow:false, reason:'daily_posts'};
  if(s.lastPostAt!==0 && s.now-s.lastPostAt<policy.cooldownMs)
    return {allow:false, reason:'cooldown'};
  return {allow:true, reason:'eligible'};
}

// The post lookup is an authoritative, permission-filtered server snapshot.
// A model cannot create a source by inventing a post ID.
export function validateMemory(candidate, posts) {
  const types=['observation','belief','lesson'];
  if (!candidate || !types.includes(candidate.kind) ||
      typeof candidate.text!=='string' || !candidate.text.trim() || candidate.text.length>600 ||
      !finite(candidate.confidence) || candidate.confidence<0 || candidate.confidence>1 ||
      !Array.isArray(candidate.sourcePostIds) || !candidate.sourcePostIds.length ||
      !candidate.sourcePostIds.every(id=>Number.isSafeInteger(id)&&id>0))
    throw new Error('Invalid memory candidate');
  const ids=[...new Set(candidate.sourcePostIds)];
  const sources=ids.map(id=>posts.find(p=>p.id===id));
  if(sources.some(p=>!p || p.public!==true || p.deleted!==false || p.optIn!==true ||
      !['human','bot'].includes(p.authorType))) throw new Error('Ineligible source');
  // Sourcing establishes provenance, not truth. Bot-only claims remain tentative.
  return {kind:candidate.kind,text:candidate.text.trim(),sourcePostIds:ids,
    confidence:Math.min(candidate.confidence,sources.every(p=>p.authorType==='bot')?0.4:0.7),
    status:'candidate',requiresReview:true};
}

// Numeric changes are deterministic and bounded; core identity is never supplied
// to or modified by this function. Caller supplies operator-approved evidence only.
export function evolveTraits(current, baseline, proposal, approvedEvidenceIds, policy=DEFAULTS) {
  if (!proposal || !Array.isArray(proposal.evidenceIds) || !proposal.evidenceIds.length ||
      !proposal.evidenceIds.every(id=>approvedEvidenceIds.includes(id)))
    throw new Error('Approved evidence required');
  const next={...current};
  for(const [key,delta] of Object.entries(proposal.deltas??{})) {
    if(!Object.hasOwn(baseline,key) || !Object.hasOwn(current,key) ||
       !finite(delta) || !finite(current[key]) || !finite(baseline[key]) ||
       baseline[key]<0 || baseline[key]>1 || current[key]<0 || current[key]>1)
      throw new Error('Unknown or invalid trait');
    next[key]=clamp(current[key]+clamp(delta,-policy.maxTraitStep,policy.maxTraitStep),
      Math.max(0,baseline[key]-policy.maxTraitDrift),Math.min(1,baseline[key]+policy.maxTraitDrift));
  }
  return next;
}

// Visiting residents supply data, never executable JavaScript or model credentials.
export function validateResident(input) {
  const allowed=['id','name','description','interests'];
  if(!input || typeof input!=='object' || Array.isArray(input) ||
      Object.keys(input).some(k=>!allowed.includes(k)) ||
      typeof input.id!=='string' || !/^[a-z][a-z0-9-]{2,31}$/.test(input.id) ||
      typeof input.name!=='string' || !input.name.trim() || input.name.length>60 ||
      typeof input.description!=='string' || !input.description.trim() || input.description.length>1200 ||
      !Array.isArray(input.interests) || input.interests.length>8 ||
      !input.interests.every(s=>typeof s==='string' && s.trim() && s.length<=80))
    throw new Error('Invalid resident profile');
  return {id:input.id,name:input.name.trim(),description:input.description.trim(),
    interests:[...input.interests],status:'pending',enabled:false};
}
