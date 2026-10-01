#version 300 es
precision highp float;
precision highp int;

// A compact spectral (RGB) ray model. Distances are in ball-space units.
// The glass/liquid interfaces are refracted separately, and both illumination
// and viewing distances contribute to the dyed fluid's Beer-Lambert extinction.
uniform vec2 uResolution;
uniform vec2 uOffset;
uniform mat3 uBall;
uniform mat3 uDie;
uniform vec3 uPosition;
uniform vec3 uVertices[12];
uniform ivec3 uFaces[20];
// Ball-local air spheres. Zero radii disable bubbles; their motion belongs to
// the fluid solver. This shader never perturbs the homogeneous dye field.
uniform vec4 uBubbles[12];
uniform sampler2D uAtlas;
uniform sampler2D uEight;
uniform float uLightMode;
out vec4 fragColor;

const float PI = 3.141592653589793;
const float BALL_R = 2.35;
const float APERTURE_R = 0.820;
const float CUT_R = 0.848;
const float GLASS_FRONT = 2.16313332040503;
const float GLASS_BACK = 2.11813332040503;
const float LIP_TOP = 2.19166512040503;
const float CHAMBER_R = 2.27131872774607;
// Artist-tuned dye concentrations; RGB absorption, not measured toy chemistry.
const vec3 EXTINCTION = vec3(18.0, 11.0, 7.0);
const vec3 UP = vec3(0.0, 0.0, 1.0);

float dielectricFresnel(float cosine, float ni, float nt) {
    float ci = clamp(abs(cosine), 0.0, 1.0);
    float st2 = (ni * ni / (nt * nt)) * max(0.0, 1.0 - ci * ci);
    if (st2 >= 1.0) return 1.0;
    float ct = sqrt(max(0.0, 1.0 - st2));
    float rs = (ni * ci - nt * ct) / (ni * ci + nt * ct);
    float rp = (nt * ci - ni * ct) / (nt * ci + ni * ct);
    return 0.5 * (rs * rs + rp * rp);
}

float softboxEmitter(vec3 d, vec3 axis, vec2 halfSize, float feather) {
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), axis));
    vec3 up = cross(axis, right);
    float facing = dot(d, axis);
    vec2 q = vec2(dot(d, right), dot(d, up)) / max(0.001, facing);
    // Rounded diffusion panels, with a gradual edge roll-off rather than four
    // independently clipped sides. The lighting stays fixed in world space.
    float corner = min(halfSize.x, halfSize.y) * 0.48;
    vec2 edge = abs(q) - halfSize + vec2(corner);
    float distance = length(max(edge, vec2(0.0))) +
        min(max(edge.x, edge.y), 0.0) - corner;
    return (1.0 - smoothstep(-feather, feather, distance)) * step(0.0, facing);
}

vec3 environment(vec3 d, float spread) {
    d = normalize(d);
    // The object inhabits a neutral photographic studio, independent of UI theme.
    float sky = smoothstep(-0.75, 0.85, d.y);
    vec3 c = mix(vec3(0.031, 0.036, 0.046), vec3(0.235, 0.247, 0.270), sky);
    c += vec3(0.033, 0.037, 0.049) * pow(max(0.0, 1.0 - abs(d.y)), 4.0);
    c += vec3(5.15, 5.02, 4.82) * softboxEmitter(d,
        normalize(vec3(-1.7, 2.5, 3.4)), vec2(0.41, 0.66), 0.115 + spread);
    c += vec3(1.70, 1.90, 2.22) * softboxEmitter(d,
        normalize(vec3(2.9, 0.3, 1.5)), vec2(0.095, 0.91), 0.080 + spread);
    c += vec3(1.50, 1.55, 1.66) * softboxEmitter(d,
        normalize(vec3(-0.12, 0.82, 4.0)), vec2(0.43, 0.045), 0.055 + spread);
    c += vec3(0.64, 0.69, 0.79) * softboxEmitter(d,
        normalize(vec3(-2.6, -0.4, -1.8)), vec2(0.22, 0.76), 0.12 + spread);
    return c;
}

