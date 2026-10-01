/* Coarse three-dimensional incompressible Navier-Stokes solver.
 * Staggered MAC grid, midpoint semi-Lagrangian advection, viscous diffusion,
 * Neumann pressure projection, and moving voxelized convex-die boundaries.
 * Resolved wakes are physical grid velocities; no time-based curl-noise field.
 * References: Bridson & Muller-Fischer, SIGGRAPH 2007 fluid course notes;
 * Stam, Stable Fluids (1999). This grid does not resolve a turbulence spectrum.
 */
function createFluidField(options = {}) {
  const outerRadius=2.35,cutRadius=.848,glassBack=Math.sqrt(outerRadius**2-cutRadius**2)-.0285318-.045;
  const radius = options.radius || Math.sqrt(glassBack**2+.82**2);
  const floor = options.floor ?? -radius+.04, ceiling = options.ceiling ?? glassBack;
  const nx = options.resolution || 28, ny = nx, nz = options.zResolution || Math.round((ceiling-floor)/(2*radius/nx));
  const hx = 2 * radius / nx, hy = hx, hz = (ceiling - floor) / nz;
  const density = options.density ?? 0.44, dynamicViscosity = options.dynamicViscosity ?? 0.004;
  const viscosity = dynamicViscosity / density, confinement = options.confinement ?? 0.065;
  const fixedStep = 1 / 30, pressureIterations = options.pressureIterations || 24;
  const count = nx * ny * nz, cellSize = Math.min(hx, hy, hz), cellVolume = hx * hy * hz;
  const mask = new Uint8Array(count), staticMask = new Uint8Array(count);
  // The final pressure entry is a permanent zero used by inactive stencil
  // neighbors. Cache the moving-mask stencil once, not during each iteration.
  const pressure = new Float32Array(count + 1), divergence = new Float32Array(count);
  const pressureNeighbors = Array.from({length:6}, () => new Int32Array(count));
  const pressureDiagonal = new Float64Array(count), pressureRHS = new Float64Array(count);
  const weightX = 1/(hx*hx), weightY = 1/(hy*hy), weightZ = 1/(hz*hz);
  const pressureWeights = [weightX,weightX,weightY,weightY,weightZ,weightZ];
  const cx = new Float32Array(count), cy = new Float32Array(count), cz = new Float32Array(count);
  const curlX = new Float32Array(count), curlY = new Float32Array(count), curlZ = new Float32Array(count), curlLength = new Float32Array(count);
  const centered = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  const force = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  const neighbor = Array.from({length: 6}, () => new Int32Array(count).fill(-1));
  const fluidCells = [], fluidParity=[[],[]], checker=new Uint8Array(count);
  const wallDistance=new Float32Array(count),wallX=new Float32Array(count),wallY=new Float32Array(count),wallZ=new Float32Array(count);
  const ci = (i,j,k) => i + nx * (j + ny * k);
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  for(let k=0;k<nz;k++) for(let j=0;j<ny;j++) for(let i=0;i<nx;i++) {
    const c=ci(i,j,k);cx[c]=-radius+(i+.5)*hx;cy[c]=-radius+(j+.5)*hy;cz[c]=floor+(k+.5)*hz;
    const rr=Math.hypot(cx[c],cy[c],cz[c]);
    staticMask[c]=rr>radius?1:0;checker[c]=(i+j+k)&1;
    const ds=radius-rr,dlo=cz[c]-floor,dhi=ceiling-cz[c];wallDistance[c]=Math.min(ds,dlo,dhi);
    if(ds<=dlo&&ds<=dhi){wallX[c]=cx[c]/(rr||1);wallY[c]=cy[c]/(rr||1);wallZ[c]=cz[c]/(rr||1);}
    else wallZ[c]=dlo<dhi?-1:1;
    if(i>0)neighbor[0][c]=c-1;if(i<nx-1)neighbor[1][c]=c+1;
    if(j>0)neighbor[2][c]=c-nx;if(j<ny-1)neighbor[3][c]=c+nx;
    if(k>0)neighbor[4][c]=c-nx*ny;if(k<nz-1)neighbor[5][c]=c+nx*ny;
  }
  const faceSets = [0,1,2].map(axis => {
    const sx=nx+(axis===0?1:0), sy=ny+(axis===1?1:0), sz=nz+(axis===2?1:0), size=sx*sy*sz;
    const f={axis,sx,sy,sz,size,values:new Float32Array(size),next:new Float32Array(size),pending:new Float32Array(size),
      x:new Float32Array(size),y:new Float32Array(size),z:new Float32Array(size),left:new Int32Array(size),right:new Int32Array(size)};
    for(let k=0;k<sz;k++) for(let j=0;j<sy;j++) for(let i=0;i<sx;i++) {
      const a=i+sx*(j+sy*k);f.x[a]=-radius+(i+(axis===0?0:.5))*hx;f.y[a]=-radius+(j+(axis===1?0:.5))*hy;f.z[a]=floor+(k+(axis===2?0:.5))*hz;
      const li=i-(axis===0?1:0),lj=j-(axis===1?1:0),lk=k-(axis===2?1:0);
      f.left[a]=(li<0||lj<0||lk<0)?-1:ci(li,lj,lk);
      f.right[a]=(i>=nx||j>=ny||k>=nz)?-1:ci(i,j,k);
    }return f;
  });
  // The first midpoint-backtrace lookup is exactly at a MAC face. Its own
  // component is stored there; each transverse component is the average of
  // four staggered neighbors. Cache these fixed lattice addresses once.
  for(const f of faceSets){
    f.crossSamples=faceSets.filter(g=>g.axis!==f.axis).map(g=>{
      const strides=[1,g.sx,g.sx*g.sy];
      const sample={axis:g.axis,field:g,base:new Int32Array(f.size),
        strideA:strides[f.axis],strideB:strides[g.axis]};
      for(let k=0;k<f.sz;k++)for(let j=0;j<f.sy;j++)for(let i=0;i<f.sx;i++){
        const a=i+f.sx*(j+f.sy*k);
        sample.base[a]=i-(f.axis===0?1:0)+g.sx*(j-(f.axis===1?1:0)+g.sy*(k-(f.axis===2?1:0)));
      }
      return sample;
    });
  }
  const cellFaces=Array.from({length:6},()=>new Int32Array(count));
  for(let k=0;k<nz;k++)for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    const c=ci(i,j,k);cellFaces[0][c]=i+(nx+1)*(j+ny*k);cellFaces[1][c]=cellFaces[0][c]+1;
    cellFaces[2][c]=i+nx*(j+(ny+1)*k);cellFaces[3][c]=cellFaces[2][c]+nx;
    cellFaces[4][c]=i+nx*(j+ny*k);cellFaces[5][c]=cellFaces[4][c]+nx*ny;
  }
  let accumulator=0, body=null, shape=null, planes=[], drive=[0,0,0],boundaryPlanes=null,dieBound=.94;
  const state={energy:0,maxSpeed:0,maxVorticity:0,enstrophy:0,divergenceBefore:0,divergenceAfter:0,steps:0,fluidCells:0};
  const scratch=new Float64Array(3), midpoint=new Float64Array(3),depositIndices=new Int32Array(8),depositWeights=new Float64Array(8);
  function interpolate(f,a,x,y,z){
    const gx=clamp((x+radius)/hx-(f.axis===0?0:.5),0,f.sx-1.000001);
    const gy=clamp((y+radius)/hy-(f.axis===1?0:.5),0,f.sy-1.000001);
    const gz=clamp((z-floor)/hz-(f.axis===2?0:.5),0,f.sz-1.000001);
    const i=Math.floor(gx),j=Math.floor(gy),k=Math.floor(gz), tx=gx-i,ty=gy-j,tz=gz-k;
    const q=i+f.sx*(j+f.sy*k), stride=f.sx*f.sy;
    const a0=a[q]*(1-tx)+a[q+1]*tx,a1=a[q+f.sx]*(1-tx)+a[q+f.sx+1]*tx;
    const b0=a[q+stride]*(1-tx)+a[q+stride+1]*tx,b1=a[q+stride+f.sx]*(1-tx)+a[q+stride+f.sx+1]*tx;
    return ((a0*(1-ty)+a1*ty)*(1-tz)+(b0*(1-ty)+b1*ty)*tz);
  }
  function sample(x,y,z,target){
    const out=target||[0,0,0];
    if(Math.abs(x)>radius||Math.abs(y)>radius||z<floor||z>ceiling){out[0]=out[1]=out[2]=0;return out;}
    const i=clamp(Math.floor((x+radius)/hx),0,nx-1),j=clamp(Math.floor((y+radius)/hy),0,ny-1),k=clamp(Math.floor((z-floor)/hz),0,nz-1);
    if(staticMask[ci(i,j,k)]){out[0]=out[1]=out[2]=0;return out;}
    return sampleRaw(x,y,z,out);
  }
  function sampleRaw(x,y,z,out){
    for(let a=0;a<3;a++)out[a]=interpolate(faceSets[a],faceSets[a].values,x,y,z);
    return out;
  }
  function insideDie(x,y,z){
    if(!body)return false;
    const r=body.position,q=body.quaternion,px=x-r.x,py=y-r.y,pz=z-r.z;
    if(px*px+py*py+pz*pz>dieBound*dieBound)return false;
    const tx=2*(-q.y*pz+q.z*py),ty=2*(-q.z*px+q.x*pz),tz=2*(-q.x*py+q.y*px);
    const lx=px+q.w*tx-q.y*tz+q.z*ty,ly=py+q.w*ty-q.z*tx+q.x*tz,lz=pz+q.w*tz-q.x*ty+q.y*tx;
    if(planes.length){for(const p of planes)if(p[0]*lx+p[1]*ly+p[2]*lz>p[3])return false;return true;}
    return lx*lx+ly*ly+lz*lz<.78*.78;
  }
  function updateMask(nextBody){
    body=nextBody||null;
    const nextShape=body?.shapes?.[0];
    if(nextShape!==shape){shape=nextShape;planes=[];dieBound=shape?.boundingSphereRadius||.94;if(shape?.faceNormals&&shape?.vertices&&shape?.faces){planes=shape.faceNormals.map((n,i)=>{const v=shape.vertices[shape.faces[i][0]];return[n.x,n.y,n.z,n.x*v.x+n.y*v.y+n.z*v.z];});}}
    fluidCells.length=0;fluidParity[0].length=0;fluidParity[1].length=0;
    for(let c=0;c<count;c++){
      mask[c]=staticMask[c]||(insideDie(cx[c],cy[c],cz[c])?2:0);
      if(mask[c])pressure[c]=0;else {fluidCells.push(c);fluidParity[checker[c]].push(c);}
    }state.fluidCells=fluidCells.length;
    for(let i=0;i<fluidCells.length;i++){
      const c=fluidCells[i];let diagonal=0;
      for(let d=0;d<6;d++){
        const n=neighbor[d][c],active=n>=0&&!mask[n];
        pressureNeighbors[d][c]=active?n:count;
        if(active)diagonal+=pressureWeights[d];
      }
      pressureDiagonal[c]=diagonal;
    }
  }
  function setBoundaryPlanes(newPlanes){
    boundaryPlanes=newPlanes;
    for(let c=0;c<count;c++){
      let d=Infinity,wx=0,wy=0,wz=0;
      for(const plane of boundaryPlanes){const n=plane.normal,s=plane.offset-n[0]*cx[c]-n[1]*cy[c]-n[2]*cz[c];if(s<d){d=s;wx=n[0];wy=n[1];wz=n[2];}}
      staticMask[c]=d<0?1:0;wallDistance[c]=d;wallX[c]=wx;wallY[c]=wy;wallZ[c]=wz;
    }updateMask(body);enforceBoundaries();
  }
  function bodyVelocity(axis,x,y,z){
    if(!body)return 0;const p=body.position,v=body.velocity,w=body.angularVelocity;
    if(axis===0)return v.x+w.y*(z-p.z)-w.z*(y-p.y);
    if(axis===1)return v.y+w.z*(x-p.x)-w.x*(z-p.z);
    return v.z+w.x*(y-p.y)-w.y*(x-p.x);
  }
  function enforceBoundaries(){
    for(const f of faceSets)for(let a=0;a<f.size;a++){
      const l=f.left[a],r=f.right[a];
      if(l<0||r<0||mask[l]===1||mask[r]===1)f.values[a]=0;
      else if(mask[l]===2||mask[r]===2)f.values[a]=bodyVelocity(f.axis,f.x[a],f.y[a],f.z[a]);
    }
  }
  function computeCentersAndCurl(){
    const u=faceSets[0].values,v=faceSets[1].values,w=faceSets[2].values;
    const uc=centered[0],vc=centered[1],wc=centered[2];
    const f0=cellFaces[0],f1=cellFaces[1],f2=cellFaces[2],f3=cellFaces[3],f4=cellFaces[4],f5=cellFaces[5];
    for(let c=0;c<count;c++){
      uc[c]=.5*(u[f0[c]]+u[f1[c]]);
      vc[c]=.5*(v[f2[c]]+v[f3[c]]);
      wc[c]=.5*(w[f4[c]]+w[f5[c]]);
    }
    for(let c=0;c<count;c++){
      if(mask[c]){curlX[c]=curlY[c]=curlZ[c]=curlLength[c]=0;continue;}
      const xm=neighbor[0][c],xp=neighbor[1][c],ym=neighbor[2][c],yp=neighbor[3][c],zm=neighbor[4][c],zp=neighbor[5][c];
      const ixm=xm>=0?xm:c,ixp=xp>=0?xp:c,iym=ym>=0?ym:c,iyp=yp>=0?yp:c,izm=zm>=0?zm:c,izp=zp>=0?zp:c;
      curlX[c]=(wc[iyp]-wc[iym])/(2*hy)-(vc[izp]-vc[izm])/(2*hz);
      curlY[c]=(uc[izp]-uc[izm])/(2*hz)-(wc[ixp]-wc[ixm])/(2*hx);
      curlZ[c]=(vc[ixp]-vc[ixm])/(2*hx)-(uc[iyp]-uc[iym])/(2*hy);
      curlLength[c]=Math.hypot(curlX[c],curlY[c],curlZ[c]);
    }
  }
  function computeForces(){
    computeCentersAndCurl();for(const a of force)a.fill(0);
    const eps=confinement*cellSize;
    for(const c of fluidCells){
      let gx=0,gy=0,gz=0;
      for(let a=0;a<3;a++){
        const m=neighbor[2*a][c],p=neighbor[2*a+1][c];
        const g=((p>=0?curlLength[p]:curlLength[c])-(m>=0?curlLength[m]:curlLength[c]))/(2*(a===2?hz:hx));
        if(a===0)gx=g;else if(a===1)gy=g;else gz=g;
      }
      const inv=1/(Math.hypot(gx,gy,gz)+1e-8);gx*=inv;gy*=inv;gz*=inv;
      force[0][c]=eps*(gy*curlZ[c]-gz*curlY[c]);force[1][c]=eps*(gz*curlX[c]-gx*curlZ[c]);force[2][c]=eps*(gx*curlY[c]-gy*curlX[c]);
      // Hand forcing acts through a transient tangential boundary layer. It is
      // a coarse fixed-domain moving-wall approximation, not uniform body force.
      const distance=wallDistance[c];
      if(distance<1.75*cellSize){
        const nxw=wallX[c],nyw=wallY[c],nzw=wallZ[c];
        const dn=drive[0]*nxw+drive[1]*nyw+drive[2]*nzw;
        const rate=viscosity/Math.max(.35*cellSize*cellSize,distance*distance);
        force[0][c]+=rate*(drive[0]-dn*nxw-centered[0][c]);
        force[1][c]+=rate*(drive[1]-dn*nyw-centered[1][c]);
        force[2][c]+=rate*(drive[2]-dn*nzw-centered[2][c]);
      }
    }
  }
  function advectAndDiffuse(dt){
    for(const f of faceSets){
      const old=f.values, next=f.next;
      for(let a=0;a<f.size;a++){
        const l=f.left[a],r=f.right[a];
        if(l<0||r<0||mask[l]||mask[r]){next[a]=old[a];continue;}
        const x=f.x[a],y=f.y[a],z=f.z[a];
        scratch[f.axis]=old[a];
        for(let t=0;t<2;t++){
          const s=f.crossSamples[t],v=s.field.values,q=s.base[a],sa=s.strideA,sb=s.strideB;
          scratch[s.axis]=.25*((v[q]+v[q+sa])+(v[q+sb]+v[q+sa+sb]));
        }
        sampleRaw(x-.5*dt*scratch[0],y-.5*dt*scratch[1],z-.5*dt*scratch[2],midpoint);
        const adv=interpolate(f,old,x-dt*midpoint[0],y-dt*midpoint[1],z-dt*midpoint[2]);
        next[a]=adv+dt*.5*(force[f.axis][l]+force[f.axis][r])+f.pending[a];
      }f.pending.fill(0);
    }
    // Diffuse the completed advected field. Adding Laplacian(old) to an
    // advected value instead can amplify a translated alternating mode even
    // when the explicit diffusion CFL condition is otherwise satisfied.
    for(const f of faceSets){
      const advected=f.next, next=f.values,sx=f.sx,stride=f.sx*f.sy;
      for(let a=0;a<f.size;a++){
        const l=f.left[a],r=f.right[a];
        if(l<0||r<0||mask[l]||mask[r]){next[a]=advected[a];continue;}
        const i=a%sx,j=Math.floor(a/sx)%f.sy,k=Math.floor(a/stride);
        const lap=((i>0?advected[a-1]:0)+(i<sx-1?advected[a+1]:0)-2*advected[a])/(hx*hx)
          +((j>0?advected[a-sx]:0)+(j<f.sy-1?advected[a+sx]:0)-2*advected[a])/(hy*hy)
          +((k>0?advected[a-stride]:0)+(k<f.sz-1?advected[a+stride]:0)-2*advected[a])/(hz*hz);
        next[a]=advected[a]+dt*viscosity*lap;
      }
    }
  }
  function divergenceRMS(store){
    let sum=0;
    for(const c of fluidCells){
      const d=(faceSets[0].values[cellFaces[1][c]]-faceSets[0].values[cellFaces[0][c]])/hx
        +(faceSets[1].values[cellFaces[3][c]]-faceSets[1].values[cellFaces[2][c]])/hy
        +(faceSets[2].values[cellFaces[5][c]]-faceSets[2].values[cellFaces[4][c]])/hz;
      if(store)divergence[c]=d;sum+=d*d;
    }return Math.sqrt(sum/Math.max(1,fluidCells.length));
  }
  function project(dt){
    state.divergenceBefore=divergenceRMS(true);
    const n0=pressureNeighbors[0],n1=pressureNeighbors[1],n2=pressureNeighbors[2],
      n3=pressureNeighbors[3],n4=pressureNeighbors[4],n5=pressureNeighbors[5];
    for(let i=0;i<fluidCells.length;i++){
      const c=fluidCells[i];pressureRHS[c]=divergence[c]/dt;
    }
    // Red-black Gauss-Seidel is a local pressure iteration with faster
    // convergence than equally expensive Jacobi on this Cartesian Poisson grid.
    for(let iteration=0;iteration<pressureIterations;iteration++)for(let parity=0;parity<2;parity++){
      const cells=fluidParity[parity];
      for(let i=0;i<cells.length;i++){
        const c=cells[i],diag=pressureDiagonal[c];
        const sum=weightX*pressure[n0[c]]+weightX*pressure[n1[c]]
          +weightY*pressure[n2[c]]+weightY*pressure[n3[c]]
          +weightZ*pressure[n4[c]]+weightZ*pressure[n5[c]];
        pressure[c]=diag?(sum-pressureRHS[c])/diag:0;
      }
    }
    for(const f of faceSets){const h=f.axis===2?hz:hx;for(let a=0;a<f.size;a++){const l=f.left[a],r=f.right[a];if(l>=0&&r>=0&&!mask[l]&&!mask[r])f.values[a]-=dt*(pressure[r]-pressure[l])/h;}}
    enforceBoundaries();state.divergenceAfter=divergenceRMS(false);
  }
  function measure(){
    computeCentersAndCurl();let energy=0,enstrophy=0,maxSpeed=0,maxVorticity=0;
    for(const c of fluidCells){const s2=centered[0][c]**2+centered[1][c]**2+centered[2][c]**2;energy+=s2;enstrophy+=curlLength[c]**2;maxSpeed=Math.max(maxSpeed,Math.sqrt(s2));maxVorticity=Math.max(maxVorticity,curlLength[c]);}
    state.energy=.5*density*cellVolume*energy;state.enstrophy=.5*cellVolume*enstrophy;state.maxSpeed=maxSpeed;state.maxVorticity=maxVorticity;
  }
  function advance(dt,nextBody){
    accumulator+=clamp(Number.isFinite(dt)?dt:0,0,.1);
    while(accumulator+1e-10>=fixedStep){
      updateMask(nextBody);enforceBoundaries();computeForces();advectAndDiffuse(fixedStep);enforceBoundaries();project(fixedStep);measure();
      const decay=Math.exp(-fixedStep/0.28);for(let a=0;a<3;a++)drive[a]*=decay;
      accumulator-=fixedStep;state.steps++;
    }return state;
  }
  function depositImpulse(x,y,z,jx,jy,jz){
    const mass=density*cellVolume;
    for(const f of faceSets){
      const impulse=f.axis===0?jx:f.axis===1?jy:jz;if(!Number.isFinite(impulse)||impulse===0)continue;
      const gx=clamp((x+radius)/hx-(f.axis===0?0:.5),0,f.sx-1.000001),gy=clamp((y+radius)/hy-(f.axis===1?0:.5),0,f.sy-1.000001),gz=clamp((z-floor)/hz-(f.axis===2?0:.5),0,f.sz-1.000001);
      const i=Math.floor(gx),j=Math.floor(gy),k=Math.floor(gz),tx=gx-i,ty=gy-j,tz=gz-k;
      let weight=0,entries=0;
      for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
        const a=i+dx+f.sx*(j+dy+f.sy*(k+dz)),l=f.left[a],r=f.right[a];if(l<0||r<0||mask[l]||mask[r])continue;
        const w=(dx?tx:1-tx)*(dy?ty:1-ty)*(dz?tz:1-tz);weight+=w;depositIndices[entries]=a;depositWeights[entries]=w;entries++;
      }
      if(weight>1e-8)for(let i=0;i<entries;i++)f.pending[depositIndices[i]]+=impulse*depositWeights[i]/(mass*weight);
    }
  }
  function shake(x,y,z){drive[0]+=clamp(x,-3,3);drive[1]+=clamp(y,-3,3);drive[2]+=clamp(z,-3,3);for(let a=0;a<3;a++)drive[a]=clamp(drive[a],-5,5);}
  function clear(){for(const f of faceSets){f.values.fill(0);f.next.fill(0);f.pending.fill(0);}pressure.fill(0);drive=[0,0,0];accumulator=0;for(const k of Object.keys(state))state[k]=0;updateMask(null);}
  function samplePressure(x,y,z){const i=clamp(Math.floor((x+radius)/hx),0,nx-1),j=clamp(Math.floor((y+radius)/hy),0,ny-1),k=clamp(Math.floor((z-floor)/hz),0,nz-1);return density*pressure[ci(i,j,k)];}
  updateMask(null);
  if(options.boundaryPlanes)setBoundaryPlanes(options.boundaryPlanes);
  return {sample,advance,shake,impulse:shake,depositImpulse,clear,samplePressure,insideDie,setBoundaryPlanes,state,cellSize,density,dynamicViscosity,radius,floor,ceiling,
    debug:{mask,staticMask,pressure,faceSets,cellFaces,cx,cy,cz,nx,ny,nz,hx,hy,hz,project,updateMask,enforceBoundaries,divergenceRMS,measure,advectAndDiffuse}};
}
if(typeof module!=='undefined'&&module.exports)module.exports={createFluidField};
