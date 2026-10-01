const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// The historical fixture needs only a debug hook, so the same Fourier-mode
// regression demonstrates the defect without copying numerical code here.
const filename = process.argv[2] || require('node:path').join(__dirname,'../src/fluid-core.js');
const source = fs.readFileSync(filename, 'utf8').replace(
  'divergenceRMS,measure}}', 'divergenceRMS,measure,advectAndDiffuse}}');
const context = { module: { exports: {} } };
vm.runInNewContext(source, context, { filename });
const createFluidField = context.module.exports.createFluidField;
const results = [];
for (const cellsCrossed of [0, 1, 2]) {
  const fluid = createFluidField({ confinement: 0 });
  const d = fluid.debug, dt = 1 / 30, amplitude = .002;
  const nu = fluid.dynamicViscosity / fluid.density;
  const diffusionSum = nu * dt * (1 / d.hx ** 2 + 1 / d.hy ** 2 + 1 / d.hz ** 2);
  assert.ok(diffusionSum <= .5, 'Explicit diffusion violates its CFL condition');
  d.faceSets[0].values.fill(cellsCrossed * d.hx / dt);
  const transverse = d.faceSets[1];
  for (let a = 0; a < transverse.size; a++) {
    transverse.values[a] = (a % transverse.sx) % 2 ? -amplitude : amplitude;
  }
  // This divergence-free shear wave is measured far from vessel boundaries.
  // Constant translation must not turn viscosity into an energy source.
  d.advectAndDiffuse(dt);
  const i = 12, j = 13, k = 13;
  const actual = transverse.values[i + transverse.sx * (j + transverse.sy * k)];
  const expected = amplitude * (cellsCrossed % 2 ? -1 : 1) * (1 - 4 * nu * dt / d.hx ** 2);
  const gain = Math.abs(actual / amplitude);
  results.push({ cellsCrossed, expected, actual, gain, diffusionSum });
  assert.ok(gain <= 1, `Viscosity amplified a translated mode: ${JSON.stringify(results.at(-1))}`);
  assert.ok(Math.abs(actual - expected) < 2e-8, 'Split diffusion disagrees with its Fourier amplification factor');
}
console.log(JSON.stringify({ pass: true, filename, results }, null, 2));