vec3 studioDiffuse(vec3 nw) {
    vec3 c = vec3(0.105, 0.119, 0.144) * (0.7 + 0.3 * nw.y);
    c += vec3(0.98, 0.94, 0.87) * max(0.0, dot(nw, normalize(vec3(-1.7, 2.5, 3.4))));
    c += vec3(0.15, 0.18, 0.24) * max(0.0, dot(nw, normalize(vec3(2.9, 0.3, 1.5))));
    return c;
}

vec3 shadePlastic(vec3 p, vec3 n, vec3 ray, bool lip) {
    vec3 nw = normalize(uBall * n);
    vec3 rw = normalize(uBall * reflect(ray, n));
    float cosV = max(0.0, dot(n, -ray));
    float f = dielectricFresnel(cosV, 1.0, 1.52);
    float roughness = lip ? 0.092 : 0.115;
    vec3 base = vec3(0.0068, 0.0080, 0.0103);
    if (!lip && p.z < -0.7) {
        vec2 uv = p.xy / 1.75558823529412 + 0.5;
        if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) {
            vec4 decal = texture(uEight, uv);
            decal.a *= 1.0 - smoothstep(0.852911764705882, 0.861205882352941, length(p.xy));
            base = mix(base, decal.rgb * 0.74, decal.a);
            roughness = mix(roughness, 0.18, decal.a);
        }
    }
    // Finite angular source width gives polished ABS broad, soft reflections.
    vec3 spec = environment(rw, roughness * roughness * 1.7) * f;
    vec3 diffuse = base * studioDiffuse(nw) * (1.0 - f);
    // A restrained mould seam at the two shell halves.
    float seam = 1.0 - 0.08 * (1.0 - smoothstep(0.0014, 0.0033, abs(p.z)));
    return (spec + diffuse) * (lip ? 0.85 : seam);
}

bool sphereHit(vec3 ro, vec3 rd, float r, out float nearT, out float farT) {
    float b = dot(ro, rd);
    float h = b * b - dot(ro, ro) + r * r;
    if (h < 0.0) return false;
    float s = sqrt(h);
    nearT = -b - s;
    farT = -b + s;
    return farT > 0.0;
}

// The chamfer is real geometry between the spherical casing and recessed pane.
float lipHit(vec3 ro, vec3 rd, out vec3 normal) {
    float k = (CUT_R - APERTURE_R) / (LIP_TOP - GLASS_FRONT);
    float c = APERTURE_R - k * GLASS_FRONT;
    float rz = k * ro.z + c;
    float dz = k * rd.z;
    float a = dot(rd.xy, rd.xy) - dz * dz;
    float b = dot(ro.xy, rd.xy) - rz * dz;
    float cc = dot(ro.xy, ro.xy) - rz * rz;
    float h = b * b - a * cc;
    float nearest = 1e9;
    normal = UP;
    if (h < 0.0 || abs(a) < 1e-7) return nearest;
    float s = sqrt(h);
    for (int side = 0; side < 2; ++side) {
        float t = (-b + (side == 0 ? -s : s)) / a;
        vec3 p = ro + t * rd;
        if (t > 0.0 && t < nearest && p.z >= GLASS_FRONT && p.z <= LIP_TOP) {
            nearest = t;
            normal = normalize(vec3(-normalize(p.xy), k));
        }
    }
    return nearest;
}

