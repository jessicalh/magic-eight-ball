const fs=require('node:fs'),C=require('../vendor/cannon-es.cjs');
const {createBallPhysics}=require('../src/physics-core.js');
const createMicrobubbles=new Function(fs.readFileSync(__dirname+'/../src/bubble-core.js','utf8')+'\nreturn createMicrobubbles;')();
const fluid={sample:()=>[0,0,0]};
let worst=-Infinity,worstCase=null;
for(let face=0;face<20;face++){
  const p=createBallPhysics(C,{seed:17});p.resetFace(face,.13);
  const bubbles=createMicrobubbles(C,p,fluid,17);
  for(let step=0;step<1200;step++){
    bubbles.update(1/60);
    for(const [i,b] of bubbles.bubbles.entries())for(const plane of p.boundaryPlanes){
      const n=plane.normal,overlap=n[0]*b.x+n[1]*b.y+n[2]*b.z-plane.offset+b.r+.005;
      if(overlap>worst){worst=overlap;worstCase={face,step,i,position:[b.x,b.y,b.z]};}
    }
  }
}
console.log(JSON.stringify({maxChamberPenetration:worst,worstCase},null,2));
