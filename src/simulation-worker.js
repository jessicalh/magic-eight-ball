// The worker owns all rigid-body and fluid state. Rendering never advances it.
let simulation=null,fluid=null,bubbles=null,timer=null,paused=false,failed=false;
let nextTick=0,warm=0,commandId=0,running=false;
let tickPending=false,scheduleGeneration=0;
const stepSeconds=1/60;
// A zero-delay timer can acquire a substantial scheduling floor. An overdue
// step instead gets one message task, yielding between complete fixed steps.
// Future deadlines still use timers, so a fast solver never busy-spins.
const tickChannel=new MessageChannel();
tickChannel.port1.onmessage=({data:generation})=>runScheduledTick(generation);
function cancelTick(){
  scheduleGeneration++;
  if(timer!==null)clearTimeout(timer);
  timer=null;tickPending=false;
}
function fail(error){
  failed=true;running=false;cancelTick();
  self.postMessage({kind:'error',message:error.message,stack:error.stack});
}
function scheduleTick(delay=0){
  if(tickPending||paused||failed||!simulation)return;
  tickPending=true;
  const generation=scheduleGeneration;
  if(delay>0)timer=setTimeout(()=>runScheduledTick(generation),delay);
  else tickChannel.port2.postMessage(generation);
}
function runScheduledTick(generation){
  if(generation!==scheduleGeneration||!tickPending)return;
  timer=null;tickPending=false;
  if(paused||failed||!simulation)return;
  try{tick();}catch(error){fail(error);}
}
function upright(index){
  simulation.resetFace(index,0);
  const top=simulation.body.quaternion.vmult(simulation.vertices[simulation.faces[index][0]]);
  simulation.resetFace(index,Math.PI/2-Math.atan2(top.y,top.x));
  fluid.clear();
}
function snapshot(kind='state',motion=0){
  const p=simulation.body.position,q=simulation.body.quaternion;
  const face=simulation.readFace();
  self.postMessage({kind,commandId,time:simulation.state.elapsed,
    position:[p.x,p.y,p.z],quaternion:[q.x,q.y,q.z,q.w],
    bubbles:Array.from(bubbles.packed),face,
    state:{settledFor:simulation.state.settledFor,seed:simulation.state.seed,fluidEnergy:fluid.state.energy},
    running,
    ...(kind==='ready'?{vertices:simulation.vertices.map(v=>({x:v.x,y:v.y,z:v.z})),faces:simulation.faces}:{}),
  });
}
function wake(){
  warm=1.6;
  if(paused||failed||tickPending)return;
  running=true;nextTick=performance.now();scheduleTick();
}
function tick(){
  if(paused||!simulation)return;
  const face=simulation.step(stepSeconds);
  const motion=bubbles.update(stepSeconds);
  warm=Math.max(0,warm-stepSeconds);
  running=warm>0||face.speed>.015||(face.settled&&simulation.state.settledFor<.6)||fluid.state.energy>.0001||motion>.00002;
  snapshot('state',motion);
  if(running){
    nextTick+=stepSeconds*1000;
    const now=performance.now();
    if(nextTick<now-150)nextTick=now;
    scheduleTick(Math.max(0,nextTick-now));
  }
}
self.onmessage=({data})=>{
  try{
    if(failed)return;
    if(data.type==='init'){
      cancelTick();
      fluid=createFluidField();simulation=createBallPhysics(CANNON,{seed:data.seed,fluid});
      upright(data.face);bubbles=createMicrobubbles(CANNON,simulation,fluid,data.seed);
      snapshot('ready');wake();return;
    }
    if(!simulation)return;
    commandId=Math.max(commandId,data.id||0);
    if(data.type==='kick')simulation.kick(data.strength);
    else if(data.type==='excite')simulation.excite(data.x,data.y,data.strength);
    else if(data.type==='gravity')simulation.world.gravity.set(data.x,data.y,data.z);
    else if(data.type==='restore'){
      cancelTick();
      fluid=createFluidField();simulation=createBallPhysics(CANNON,{seed:data.seed,fluid});
      upright(data.face);bubbles=createMicrobubbles(CANNON,simulation,fluid,data.seed);snapshot('restore');
    } else if(data.type==='pause'){
      paused=data.paused;
      if(paused){cancelTick();running=false;return;}
    }
    wake();
  }catch(error){fail(error);}
};