bool dieHit(vec3 ro, vec3 rd, out float distance, out vec3 normal,
            out vec3 bary, out int face) {
    mat3 inv = transpose(uDie);
    vec3 o = inv * (ro - uPosition);
    vec3 d = inv * rd;
    distance = 1e9;
    face = -1;
    normal = UP;
    bary = vec3(0.0);
    for (int i = 0; i < 20; ++i) {
        ivec3 f = uFaces[i];
        vec3 a = uVertices[f.x];
        vec3 b = uVertices[f.y];
        vec3 c = uVertices[f.z];
        vec3 ab = b - a;
        vec3 ac = c - a;
        vec3 h = cross(d, ac);
        float determinant = dot(ab, h);
        if (abs(determinant) < 1e-7) continue;
        float invDet = 1.0 / determinant;
        vec3 s = o - a;
        float u = invDet * dot(s, h);
        if (u < 0.0 || u > 1.0) continue;
        vec3 q = cross(s, ab);
        float v = invDet * dot(d, q);
        if (v < 0.0 || u + v > 1.0) continue;
        float t = invDet * dot(ac, q);
        // Accept the collision solver skin at the pane; optical depth stays nonnegative.
        if (t < -0.006 || max(0.0, t) >= distance) continue;
        distance = max(0.0, t);
        bary = vec3(1.0 - u - v, u, v);
        face = i;
        vec3 flatN = normalize(cross(ab, ac));
        if (dot(flatN, a + b + c) < 0.0) flatN = -flatN;
        // The moulded resin die has a tiny softened edge. This normal change is
        // confined to the last ~1% of a face; triangle depths remain exact.
        float edge = 1.0 - smoothstep(0.001, 0.018, min(bary.x, min(bary.y, bary.z)));
        vec3 roundN = normalize(o + d * t);
        normal = normalize(uDie * normalize(mix(flatN, roundN, edge * 0.48)));
    }
    return face >= 0;
}

float microfacet(vec3 n, vec3 v, vec3 l, float roughness) {
    float nv = max(0.001, dot(n, v));
    float nl = max(0.001, dot(n, l));
    vec3 h = normalize(v + l);
    float nh = max(0.0, dot(n, h));
    float vh = max(0.0, dot(v, h));
    float a = roughness * roughness;
    float a2 = a * a;
    float den = nh * nh * (a2 - 1.0) + 1.0;
    float distribution = a2 / (PI * den * den);
    float gv = 2.0 * nv / (nv + sqrt(a2 + (1.0 - a2) * nv * nv));
    float gl = 2.0 * nl / (nl + sqrt(a2 + (1.0 - a2) * nl * nl));
    float f = dielectricFresnel(vh, 1.333, 1.49);
    return distribution * gv * gl * f / max(0.004, 4.0 * nv * nl);
}

float windowClearance(vec2 backXY, vec3 glassDirection, vec3 airDirection) {
    if (glassDirection.z <= 0.0 || airDirection.z <= 0.0) return -1e9;
    // A light path must pass both ends of the finite pane and the recessed
    // chamfer. Convex circular cross-sections make these endpoint tests enough.
    vec2 frontXY = backXY + glassDirection.xy *
        ((GLASS_FRONT - GLASS_BACK) / glassDirection.z);
    vec2 rimXY = frontXY + airDirection.xy *
        ((LIP_TOP - GLASS_FRONT) / airDirection.z);
    return min(APERTURE_R - max(length(backXY), length(frontXY)),
               CUT_R - length(rimXY));
}

vec3 dieLight(vec3 p, vec3 n, vec3 v, vec3 albedo,
              vec3 sourceDirection, vec3 incidentIrradiance) {
    vec3 airL = normalize(transpose(uBall) * sourceDirection);
    if (airL.z <= 0.0) return vec3(0.0);
    // A parallel glass slab preserves the net air-to-liquid Snell angle.
    vec3 l = -refract(-airL, UP, 1.0 / 1.333);
    float lightDistance = max(0.0, (GLASS_BACK - p.z) / max(0.001, l.z));
    vec2 atWindow = p.xy + l.xy * lightDistance;
    float nl = max(0.0, dot(n, l));
    float fAirGlass = dielectricFresnel(airL.z, 1.0, 1.49);
    vec3 g = -refract(-airL, UP, 1.0 / 1.49);
    float visibility = smoothstep(-0.006, 0.006, windowClearance(atWindow, g, airL));
    float fGlassLiquid = dielectricFresnel(g.z, 1.49, 1.333);
    float transmission = (1.0 - fAirGlass) * (1.0 - fGlassLiquid);
    vec3 irradiance = incidentIrradiance * transmission * visibility * exp(-EXTINCTION * lightDistance);
    float specular = microfacet(n, v, l, 0.31);
    return irradiance * nl * (albedo / PI + vec3(specular));
}

