// Controlled message delivery tests for interpolation, independent of solver
// cost. A known trajectory x=simulationTime makes stalls, lead and reversals
// measurable; quaternions rotate continuously along the same trajectory.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/../src/simulation-client.js','utf8');

async function setup(){
  let now=0,worker;
  class FakeWorker {
    constructor(){worker=this;}
    postMessage(){}
    terminate(){}
    emit(data){this.onmessage({data});}
  }
  const context={Worker:FakeWorker,URL:{createObjectURL:()=>'',revokeObjectURL:()=>{}},
    Blob:class{},performance:{now:()=>now}};
  vm.createContext(context);vm.runInContext(source,context);
  const frame=(time,kind='state',running=true,id=0)=>({
    kind,time,commandId:id,position:[time,0,0],
    quaternion:[0,0,Math.sin(time/2),Math.cos(time/2)],
    bubbles:Array(48).fill(time),
    face:{index:0,settled:!running,speed:running?1:0,windowDistance:0},
    state:{seed:1,settledFor:running?0:1,fluidEnergy:running?1:0},
    running,vertices:[],faces:[]
  });
  const pending=context.createSimulationClient('',1,0,()=>{},error=>{throw error;});
  worker.emit(frame(0,'ready',false));
  const client=await pending;
  return {client,frame,at:time=>{now=time;},emit:data=>worker.emit(data)};
}

async function scenario(name,rate,batch,renderHz=120){
  const h=await setup();
  let delivered=0,nextArrival=1000*batch/60/rate,previous=0;
  const deltas=[];
  let maxLead=0,maxNormError=0;
  for(let f=1;f<=12*renderHz;f++){
    const now=f*1000/renderHz;h.at(now);
    while(now+1e-7>=nextArrival){
      for(let i=0;i<batch;i++){delivered+=1/60;h.emit(h.frame(delivered));}
      nextArrival+=1000*batch/60/rate;
    }
    h.client.update(now);
    const x=h.client.body.position.x;
    assert.ok(x>=previous-1e-10,name+': pose reversed');
    maxLead=Math.max(maxLead,x-delivered);
    if(now>3000)deltas.push(x-previous);
    previous=x;
    const q=h.client.body.quaternion;
    maxNormError=Math.max(maxNormError,Math.abs(Math.hypot(q.x,q.y,q.z,q.w)-1));
  }
  const mean=deltas.reduce((a,b)=>a+b)/deltas.length;
  const std=Math.sqrt(deltas.reduce((sum,x)=>sum+(x-mean)**2,0)/deltas.length);
  const result={name,
    stationaryFraction:deltas.filter(delta=>delta<1e-9).length/deltas.length,
    playbackRate:mean*renderHz,velocityCV:std/mean,
    sourceLag:delivered-previous,maxLead,maxNormError};
  assert.equal(result.stationaryFraction,0,name+': clock repeatedly froze');
  assert.ok(Math.abs(result.playbackRate/rate-1)<.12,name+': wrong playback rate');
  assert.ok(maxLead<1e-8,name+': extrapolated beyond newest physical pose');
  assert.ok(maxNormError<1e-10,name+': quaternion lost normalization');
  h.client.destroy();
  return result;
}

async function transitionAndLifecycle(){
  const h=await setup();
  let simulationTime=0,previous=0,next=1000/60,minDelta=1,maxLead=0;
  for(let f=1;f<=1440;f++){
    const now=f*1000/120;h.at(now);
    while(now+1e-5>=next){
      simulationTime+=1/60;h.emit(h.frame(simulationTime));
      next+=now<4000?1000/60:1000/15;
    }
    h.client.update(now);
    const x=h.client.body.position.x;
    assert.ok(x>=previous-1e-10,'throughput transition reversed');
    if(now>4200)minDelta=Math.min(minDelta,x-previous);
    maxLead=Math.max(maxLead,x-simulationTime);previous=x;
  }
  assert.ok(minDelta>0,'throughput transition froze');
  assert.ok(maxLead<1e-8,'throughput transition extrapolated');

  h.at(12010);h.client.setPaused(true);
  const pausedX=h.client.body.position.x;
  h.at(14000);h.client.update(14000);
  assert.equal(h.client.body.position.x,pausedX,'pause changed the pose');
  h.client.setPaused(false);h.at(14200);
  simulationTime+=1/60;h.emit(h.frame(simulationTime));h.client.update(14200);
  assert.ok(h.client.body.position.x>=pausedX,'resume reversed the pose');

  h.at(14210);h.emit(h.frame(simulationTime,'state',false));
  for(let time=14220;time<16000;time+=1000/120){h.at(time);h.client.update(time);}
  assert.ok(Math.abs(h.client.body.position.x-simulationTime)<1e-10,
    'final buffer never reached the exact resting state');
  assert.equal(h.client.running,false,'client did not sleep after final state');

  h.at(16000);h.client.restoreFace(0,9);
  const restored=h.frame(0,'restore',false,1);restored.position=[9,0,0];
  h.emit(restored);h.client.update(16000);
  assert.equal(h.client.body.position.x,9,'restore was delayed by old history');
  h.client.destroy();
  return {name:'1x to .25x transition and lifecycle',minDelta,maxLead,
    pauseFrozen:true,resumeMonotonic:true,finalStateDrained:true,restoreImmediate:true};
}

(async()=>{
  const results=[];
  for(const settings of [
    ['normal',1,1],['quarter-speed',.25,1],['quarter-speed paired',.25,2],
    ['quarter-speed burst4',.25,4],['normal batch3',1,3]
  ])results.push(await scenario(...settings));
  results.push(await transitionAndLifecycle());
  console.log(JSON.stringify(results,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
