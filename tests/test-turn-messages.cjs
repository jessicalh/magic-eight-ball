// Exercise the authored interface as a whole. Rendering and the simulation
// boundary are mocked; the real turn handler, frame loop, atlas layout and
// widget-state handlers execute in the VM unchanged.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../src/interface.html'),'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace('/* WORKER_SOURCE */','"mock-worker"')
  .replace('/* FRAGMENT_SHADER */','"mock-fragment-shader"')
  .replace('/* SIMULATION_CLIENT */','');

function eventTarget(){
  const listeners=new Map(),classes=new Set();
  return {
    attributes:{},dataset:{},textContent:'',disabled:false,
    classList:{add:(...names)=>names.forEach(name=>classes.add(name)),
      remove:(...names)=>names.forEach(name=>classes.delete(name))},
    setAttribute(name,value){this.attributes[name]=value;},
    addEventListener(name,handler){
      if(!listeners.has(name))listeners.set(name,new Set());
      listeners.get(name).add(handler);
    },
    removeEventListener(name,handler){listeners.get(name)?.delete(handler);},
    dispatchEvent(event){
      for(const handler of [...(listeners.get(event.type)||[])])handler(event);
    }
  };
}

async function createApp(privateContent){
  let now=0,nextRaf=0,nextTexture=0,activeUnit=0;
  const raf=new Map(),uploads=[],textures=[],writes=[],errors=[],bound=new Map();
  const caption=eventTarget(),loading=eventTarget(),button=eventTarget();
  const canvas=eventTarget(),root=eventTarget(),document=eventTarget(),window=eventTarget();
  root.isConnected=true;document.hidden=false;document.body=eventTarget();
  root.querySelector=selector=>{
    const elements={'canvas':canvas,'.eight-caption':caption,'.eight-loading':loading,
      '[data-action="turn"]':button};
    assert.ok(elements[selector],'unexpected selector: '+selector);
    return elements[selector];
  };
  document.getElementById=id=>id==='magic-eight-laboratory'?root:null;
  const captures=new Set();
  canvas.getBoundingClientRect=()=>({left:0,top:0,width:475,height:475});
  canvas.setPointerCapture=id=>captures.add(id);
  canvas.hasPointerCapture=id=>captures.has(id);
  canvas.releasePointerCapture=id=>captures.delete(id);

  function makeImage(){
    const image={width:0,height:0};
    const context={font:'',draws:[],clears:[],
      clearRect(x,y,width,height){this.draws=[];this.clears.push({x,y,width,height});},
      fillRect(){},
      fillText(text,x,y){this.draws.push({text,x,y});},
      measureText(text){
        const size=Number(this.font.match(/(\d+)px/)?.[1]||44);
        const half=text.length*size*.26;
        return {actualBoundingBoxLeft:half,actualBoundingBoxRight:half,
          actualBoundingBoxAscent:size*.75,actualBoundingBoxDescent:size*.2};
      }
    };
    image.context=context;image.getContext=()=>context;return image;
  }
  document.createElement=tag=>{assert.equal(tag,'canvas');return makeImage();};
  function upload(method,args){
    const image=args.at(-1);
    uploads.push({method,time:now,texture:bound.get(activeUnit),unit:activeUnit,
      width:image.width,height:image.height,draws:structuredClone(image.context.draws),
      clears:structuredClone(image.context.clears)});
  }
  const gl={
    createShader:()=>({}),createProgram:()=>({}),createBuffer:()=>({}),
    getShaderParameter:()=>true,getProgramParameter:()=>true,getAttribLocation:()=>0,
    getUniformLocation:(_program,name)=>name,
    createTexture(){const texture={id:++nextTexture};textures.push(texture);return texture;},
    activeTexture(unit){activeUnit=unit;},bindTexture(_target,texture){bound.set(activeUnit,texture);},
    texImage2D(...args){upload('image',args);},texSubImage2D(...args){upload('subimage',args);},
    uniformMatrix3fv(name,_transpose,value){if(name==='uBall')this.ballMatrix=Array.from(value);}
  };
  for(const [index,name] of ['VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS',
    'ARRAY_BUFFER','STATIC_DRAW','FLOAT','TEXTURE0','TEXTURE_2D','UNPACK_FLIP_Y_WEBGL',
    'RGBA','UNSIGNED_BYTE','TEXTURE_MIN_FILTER','LINEAR_MIPMAP_LINEAR','TEXTURE_MAG_FILTER',
    'LINEAR','TEXTURE_WRAP_S','TEXTURE_WRAP_T','CLAMP_TO_EDGE','TRIANGLES'].entries())gl[name]=index+100;
  for(const name of ['shaderSource','compileShader','attachShader','linkProgram','useProgram',
    'bindBuffer','bufferData','enableVertexAttribArray','vertexAttribPointer','uniform3fv',
    'uniform3iv','pixelStorei','texParameteri','generateMipmap','uniform1i','viewport',
    'uniform2f','uniform3f','uniform1f','uniform4fv','drawArrays','deleteTexture',
    'deleteShader','deleteProgram','deleteBuffer'])gl[name]=()=>{};
  canvas.getContext=type=>{assert.equal(type,'webgl2');return gl;};

  const physics={
    body:{position:{x:0,y:0,z:1},quaternion:{x:0,y:0,z:0,w:1}},
    vertices:[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:0,y:1,z:0}],
    faces:Array.from({length:20},()=>[0,1,2]),
    bubbles:new Float32Array(48),state:{seed:42,settledFor:1,fluidEnergy:0},running:false,
    wakeCalls:0,exciteCalls:0,restores:[],
    wake(){this.wakeCalls++;},excite(){this.exciteCalls++;},
    setGravity(){},setPaused(){},destroy(){},
    restoreFace(face,seed){this.restores.push({face,seed});},
    update:()=>({index:7,settled:true,speed:0,windowDistance:0})
  };
  window.openai={
    widgetState:{privateContent:structuredClone(privateContent)},
    setWidgetState(value){
      const copy=structuredClone(value);writes.push({time:now,...copy});
      this.widgetState=copy;
      // The standalone bridge echoes state synchronously, before persistence.
      window.dispatchEvent({type:'openai:set_globals',detail:{globals:{widgetState:copy}}});
      return Promise.resolve();
    }
  };
  class Observer{observe(){}disconnect(){}}
  const context={window,document,console:{error:error=>errors.push(error)},
    performance:{now:()=>now},devicePixelRatio:1,
    crypto:{getRandomValues:array=>array.fill(42)},
    matchMedia:()=>({...eventTarget(),matches:false}),
    ResizeObserver:Observer,IntersectionObserver:Observer,MutationObserver:Observer,
    requestAnimationFrame:callback=>{raf.set(++nextRaf,callback);return nextRaf;},
    cancelAnimationFrame:id=>raf.delete(id),
    createSimulationClient:async()=>physics};
  vm.createContext(context);await vm.runInContext(source,context);
  assert.equal(root.dataset.ready,'true',String(errors[0]||'interface did not initialize'));

  function step(ms){
    now+=ms;const callbacks=[...raf.values()];raf.clear();
    for(const callback of callbacks)callback(now);
    assert.equal(errors.length,0,String(errors[0]));
  }
  function advance(ms){while(ms>0){const delta=Math.min(50,ms);step(delta);ms-=delta;}}
  step(0);
  return {gl,uploads,textures,writes,physics,button,caption,canvas,advance,step,
    get now(){return now;},
    click(){button.dispatchEvent({type:'click'});},
    echo(state){window.dispatchEvent({type:'openai:set_globals',
      detail:{globals:{widgetState:{privateContent:state}}}});},
    atlasUploads(){return uploads.filter(upload=>upload.width===2560&&upload.height===2048);}
  };
}

