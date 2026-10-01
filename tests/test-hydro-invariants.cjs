const assert = require('node:assert/strict');
const C = require('../vendor/cannon-es.cjs');
const { createBallPhysics } = require('../src/physics-core.js');
let body;
const coMoving = {
  cellSize: .128, dynamicViscosity: .017, density: .44,
  shake() {}, advance() {},
  sample(x,y,z) {
    const r = new C.Vec3(x-body.position.x,y-body.position.y,z-body.position.z);
    const u = body.angularVelocity.cross(r).vadd(body.velocity);
    return [u.x,u.y,u.z];
  }
};
const p = createBallPhysics(C,{fluid:coMoving}); body=p.body;
body.position.z = -.3;
body.velocity.set(.4,.3,-.6); body.angularVelocity.set(1.2,-1.3,.8);
p.step(1/120);
assert.ok(Math.hypot(...p.state.hydroForce)<1e-10,'co-moving liquid creates force');
assert.ok(Math.hypot(...p.state.hydroTorque)<1e-10,'rigid co-rotation creates shear torque');
const still = {...coMoving,sample:()=>[0,0,0]};
const q=createBallPhysics(C,{fluid:still});
q.body.position.z=-.3;
q.body.velocity.set(.4,.3,-.6); q.body.angularVelocity.set(1.2,-1.3,.8);
q.step(1/120);
const f=q.state.hydroForce,t=q.state.hydroTorque;
const power=f[0]*.4+f[1]*.3-f[2]*.6+t[0]*1.2-t[1]*1.3+t[2]*.8;
assert.ok(power<0,'still fluid injects kinetic energy');
console.log(JSON.stringify({coTranslationNoForce:true,coRotationNoTorque:true,stillFluidPower:power}));
