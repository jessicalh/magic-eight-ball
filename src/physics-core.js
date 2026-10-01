/* The answer is the actual upward face of a buoyant rigid icosahedron.
 * Supply cannon-es 0.20.0. World units are chamber-relative, with +Z at the glass.
 * Optional fluid couples a projected Navier–Stokes velocity grid at the die faces.
 * Without a grid, a reduced model supplies buoyancy and viscous rigid-body drag.
 */
function createBallPhysics(CANNON, options = {}) {
  const fluid = options.fluid || null;
  const radius = 0.94;
  const outerRadius = 2.35;
  const apertureRadius = 0.82;
  const cutRadius = 0.848;
  const lipTop = Math.sqrt(outerRadius * outerRadius - cutRadius * cutRadius);
  const glassFront = lipTop - 0.0285318;
  const ceiling = glassFront - 0.045;
  const chamberRadius = Math.hypot(ceiling, apertureRadius);
  const floor = -chamberRadius + 0.04;
  const fixedStep = 1 / 120;
  const phi = (1 + Math.sqrt(5)) / 2;
  const scale = radius / Math.sqrt(1 + phi * phi);
  const vertices = [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1]
  ].map(v => new CANNON.Vec3(v[0] * scale, v[1] * scale, v[2] * scale));
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ];
  const normals = faces.map(face => {
    const a = vertices[face[0]], b = vertices[face[1]], c = vertices[face[2]];
    const n = b.vsub(a).cross(c.vsub(a));
    if (n.dot(a) < 0) {
      [face[1], face[2]] = [face[2], face[1]];
      n.negate(n);
    }
    n.normalize();
    return n;
  });
  const inradius = vertices[faces[0][0]].dot(normals[0]);
  const faceCenters = faces.map(face => {
    const center = new CANNON.Vec3();
    for (const index of face) center.vadd(vertices[index], center);
    center.scale(1 / 3, center);
    return center;
  });
  const faceAreas = faces.map(face => vertices[face[1]].vsub(vertices[face[0]])
    .cross(vertices[face[2]].vsub(vertices[face[0]])).length() / 2);
  // Symmetric degree-two triangle quadrature captures the off-center pressure
  // forces responsible for form drag during rotation, even at low viscosity.
  const hydroSamples = faces.flatMap((face, i) => face.map(index => ({
    point: vertices[index].vadd(faceCenters[i]).scale(0.5),
    normal: normals[i], area: faceAreas[i] / 3
  })));
  const volume = faces.reduce((sum, face) => sum + vertices[face[0]]
    .dot(vertices[face[1]].cross(vertices[face[2]])) / 6, 0);
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 1.65) });
  world.allowSleep = true;
  world.solver.iterations = 24;
  world.solver.tolerance = 1e-8;
  world.broadphase = new CANNON.NaiveBroadphase();
  const dieMaterial = new CANNON.Material('buoyant-die');
  const glassMaterial = new CANNON.Material('glass');
  const wallMaterial = new CANNON.Material('chamber');
  // Wet, lubricated contacts omit dry Coulomb friction. Dissipation is supplied
  // by viscosity and near-inelastic collisions; dry friction falsely jams edges.
  world.addContactMaterial(new CANNON.ContactMaterial(dieMaterial, glassMaterial, {
    friction: 0, restitution: 0.02,
    contactEquationStiffness: 1e7, contactEquationRelaxation: 4,
    frictionEquationStiffness: 1e7, frictionEquationRelaxation: 4
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(dieMaterial, wallMaterial, {
    friction: 0, restitution: 0.06,
    contactEquationStiffness: 1e7, contactEquationRelaxation: 4
  }));
  const body = new CANNON.Body({
    mass: 0.7,
    material: dieMaterial,
    shape: new CANNON.ConvexPolyhedron({ vertices, faces }),
    linearDamping: fluid ? 0 : 0.55,
    angularDamping: fluid ? 0 : 0.57,
    allowSleep: false,
    sleepSpeedLimit: 0.055,
    sleepTimeLimit: 0.7
  });
  // Exact isotropic solid-icosahedron inertia from tetrahedral volume moments.
  // Cannon otherwise uses the convex hull's bounding-box inertia approximation.
  const moment = body.mass * radius * radius * (1 + 1 / Math.sqrt(5)) / 5;
  body.inertia.set(moment, moment, moment);
  body.invInertia.set(1 / moment, 1 / moment, 1 / moment);
  body.updateInertiaWorld(true);
  world.addBody(body);
  // One static compound keeps the broadphase to a single body pair. Inward
  // tangent facets approximate the spherical cavity; the dome's normal forces
  // guide a buoyant die toward the small window without a centering force.
  const chamberBody = new CANNON.Body({ mass: 0, material: wallMaterial });
  const boundaryPlanes = [];
  function addPlane(position, normal, material) {
    const plane = new CANNON.Plane();
    plane.material = material;
    const rotation = new CANNON.Quaternion();
    rotation.setFromVectors(new CANNON.Vec3(0, 0, 1), normal);
    chamberBody.addShape(plane, position, rotation);
    boundaryPlanes.push({ normal: [-normal.x, -normal.y, -normal.z], offset: -normal.dot(position) });
  }
  addPlane(new CANNON.Vec3(0, 0, ceiling), new CANNON.Vec3(0, 0, -1), glassMaterial);
  addPlane(new CANNON.Vec3(0, 0, floor), new CANNON.Vec3(0, 0, 1), wallMaterial);
  const latitudes = [Math.asin(floor / chamberRadius)];
  for (let degrees = -75; degrees <= 60; degrees += 15) latitudes.push(degrees * Math.PI / 180);
  latitudes.push(Math.atan2(ceiling, apertureRadius));
  for (const latitude of latitudes) {
    const ringRadius = Math.cos(latitude), z = Math.sin(latitude);
    const isWindowRim = latitude === latitudes[latitudes.length - 1];
    const sectors = isWindowRim ? 32 : 16;
    // Inscribe the window ring in the true circular aperture so the coarser
    // spherical facets never admit an answer corner outside the visible glass.
    const offset = isWindowRim
      ? z * ceiling + ringRadius * apertureRadius * Math.cos(Math.PI / sectors)
      : chamberRadius;
    for (let i = 0; i < sectors; i++) {
      const azimuth = i * Math.PI * 2 / sectors;
      const x = Math.cos(azimuth) * ringRadius, y = Math.sin(azimuth) * ringRadius;
      addPlane(new CANNON.Vec3(x * offset, y * offset, z * offset),
        new CANNON.Vec3(-x, -y, -z), wallMaterial);
    }
  }
  world.addBody(chamberBody);
  if (fluid && typeof fluid.setBoundaryPlanes === 'function') fluid.setBoundaryPlanes(boundaryPlanes);
  let seed = (options.seed ?? 0x8ba11) >>> 0;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  const state = { elapsed: 0, sinceShake: 100, kicks: 0, settledFor: 0, seed, energy: 0,
    hydroForce: [0, 0, 0], hydroTorque: [0, 0, 0] };
  let accumulator = 0;
  const normalWorld = new CANNON.Vec3();
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  function readFace() {
    let index = 0, alignment = -Infinity;
    for (let i = 0; i < normals.length; i++) {
      body.quaternion.vmult(normals[i], normalWorld);
      if (normalWorld.z > alignment) { alignment = normalWorld.z; index = i; }
    }
    const speed = Math.sqrt(body.velocity.lengthSquared() + 0.4 * body.angularVelocity.lengthSquared());
    const atWindow = body.position.z > ceiling - inradius - 0.025;
    return {
      index, alignment, speed,
      settled: alignment > 0.996 && atWindow && speed < 0.095 && state.sinceShake > 0.8,
      windowDistance: Math.max(0, ceiling - body.position.z - inradius)
    };
  }
  function resetFace(index = 0, yaw = 0) {
    const valid = ((Math.floor(index) % 20) + 20) % 20;
    body.quaternion.setFromVectors(normals[valid], new CANNON.Vec3(0, 0, 1));
    const spin = new CANNON.Quaternion();
    spin.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), yaw);
    spin.mult(body.quaternion, body.quaternion);
    body.position.set(0, 0, ceiling - inradius - 0.001);
    body.velocity.setZero();
    body.angularVelocity.setZero();
    body.force.setZero();
    body.torque.setZero();
    body.previousPosition.copy(body.position);
    body.interpolatedPosition.copy(body.position);
    body.previousQuaternion.copy(body.quaternion);
    body.interpolatedQuaternion.copy(body.quaternion);
    body.aabbNeedsUpdate = true;
    body.wakeUp();
    state.sinceShake = 100;
    state.settledFor = 0;
    accumulator = 0;
  }
  function markShake() {
    body.wakeUp();
    state.sinceShake = 0;
    state.settledFor = 0;
    state.seed = seed;
  }
  function kick(strength = 1) {
    const amount = clamp(strength, 0.2, 2);
    markShake();
    state.kicks++;
    // Kinetic input, never a choice of face or a target orientation.
    const angle = random() * Math.PI * 2;
    const impulse = new CANNON.Vec3(
      Math.cos(angle) * (0.4 + random() * 0.4) * amount,
      Math.sin(angle) * (0.4 + random() * 0.4) * amount,
      -(1.75 + random() * 0.65) * amount
    );
    body.applyImpulse(impulse);
    if (fluid) fluid.shake(impulse.x / body.mass, impulse.y / body.mass, impulse.z / body.mass);
    body.angularVelocity.vadd(new CANNON.Vec3(
      (random() - 0.5) * 18 * amount,
      (random() - 0.5) * 18 * amount,
      (random() - 0.5) * 13 * amount
    ), body.angularVelocity);
    state.seed = seed;
  }
  function excite(x, y, strength = 1) {
    const amount = clamp(strength, 0, 2);
    const dx = clamp(x, -1, 1), dy = clamp(y, -1, 1);
    markShake();
    const impulse = new CANNON.Vec3(dx * 0.24 * amount, dy * 0.24 * amount, -0.13 * amount);
    const point = new CANNON.Vec3(dy * 0.35, -dx * 0.35, 0.32);
    body.applyImpulse(impulse, point);
    if (fluid) fluid.shake(impulse.x / body.mass, impulse.y / body.mass, impulse.z / body.mass);
  }
  const surfaceLever = new CANNON.Vec3();
  const surfaceNormal = new CANNON.Vec3();
  const surfaceVelocity = new CANNON.Vec3();
  const rigidRotationCorrection = new CANNON.Vec3();
  const hydroForce = new CANNON.Vec3();
  const hydroTorque = new CANNON.Vec3();
  function applyHydrodynamics() {
    const sampleDistance = Number(fluid.cellSize) || 0.17;
    // Newtonian surface-traction approximation: μ A (u_fluid-u_surface) / h.
    // Pressure-normal resistance has a quadratic term (Cd=0.8). Each force
    // acts at its surface quadrature point, so currents naturally torque it.
    const dynamicViscosity = Number(fluid.dynamicViscosity) || 0.004;
    const density = Number(fluid.density) || 0.44;
    state.hydroForce.fill(0);
    state.hydroTorque.fill(0);
    for (const faceSample of hydroSamples) {
      body.quaternion.vmult(faceSample.point, surfaceLever);
      body.quaternion.vmult(faceSample.normal, surfaceNormal);
      body.angularVelocity.cross(surfaceLever, surfaceVelocity);
      surfaceVelocity.vadd(body.velocity, surfaceVelocity);
      const sampleX = body.position.x + surfaceLever.x + surfaceNormal.x * sampleDistance;
      const sampleY = body.position.y + surfaceLever.y + surfaceNormal.y * sampleDistance;
      const sampleZ = body.position.z + surfaceLever.z + surfaceNormal.z * sampleDistance;
      const sampled = fluid.sample(sampleX, sampleY, sampleZ);
      // Subtract the antisymmetric rigid-rotation gradient: a liquid and die
      // co-rotating together must not experience spurious viscous traction.
      body.angularVelocity.cross(surfaceNormal, rigidRotationCorrection);
      rigidRotationCorrection.scale(sampleDistance, rigidRotationCorrection);
      const ux = sampled[0] - surfaceVelocity.x - rigidRotationCorrection.x;
      const uy = sampled[1] - surfaceVelocity.y - rigidRotationCorrection.y;
      const uz = sampled[2] - surfaceVelocity.z - rigidRotationCorrection.z;
      const normalRelative = ux * surfaceNormal.x + uy * surfaceNormal.y + uz * surfaceNormal.z;
      const viscous = dynamicViscosity * faceSample.area / sampleDistance;
      const normalForce = 0.5 * density * 0.8 * faceSample.area * normalRelative * Math.abs(normalRelative);
      hydroForce.set(
        viscous * ux + surfaceNormal.x * normalForce,
        viscous * uy + surfaceNormal.y * normalForce,
        viscous * uz + surfaceNormal.z * normalForce
      );
      body.applyForce(hydroForce, surfaceLever);
      if (fluid.depositImpulse) {
        fluid.depositImpulse(sampleX, sampleY, sampleZ,
          -hydroForce.x * fixedStep, -hydroForce.y * fixedStep, -hydroForce.z * fixedStep);
      }
      surfaceLever.cross(hydroForce, hydroTorque);
      state.hydroForce[0] += hydroForce.x;
      state.hydroForce[1] += hydroForce.y;
      state.hydroForce[2] += hydroForce.z;
      state.hydroTorque[0] += hydroTorque.x;
      state.hydroTorque[1] += hydroTorque.y;
      state.hydroTorque[2] += hydroTorque.z;
    }
  }
  function step(dt) {
    accumulator += clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    while (accumulator >= fixedStep) {
      if (fluid) {
        fluid.advance(fixedStep, body);
        applyHydrodynamics();
      } else {
        // Reduced fluid model used only when a resolved grid was not supplied.
        const speed = body.velocity.length();
        body.force.x -= body.velocity.x * speed * 0.11;
        body.force.y -= body.velocity.y * speed * 0.11;
        body.force.z -= body.velocity.z * speed * 0.11;
      }
      world.step(fixedStep);
      state.elapsed += fixedStep;
      state.sinceShake += fixedStep;
      accumulator -= fixedStep;
      const face = readFace();
      state.settledFor = face.settled ? state.settledFor + fixedStep : 0;
    }
    state.energy = 0.5 * body.mass * body.velocity.lengthSquared()
      + 0.5 * (body.inertia.x * body.angularVelocity.x ** 2
      + body.inertia.y * body.angularVelocity.y ** 2
      + body.inertia.z * body.angularVelocity.z ** 2);
    return readFace();
  }
  resetFace(options.initialFace ?? 0, options.initialYaw ?? 0);
  return {
    world, body, chamberBody, boundaryPlanes, vertices, faces, normals, faceCenters, faceAreas, state, fluid,
    radius, inradius, volume, outerRadius, apertureRadius, chamberRadius, ceiling, floor, fixedStep,
    step, kick, excite, readFace, resetFace
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { createBallPhysics };
