// Sparse trapped air, used as passive tracers of the actual computed liquid.
// Their tiny volume fraction does not feed back into the liquid pressure solve.
function createMicrobubbles(CANNON, physics, fluid, seed) {
  let randomState=seed>>>0;
  const random=()=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState/4294967296;};
  const bubbles=Array.from({length:8},(_,i)=>{
    const a=i*Math.PI/4+.1*random(),r=.63+.14*random();
    return {x:Math.cos(a)*r,y:Math.sin(a)*r,z:physics.ceiling-.09-.1*random(),r:.006+.005*random()};
  });
  const packed=new Float32Array(12*4);
  const inverse=new CANNON.Quaternion(),local=new CANNON.Vec3(),direction=new CANNON.Vec3();
  function update(dt) {
    physics.body.quaternion.conjugate(inverse);
    const gravity=physics.world.gravity;
    const gravityLength=gravity.length()||1;
    let motion=0;
    for(let i=0;i<bubbles.length;i++){
      const b=bubbles[i];
      const flow=fluid.sample(b.x,b.y,b.z);
      const rise=.13*(b.r/.008)**2;
      const vx=flow[0]+rise*gravity.x/gravityLength;
      const vy=flow[1]+rise*gravity.y/gravityLength;
      const vz=flow[2]+rise*gravity.z/gravityLength;
      const oldX=b.x,oldY=b.y,oldZ=b.z;
      b.x+=vx*dt;b.y+=vy*dt;b.z+=vz*dt;
      for(let iteration=0;iteration<5;iteration++){
        for(const plane of physics.boundaryPlanes){
          const n=plane.normal;
          const overlap=n[0]*b.x+n[1]*b.y+n[2]*b.z-plane.offset+b.r+.005;
          if(overlap>0){b.x-=n[0]*overlap;b.y-=n[1]*overlap;b.z-=n[2]*overlap;}
        }
        local.set(b.x-physics.body.position.x,b.y-physics.body.position.y,b.z-physics.body.position.z);
        inverse.vmult(local,local);
        let outside=false,best=-Infinity,chosen=-1;
        for(let k=0;k<physics.normals.length;k++){
          const d=physics.normals[k].dot(local)-physics.inradius-b.r;
          if(d>=0){outside=true;break;}
          physics.body.quaternion.vmult(physics.normals[k],direction);
          // At a face/window contact, evacuate gas sideways, not into the glass.
          const upperBlocked=b.z>physics.ceiling-.05&&direction.z>.65;
          const lowerBlocked=b.z<physics.floor+.05&&direction.z<-.65;
          if(!upperBlocked&&!lowerBlocked&&d>best){best=d;chosen=k;}
        }
        if(!outside&&chosen>=0){
          physics.body.quaternion.vmult(physics.normals[chosen],direction);
          b.x-=direction.x*(best-.001);b.y-=direction.y*(best-.001);b.z-=direction.z*(best-.001);
        }
      }
      motion=Math.max(motion,Math.hypot(b.x-oldX,b.y-oldY,b.z-oldZ));
      packed.set([b.x,b.y,b.z,b.r],i*4);
    }
    return motion;
  }
  update(0);
  return {update,packed,bubbles};
}