vec3 shadeDie(vec3 p, vec3 n, vec3 v, vec3 bary, int face) {
    vec2 faceUV = bary.x * vec2(0.5, 0.94)
                + bary.y * vec2(0.04, 0.08)
                + bary.z * vec2(0.96, 0.08);
    float column = float(face % 5);
    float row = float(face / 5);
    vec2 uv = vec2((column + faceUV.x) / 5.0, (3.0 - row + faceUV.y) / 4.0);
    float letter = texture(uAtlas, uv).a;
    vec3 albedo = mix(vec3(0.018, 0.055, 0.21), vec3(0.93, 0.96, 1.0), letter);
    // Integrate a large key softbox and weaker studio fill through the aperture.
    // Every sample retains its own physical fluid path length at this fragment.
    vec3 color = vec3(0.0);
    for (int j = 0; j < 6; ++j) {
        float x = float(j % 3) - 1.0;
        float y = float(j / 3) * 2.0 - 1.0;
        vec3 source = normalize(vec3(-1.7 + x * 1.2, 2.5 + y * 1.15, 3.4));
        color += dieLight(p, n, v, albedo, source, vec3(1.42, 1.39, 1.33));
    }
    color += dieLight(p, n, v, albedo, normalize(vec3(2.9, 0.3, 1.5)), vec3(0.46, 0.58, 0.78));
    color += dieLight(p, n, v, albedo, normalize(vec3(-0.12, 0.82, 4.0)), vec3(0.46, 0.49, 0.55));
    color += dieLight(p, n, v, albedo, normalize(vec3(0.0, -0.8, 4.0)), vec3(0.15, 0.18, 0.25));
    return color;
}

vec3 liquidScatter(vec3 origin, vec3 direction, float distance) {
    // Integrate weak single scattering against a downward-decaying light field.
    float factor = 1.0 - direction.z / 0.94;
    vec3 integral = abs(factor) < 0.0001 ? vec3(distance) :
        (vec3(1.0) - exp(-EXTINCTION * factor * distance)) / (EXTINCTION * factor);
    vec3 source = vec3(0.011, 0.027, 0.063) *
        exp(-EXTINCTION * max(0.0, GLASS_BACK - origin.z) / 0.94);
    return source * integral;
}

// Secondary bubble rays terminate on the die, the black chamber, or the window.
// They do not recurse through other bubbles. Camera-side air interfaces are
// explicitly traced; focused illumination caustics are not photon-mapped.
vec3 traceLiquid(vec3 origin, vec3 direction, out float terminalDistance) {
    vec3 normal, bary;
    int face;
    bool foundDie = dieHit(origin, direction, terminalDistance, normal, bary, face);
    if (!foundDie) {
        float nearT, farT;
        terminalDistance = 2.5;
        if (sphereHit(origin, direction, CHAMBER_R, nearT, farT)) terminalDistance = max(0.0, farT);
    }
    vec3 radiance = vec3(0.0);
    float windowDistance = direction.z > 0.0001 ?
        (GLASS_BACK - origin.z) / direction.z : 1e9;
    vec3 windowPoint = origin + direction * windowDistance;
    if (windowDistance > 0.00001 && windowDistance < terminalDistance &&
        length(windowPoint.xy) < APERTURE_R) {
        terminalDistance = windowDistance;
        vec3 glassDirection = refract(direction, -UP, 1.333 / 1.49);
        vec3 airDirection = refract(glassDirection, -UP, 1.49);
        if (dot(airDirection, airDirection) > 0.5 &&
            windowClearance(windowPoint.xy, glassDirection, airDirection) > 0.0) {
            float fLG = dielectricFresnel(direction.z, 1.333, 1.49);
            float fGA = dielectricFresnel(glassDirection.z, 1.49, 1.0);
            float transmission = (1.0 - fLG) * (1.0 - fGA) /
                max(0.0001, 1.0 - fLG * fGA);
            radiance = environment(uBall * airDirection, 0.006) * transmission;
        }
    } else if (foundDie) {
        vec3 p = origin + direction * terminalDistance;
        radiance = shadeDie(p, normal, -direction, bary, face);
    }
    return radiance * exp(-EXTINCTION * terminalDistance) +
        liquidScatter(origin, direction, terminalDistance);
}

