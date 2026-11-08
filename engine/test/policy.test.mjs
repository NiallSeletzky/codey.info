import test from 'node:test';
import assert from 'node:assert/strict';
import {canSchedule,validateMemory,evolveTraits,validateResident} from '../policy.mjs';
const job=()=>({paused:false,approved:true,roomAllowed:true,monthlySpent:0,monthlyReserved:0,
 dailySpent:0,dailyReserved:0,estimatedPence:2,chainDepth:0,postsToday:0,now:2000000,lastPostAt:0});
test('eligible job and exact budget boundary',()=>{
 assert.equal(canSchedule(job()).allow,true);
 assert.equal(canSchedule({...job(),monthlySpent:998}).allow,true);
 assert.equal(canSchedule({...job(),monthlySpent:999}).reason,'budget');
});
test('outstanding reservations consume budget',()=>{
 assert.equal(canSchedule({...job(),monthlySpent:990,monthlyReserved:9}).reason,'budget');
 assert.equal(canSchedule({...job(),dailySpent:25,dailyReserved:5}).reason,'budget');
});
test('unknown, negative and non-finite accounting fails closed',()=>{
 for(const value of [undefined,NaN,Infinity,-1,0,0.1])
 assert.equal(canSchedule({...job(),estimatedPence:value}).allow,false);
});
test('pause, residency approval and room permissions are mandatory',()=>{
 for(const change of [{paused:true},{approved:false},{roomAllowed:false},{paused:undefined}])
 assert.equal(canSchedule({...job(),...change}).allow,false);
});
test('bounded bot loop, frequency and daily cap',()=>{
 assert.equal(canSchedule({...job(),chainDepth:4}).reason,'chain_limit');
 assert.equal(canSchedule({...job(),postsToday:6}).reason,'daily_posts');
 assert.equal(canSchedule({...job(),lastPostAt:1999999}).reason,'cooldown');
});
const posts=[{id:1,public:true,deleted:false,optIn:true,authorType:'bot'}];
const memory={kind:'lesson',text:'A claim needs a source.',confidence:0.95,sourcePostIds:[1,1]};
test('bot agreement cannot promote claims to verified knowledge',()=>{
 const result=validateMemory(memory,posts);
 assert.equal(result.confidence,0.4);assert.equal(result.status,'candidate');
 assert.deepEqual(result.sourcePostIds,[1]);assert.equal(result.requiresReview,true);
});
test('missing, private, deleted and non-opted-in memories rejected',()=>{
 assert.throws(()=>validateMemory({...memory,sourcePostIds:[9]},posts));
 for(const change of [{public:false},{deleted:true},{optIn:false}])
 assert.throws(()=>validateMemory(memory,[{...posts[0],...change}]));
});
test('memory rejects malformed source identifiers and unbounded text',()=>{
 assert.throws(()=>validateMemory({...memory,sourcePostIds:['1']},posts));
 assert.throws(()=>validateMemory({...memory,text:'x'.repeat(601)},posts));
});
test('trait changes need approved evidence and cannot alter unknown fields',()=>{
 assert.throws(()=>evolveTraits({curiosity:0.5},{curiosity:0.5},{evidenceIds:['x'],deltas:{}},[]));
 assert.throws(()=>evolveTraits({curiosity:0.5},{curiosity:0.5},{evidenceIds:['x'],deltas:{admin:1}},['x']));
});
test('trait changes bounded per step and cumulatively without mutating input',()=>{
 const current={curiosity:0.5};const baseline={curiosity:0.5};
 const p={evidenceIds:['x'],deltas:{curiosity:1}};
 assert.equal(evolveTraits(current,baseline,p,['x']).curiosity,0.52);
 let next=current;for(let i=0;i<100;i++)next=evolveTraits(next,baseline,p,['x']);
 assert.equal(next.curiosity,0.7);assert.equal(current.curiosity,0.5);
});
test('residency stays pending and rejects code or keys',()=>{
 const profile={id:'guest-one',name:'Guest',description:'Cartographer',interests:['maps']};
 assert.equal(validateResident(profile).enabled,false);
 for(const extra of [{code:'run()'},{apiKey:'secret'},{enabled:true}])
 assert.throws(()=>validateResident({...profile,...extra}));
});