function tileMessages(upload){
  const tiles=Array.from({length:20},()=>[]);
  for(const draw of upload.draws){
    const column=Math.floor(draw.x/512),row=Math.floor(draw.y/512);
    assert.ok(column>=0&&column<5&&row>=0&&row<4,'text escaped the atlas');
    tiles[row*5+column].push(draw.text);
  }
  assert.ok(tiles.every(lines=>lines.length>0),'some faces received no lettering');
  return tiles.map(lines=>lines.join(' '));
}

function expectAllFaces(app,message){
  assert.deepEqual(tileMessages(app.atlasUploads().at(-1)),Array(20).fill(message));
}

function crossMidpoint(app,expectedCount){
  const start=app.now,uploadsBefore=app.atlasUploads().length,writesBefore=app.writes.length;
  const wakesBefore=app.physics.wakeCalls;
  app.click();app.click(); // Deliberately invoke the disabled button's handler too.
  assert.equal(app.physics.wakeCalls,wakesBefore+1,'duplicate click started a second turn');
  app.advance(2099);
  assert.equal(app.atlasUploads().length,uploadsBefore,'lettering changed before facing away');
  assert.equal(app.writes.length,writesBefore,'counter persisted before the half turn');
  app.step(2); // First frame past t=0.5 of the existing 4.2-second turn.
  assert.equal(app.writes.length,writesBefore+1,'counter was not persisted at the half turn');
  const midpoint=app.writes.at(-1);
  assert.equal(midpoint.time,start+2101);
  assert.equal(midpoint.privateContent.turnCount,expectedCount);
  assert.ok(app.gl.ballMatrix[0]<-.99999&&app.gl.ballMatrix[8]<-.99999,
    'window was not facing away when the new count was saved');
  return {start,uploadsBefore,midpoint};
}

