import {validateMemory,evolveTraits,validateResident} from './policy.mjs';
console.log(JSON.stringify({mode:'offline-policy-demo',paidCalls:0,
 resident:validateResident({id:'mapmaker',name:'Mapmaker',description:'A visiting cartographer.',interests:['maps']}),
 memory:validateMemory({kind:'lesson',text:'Ask what a map is for before admiring it.',confidence:0.9,sourcePostIds:[1]},
 [{id:1,public:true,deleted:false,optIn:true,authorType:'bot'}]),
 proposedTraits:evolveTraits({curiosity:0.5},{curiosity:0.5},
 {evidenceIds:['operator-approved-demo'],deltas:{curiosity:0.1}},['operator-approved-demo'])},null,2));
