function createSimulationClient(source,seed,initialFace,onChange,onError){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    let worker;
    try{worker=new Worker(url);}catch(error){URL.revokeObjectURL(url);reject(error);return;}
    URL.revokeObjectURL(url);
    let ready=false,destroyed=false,inputId=0;
    let latest=null,samples=[],lastRunning=false,paused=false;
    // Source time can progress slower than wall time when a fluid solve is
    // expensive. Follow its measured rate instead of repeatedly exhausting a
    // fixed interpolation buffer. Never extrapolate a pose through a collision.
    const clock={time:null,wall:null,primeUntil:0,rate:.25,sourceRate:.25,gap:.06,arrivals:[]};
    const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
    function restartClock(now,time=clock.time){
      clock.time=time;clock.wall=now;clock.primeUntil=now+180;clock.arrivals=[];
    }
    function noteArrival(data,now){
      const arrivals=clock.arrivals,previous=arrivals[arrivals.length-1];
      const elapsed=previous?Math.max(0,(now-previous.wall)/1000):0;
      if(previous&&data.time>previous.time&&elapsed>0){
        clock.gap=Math.max(Math.min(.5,elapsed),clock.gap*Math.exp(-elapsed/1.5));
      }
      arrivals.push({wall:now,time:data.time});
      while(arrivals.length>2&&arrivals[1].wall<now-900)arrivals.shift();
      const first=arrivals[0],span=(now-first.wall)/1000;
      if(span>=.08&&data.time>first.time){
        const measured=clamp((data.time-first.time)/span,.01,1);
        clock.sourceRate+=(measured-clock.sourceRate)*(1-Math.exp(-elapsed/.25));
      }
    }
    function playbackTime(now){
      if(clock.time===null)restartClock(now,samples[0].time);
      const dt=clock.wall===null?0:clamp((now-clock.wall)/1000,0,.05);
      clock.wall=now;
      clock.time=Math.max(samples[0].time,Math.min(latest.time,clock.time));
      if(paused||now<clock.primeUntil)return clock.time;
      const buffered=Math.max(0,latest.time-clock.time);
      if(!latest.running){
        // Drain the last buffered poses to the exact final state, then sleep.
        clock.time+=Math.min(buffered,Math.max(.1,clock.sourceRate)*dt);
      }else{
        const cushion=clamp(clock.gap*2.5,.18,.45);
        const wanted=Math.max(1/30,clock.sourceRate*cushion);
        const desired=clamp(clock.sourceRate+(buffered-wanted)/.7,0,1.15);
        clock.rate+=(desired-clock.rate)*(1-Math.exp(-dt/.16));
        // An unexpected stall slows the clock continuously instead of freezing
        // at the newest pose, or inventing future rigid-body motion.
        const available=buffered*(1-Math.exp(-dt/.07));
        clock.time+=Math.min(available,clock.rate*dt);
      }
      return clock.time;
    }
    const client={
      body:{position:{x:0,y:0,z:0},quaternion:{x:0,y:0,z:0,w:1}},
      vertices:[],faces:[],state:{settledFor:0,seed,fluidEnergy:0},
      bubbles:new Float32Array(48),running:false,
      kick:strength=>send('kick',{strength},true),
      excite:(x,y,strength)=>send('excite',{x,y,strength},true),
      restoreFace:(face,nextSeed)=>send('restore',{face,seed:nextSeed},true),
      gravity:[0,0,1.65],
      setGravity(x,y,z){
        if(Math.abs(x-this.gravity[0])+Math.abs(y-this.gravity[1])+Math.abs(z-this.gravity[2])<.0005)return;
        this.gravity=[x,y,z];send('gravity',{x,y,z});
      },
      setPaused(value){if(paused!==value){paused=value;restartClock(performance.now());send('pause',{paused:value});}},
      wake(){if(paused)this.setPaused(false);else send('pause',{paused:false});},
      destroy(){destroyed=true;worker.terminate();samples=[];},
      update(now){
        if(!latest)return {index:0,settled:false,speed:0,windowDistance:0};
        const target=playbackTime(now);
        while(samples.length>2&&samples[1].time<target)samples.shift();
        const a=samples[0],b=samples[Math.min(1,samples.length-1)];
        const mix=b.time>a.time?Math.max(0,Math.min(1,(target-a.time)/(b.time-a.time))):1;
        for(let axis=0;axis<3;axis++)this.body.position[['x','y','z'][axis]]=a.position[axis]+(b.position[axis]-a.position[axis])*mix;
        const qa=a.quaternion,qb=b.quaternion;
        let dot=qa.reduce((sum,v,i)=>sum+v*qb[i],0),sign=dot<0?-1:1;
        dot=Math.abs(dot);let wa=1-mix,wb=mix;
        if(dot<.9995){const angle=Math.acos(Math.min(1,dot)),den=Math.sin(angle);wa=Math.sin((1-mix)*angle)/den;wb=Math.sin(mix*angle)/den;}
        const q=qa.map((v,i)=>wa*v+wb*qb[i]*sign),norm=Math.hypot(...q);
        ['x','y','z','w'].forEach((key,i)=>{this.body.quaternion[key]=q[i]/norm;});
        for(let i=0;i<48;i++)this.bubbles[i]=a.bubbles[i]+(b.bubbles[i]-a.bubbles[i])*mix;
        const visible=mix<.5?a:b;
        this.state={...visible.state};
        if(visible.commandId<inputId)this.state.settledFor=0;
        this.running=latest.running||target<latest.time-.001;
        return visible.commandId<inputId?{...visible.face,settled:false,speed:1}:visible.face;
      }
    };
    function send(type,payload={},invalidate=false){
      if(destroyed)return;
      if(invalidate){inputId++;client.running=true;client.state.settledFor=0;}
      worker.postMessage({type,...payload,id:inputId});
      onChange?.();
    }
    worker.onerror=event=>{client.destroy();const error=new Error(event.message||'Simulation worker failed.');if(!ready)reject(error);else onError?.(error);};
    worker.onmessage=({data})=>{
      if(destroyed)return;
      if(data.kind==='error'){client.destroy();const error=new Error(data.message);if(!ready)reject(error);else onError?.(error);return;}
      const now=performance.now();
      if(data.kind==='ready'||data.kind==='restore'){
        samples=[];restartClock(now,data.time);
      }
      if(data.kind==='ready'){
        ready=true;client.vertices=data.vertices;client.faces=data.faces;
      }
      if(!lastRunning&&data.running)restartClock(now);
      if(!paused)noteArrival(data,now);
      latest=data;lastRunning=data.running;
      samples.push(data);if(samples.length>90)samples.shift();
      client.running=data.running;
      if(data.kind==='ready'){client.update(performance.now());resolve(client);}
      onChange?.();
    };
    worker.postMessage({type:'init',seed,face:initialFace});
  });
}