(async()=>{
  const app=await createApp({face:3,seed:42,turnCount:99});
  const normal=tileMessages(app.atlasUploads()[0]);
  assert.equal(new Set(normal).size,20,'normal atlas did not retain all20 original answers');
  const atlasTexture=app.atlasUploads()[0].texture;
  let midpointState;
  for(const [count,message] of [[100,'You Are Free'],[101,'Go To Bed'],[102,'All will be well'],[103,null]]){
    const {uploadsBefore,midpoint}=crossMidpoint(app,count);
    const changed=app.atlasUploads().at(-1);
    assert.equal(app.atlasUploads().length,uploadsBefore+1,'message transition must upload once');
    assert.equal(changed.method,'subimage','existing atlas texture was reallocated');
    assert.equal(changed.texture,atlasTexture,'atlas texture identity changed');
    assert.deepEqual(changed.clears.at(-1),{x:0,y:0,width:2560,height:2048});
    assert.equal(changed.clears.length,uploadsBefore+1,'old text was not cleared before redraw');
    if(message){expectAllFaces(app,message);assert.equal(midpoint.modelContent.answer,message);}
    else assert.deepEqual(tileMessages(changed),normal,'turn103 did not restore original answers');
    if(count===100)midpointState=structuredClone(midpoint.privateContent);
    app.advance(2200);
    assert.equal(app.button.disabled,false,'full turn never finished');
    assert.equal(app.atlasUploads().length,uploadsBefore+1,'one turn changed messages twice');
    assert.equal(app.writes.at(-1).privateContent.turnCount,count,'settlement counted another turn');
    const writes=app.writes.length,restores=app.physics.restores.length;
    app.echo(app.writes.at(-1).privateContent);
    assert.equal(app.writes.length,writes,'own state echo wrote recursively');
    assert.equal(app.physics.restores.length,restores,'own state echo reset the simulation');
  }
  assert.equal(app.textures.length,2,'atlas updates allocated additional GL textures');

  const reload=await createApp(midpointState);
  expectAllFaces(reload,'You Are Free');
  crossMidpoint(reload,101);expectAllFaces(reload,'Go To Bed');
  for(const [count,message] of [[101,'Go To Bed'],[102,'All will be well']]){
    const restored=await createApp({face:7,seed:42,turnCount:count});
    expectAllFaces(restored,message);
  }
  const external=await createApp({face:7,seed:42,turnCount:99});
  external.echo({face:7,seed:42,turnCount:102});
  expectAllFaces(external,'All will be well');
  external.echo({face:7,seed:42,turnCount:103});
  assert.deepEqual(tileMessages(external.atlasUploads().at(-1)),normal,
    'state updates ignored a counter change with unchanged face and seed');

  const ordinary=await createApp({face:0,seed:42,turnCount:98});
  const ordinaryUploads=ordinary.atlasUploads().length;
  crossMidpoint(ordinary,99);
  assert.equal(ordinary.atlasUploads().length,ordinaryUploads,'ordinary turn needlessly rebuilt atlas');

  const dragged=await createApp({face:0,seed:42,turnCount:99});
  dragged.canvas.dispatchEvent({type:'pointerdown',pointerId:1,clientX:237,clientY:237});
  dragged.canvas.dispatchEvent({type:'pointermove',pointerId:1,clientX:277,clientY:237});
  dragged.step(16);
  dragged.canvas.dispatchEvent({type:'pointerup',pointerId:1,clientX:277,clientY:237});
  dragged.advance(4300);
  assert.ok(dragged.physics.exciteCalls>0,'drag did not exercise the existing input path');
  assert.equal(dragged.physics.wakeCalls,0,'drag incorrectly started a counted turn');
  assert.ok(dragged.writes.every(write=>write.privateContent.turnCount===99),'drag incremented count');
  assert.equal(dragged.atlasUploads().length,1,'drag changed face messages');

  for(const value of [undefined,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'100',100.5,null]){
    const invalid=await createApp({face:0,seed:42,turnCount:value});
    assert.deepEqual(tileMessages(invalid.atlasUploads()[0]),normal);
    crossMidpoint(invalid,1);
  }
  const legacy=await createApp({face:0,seed:42});crossMidpoint(legacy,1);
  const capped=await createApp({face:0,seed:42,turnCount:Number.MAX_SAFE_INTEGER});
  crossMidpoint(capped,Number.MAX_SAFE_INTEGER);

  console.log(JSON.stringify({all20FacesExact:true,normalAnswersReturnOn103:true,
    switchesOnlyAtFirstAwayMidpoint:true,sameTextureReusedAndCleared:true,
    ordinaryTurnsSkipAtlasUpload:true,duplicateClicksCountOnce:true,dragDoesNotCount:true,
    midpointStatePersists:true,reloadRestoresMessages:true,stateEchoDoesNotReset:true,
    counterOnlyStateChangesRestore:true,legacyAndInvalidCountersStartAtZero:true,
    maximumSafeCounterDoesNotOverflow:true},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
