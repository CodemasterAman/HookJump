const vm=require('vm'),fs=require('fs');
const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname+'/../extension/config.js','utf8')+';this.HOOKJUMP_CONFIG=HOOKJUMP_CONFIG;',ctx);
const Core=require(__dirname+'/../extension/rl-core.js'); const CFG=ctx.HOOKJUMP_CONFIG;
const assert=require('assert');
// heatmap: single segment, peak at x=600 of 1000 (60% through)
let d='M 0.0,100.0';
for(let x=10;x<=1000;x+=10){const y=100-80*Math.exp(-((x-600)**2)/(2*40**2))-5; d+=` C ${x-6},${y.toFixed(1)} ${x-3},${y.toFixed(1)} ${x}.0,${y.toFixed(1)}`;}
const n=40; // 200 s song
const heat=Core.parseHeatmap([{d,width:500,left:0}],n);
const peak=heat.indexOf(Math.max(...heat)); console.log('heat peak chunk',peak,'(expected ~24)'); assert(Math.abs(peak-24)<=1);
// chapters: two segments 300px + 200px, peak in second
const heat2=Core.parseHeatmap([{d:'M 0,90 C 500,90 900,90 1000,90',width:300,left:0},{d:'M 0,90 C 200,20 400,20 1000,90',width:200,left:303}],n);
console.log('chapter peak chunk',heat2.indexOf(1));
assert(heat2.indexOf(1)>24);
assert.strictEqual(Core.parseHeatmap([{d:'M 0,50 C 10,50 20,50 1000,50',width:10}],n),null);
// Q learning: user replays chunk 30, skips 5..20
const local=Core.emptyTable(n);
for(let ep=0;ep<3;ep++){ for(let c=5;c<20;c++) Core.update(local,c,-1,CFG.ALPHA); Core.update(local,30,2,CFG.ALPHA);Core.update(local,31,1,CFG.ALPHA);Core.update(local,32,0.5,CFG.ALPHA);}
const h=Core.pickHook(n,{local,global:null,heat:null},CFG,()=>0.99);
console.log('hook from user only',h.start,h.end); assert.strictEqual(h.start,30);
// combine with heat: user signal should dominate after learning, heat alone gives 24ish
const h2=Core.pickHook(n,{local:Core.emptyTable(n),global:null,heat},CFG,()=>0.99); console.log('hook from heat only',h2.start); assert(Math.abs(h2.start-23)<=2);
assert.strictEqual(Core.pickHook(n,{local:Core.emptyTable(n),global:null,heat:null},CFG),null);
// exploration
const h3=Core.pickHook(n,{local,global:null,heat:null},CFG,(()=>{let i=0;return()=>[0.01,0.9][i++%2]})()); console.log('explored',h3.explored,h3.start);
// fitTable
assert.strictEqual(Core.fitTable({q:[1,2],n:[1,1]},4).q.length,4);
console.log('ALL CORE TESTS PASSED');