vec3 addNearestBubble(vec3 origin, vec3 direction, float opaqueDistance, vec3 background) {
    float nearest = opaqueDistance;
    int index = -1;
    for (int i = 0; i < 12; ++i) {
        float radius = uBubbles[i].w;
        if (radius <= 0.0) continue;
        vec3 relativeOrigin = origin - uBubbles[i].xyz;
        float b = dot(relativeOrigin, direction);
        float h = b * b - dot(relativeOrigin, relativeOrigin) + radius * radius;
        if (h < 0.0) continue;
        float t = -b - sqrt(h);
        // An opaque die always hides bubbles behind its first surface.
        if (t > 0.00001 && t < nearest) { nearest = t; index = i; }
    }
    if (index < 0) return background;
    vec3 center = uBubbles[index].xyz;
    vec3 entry = origin + direction * nearest;
    vec3 n = normalize(entry - center);
    float entryF = dielectricFresnel(-dot(direction, n), 1.333, 1.0);
    vec3 reflectionDirection = reflect(direction, n);
    float unusedDistance;
    vec3 radiance = entryF * traceLiquid(entry + n * 0.00002,
        reflectionDirection, unusedDistance);
    vec3 airDirection = refract(direction, n, 1.333);
    // Beyond the critical angle, the water/air sphere is a total reflector.
    if (dot(airDirection, airDirection) > 0.5) {
        vec3 insidePoint = entry;
        float throughput = 1.0 - entryF;
        // Keep the transmitted path plus two weaker internal reflections.
        for (int bounce = 0; bounce < 3; ++bounce) {
            float airDistance = max(0.0, -2.0 * dot(insidePoint - center, airDirection));
            vec3 exitPoint = insidePoint + airDirection * airDistance;
            vec3 exitNormal = normalize(exitPoint - center);
            float exitF = dielectricFresnel(dot(airDirection, exitNormal), 1.0, 1.333);
            vec3 exitDirection = refract(airDirection, -exitNormal, 1.0 / 1.333);
            radiance += throughput * (1.0 - exitF) * traceLiquid(
                exitPoint + exitNormal * 0.00002, exitDirection, unusedDistance);
            throughput *= exitF;
            insidePoint = exitPoint;
            airDirection = reflect(airDirection, exitNormal);
            if (throughput < 0.001) break;
        }
    }
    return radiance * exp(-EXTINCTION * nearest) + liquidScatter(origin, direction, nearest);
}

vec3 shadeWindow(vec3 pane, vec3 ray) {
    float fAG = dielectricFresnel(-ray.z, 1.0, 1.49);
    vec3 glassRay = refract(ray, UP, 1.0 / 1.49);
    float glassDistance = (GLASS_BACK - GLASS_FRONT) / glassRay.z;
    vec3 liquidOrigin = pane + glassRay * glassDistance;
    // At oblique views the physical rim occludes the edge of the slab.
    if (length(liquidOrigin.xy) > APERTURE_R) {
        vec3 sideN = normalize(vec3(-liquidOrigin.xy, 0.1));
        return shadePlastic(pane, sideN, ray, true);
    }
    float fGL = dielectricFresnel(-glassRay.z, 1.49, 1.333);
    vec3 liquidRay = refract(glassRay, UP, 1.49 / 1.333);
    float hitDistance;
    vec3 normal, bary;
    int face;
    vec3 liquid = vec3(0.0);
    if (dieHit(liquidOrigin, liquidRay, hitDistance, normal, bary, face)) {
        vec3 p = liquidOrigin + liquidRay * hitDistance;
        liquid = shadeDie(p, normal, -liquidRay, bary, face) * exp(-EXTINCTION * hitDistance);
    } else {
        float nearT, farT;
        hitDistance = 2.5;
        if (sphereHit(liquidOrigin, liquidRay, CHAMBER_R, nearT, farT)) hitDistance = max(0.0, farT);
    }
    liquid += liquidScatter(liquidOrigin, liquidRay, hitDistance);
    liquid = addNearestBubble(liquidOrigin, liquidRay, hitDistance, liquid);
    vec3 reflected = environment(uBall * reflect(ray, UP), 0.007);
    // Closed-form sum of the incoherent internal reflections of a parallel slab.
    float denominator = max(0.0001, 1.0 - fAG * fGL);
    float reflectedWeight = fAG + (1.0 - fAG) * (1.0 - fAG) * fGL / denominator;
    float transmittedWeight = (1.0 - fAG) * (1.0 - fGL) / denominator;
    vec3 glassAbsorption = exp(-vec3(0.020, 0.014, 0.009) * glassDistance);
    return reflected * reflectedWeight + liquid * transmittedWeight * glassAbsorption;
}

vec3 displayTransform(vec3 x) {
    // ACES fitted display transform, then the sRGB transfer function.
    x *= 0.97 + 0.03 * clamp(uLightMode, 0.0, 1.0);
    x = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    vec3 lo = x * 12.92;
    vec3 hi = 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055;
    return mix(lo, hi, step(vec3(0.0031308), x));
}

void main() {
    vec2 screen = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y * 1.18;
    vec3 worldOrigin = vec3(-uOffset, 9.4);
    vec3 worldRay = normalize(vec3(screen, -1.9));
    vec3 ro = transpose(uBall) * worldOrigin;
    vec3 rd = transpose(uBall) * worldRay;
    float b = dot(ro, rd);
    float discriminant = b * b - dot(ro, ro) + BALL_R * BALL_R;
    float pixelWidth = max(0.0001, fwidth(discriminant));
    float alpha = smoothstep(-0.6 * pixelWidth, 0.6 * pixelWidth, discriminant);
    if (alpha <= 0.0) { fragColor = vec4(0.0); return; }
    float sphereT = -b - sqrt(max(0.0, discriminant));
    if (sphereT < 0.0) { fragColor = vec4(0.0); return; }
    vec3 p = ro + sphereT * rd;
    vec3 color;
    if (p.z <= 0.0 || length(p.xy) >= CUT_R) {
        color = shadePlastic(p, normalize(p), rd, false);
    } else {
        vec3 lipNormal;
        float lipT = lipHit(ro, rd, lipNormal);
        float paneT = rd.z < -0.00001 ? (GLASS_FRONT - ro.z) / rd.z : 1e9;
        vec3 pane = ro + rd * paneT;
        if (paneT > 0.0 && length(pane.xy) <= APERTURE_R && paneT < lipT) {
            color = shadeWindow(pane, rd);
        } else if (lipT < 1e8) {
            color = shadePlastic(ro + rd * lipT, lipNormal, rd, true);
        } else {
            color = vec3(0.004, 0.007, 0.016);
        }
    }
    fragColor = vec4(displayTransform(color), alpha);
}



