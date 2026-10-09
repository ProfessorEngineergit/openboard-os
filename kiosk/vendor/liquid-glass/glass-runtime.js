var MegaGlass=(()=>{var ee=Object.defineProperty;var rt=Object.getOwnPropertyDescriptor;var at=Object.getOwnPropertyNames;var ot=Object.prototype.hasOwnProperty;var nt=(s,e)=>{for(var t in e)ee(s,t,{get:e[t],enumerable:!0})},lt=(s,e,t,i)=>{if(e&&typeof e=="object"||typeof e=="function")for(let a of at(e))!ot.call(s,a)&&a!==t&&ee(s,a,{get:()=>e[a],enumerable:!(i=rt(e,a))||i.enumerable});return s};var ht=s=>lt(ee({},"__esModule",{value:!0}),s);var di={};nt(di,{IOR_RENDERER:()=>ui,WebGLGlass:()=>J,invalidatePageContent:()=>me,paintPageContent:()=>de});var G=`#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`,xe=`#version 300 es
in vec2 aPos;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform vec2 uHalf;
uniform float uPad;
out vec2 vUV;
void main() {
  vec2 half2 = uHalf + uPad;
  vec2 px = uCenter + (aPos * 2.0 - 1.0) * half2;
  vUV = px / uRes;
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
}`,ye=`#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 outColor;
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
             12.92 * c,
             lessThanEqual(c, vec3(0.0031308)));
}
void main() { outColor = vec4(linearToSrgb(texture(uTex, vUV).rgb), 1.0); }`,we=`#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;   // texel size of the SOURCE level
out vec4 outColor;
void main() {
  vec2 t = uTexel;
  vec4 a = texture(uTex, vUV) * 0.125;
  vec4 b = (texture(uTex, vUV + vec2(-t.x, -t.y)) +
            texture(uTex, vUV + vec2( t.x, -t.y)) +
            texture(uTex, vUV + vec2(-t.x,  t.y)) +
            texture(uTex, vUV + vec2( t.x,  t.y))) * 0.125;
  vec4 c = (texture(uTex, vUV + vec2(-2.0 * t.x, 0.0)) +
            texture(uTex, vUV + vec2( 2.0 * t.x, 0.0)) +
            texture(uTex, vUV + vec2(0.0, -2.0 * t.y)) +
            texture(uTex, vUV + vec2(0.0,  2.0 * t.y))) * 0.0625;
  vec4 d = (texture(uTex, vUV + vec2(-2.0 * t.x, -2.0 * t.y)) +
            texture(uTex, vUV + vec2( 2.0 * t.x, -2.0 * t.y)) +
            texture(uTex, vUV + vec2(-2.0 * t.x,  2.0 * t.y)) +
            texture(uTex, vUV + vec2( 2.0 * t.x,  2.0 * t.y))) * 0.03125;
  // RGB stores radiance. Alpha stores normalized optical density, so the mip
  // chain can blur both representations with exactly the same footprint.
  outColor = a + b + c + d;
}`,Se=`#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uLow;
uniform sampler2D uHigh;
uniform vec2 uLowTexel;
out vec4 outColor;
void main() {
  vec2 t = uLowTexel;
  vec4 low = texture(uLow, vUV) * 4.0;
  low += (texture(uLow, vUV + vec2( t.x, 0.0)) +
          texture(uLow, vUV + vec2(-t.x, 0.0)) +
          texture(uLow, vUV + vec2(0.0,  t.y)) +
          texture(uLow, vUV + vec2(0.0, -t.y))) * 2.0;
  low += texture(uLow, vUV + vec2( t.x,  t.y)) +
         texture(uLow, vUV + vec2(-t.x,  t.y)) +
         texture(uLow, vUV + vec2( t.x, -t.y)) +
         texture(uLow, vUV + vec2(-t.x, -t.y));
  low *= 1.0 / 16.0;
  vec4 high = texture(uHigh, vUV);
  outColor = mix(high, low, 0.65);
}`,Te=`#version 300 es
precision highp float;
in vec2 vUV;
uniform vec2 uRes;
uniform int uScene;
uniform float uZoom;
uniform sampler2D uWallpaper;
uniform int uUseImage;
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 srgbToLinear(vec3 c) {
  bvec3 cutoff = lessThanEqual(c, vec3(0.04045));
  vec3 low = c / 12.92;
  vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(high, low, cutoff);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.02; a *= 0.5; }
  return s;
}
// distance to a quadratic bezier (iterative, good enough for a backdrop)
float sdBezier(vec2 p, vec2 a, vec2 b, vec2 c) {
  float best = 1e9;
  vec2 prev = a;
  for (int i = 1; i <= 40; i++) {
    float t = float(i) / 40.0;
    vec2 q = mix(mix(a, b, t), mix(b, c, t), t);
    vec2 pa = p - prev, ba = q - prev;
    float u = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
    best = min(best, length(pa - ba * u));
    prev = q;
  }
  return best;
}

vec3 sunsetBranches(vec2 uv) {
  // dusk gradient: cool grey-mauve at the top, warm amber near the horizon
  vec3 top = vec3(0.62, 0.55, 0.55);
  vec3 mid = vec3(0.85, 0.63, 0.53);
  vec3 low = vec3(0.94, 0.70, 0.52);
  vec3 col = mix(mid, top, smoothstep(0.45, 1.0, uv.y));
  col = mix(col, low, smoothstep(0.45, 0.0, uv.y));
  col += (fbm(uv * 3.0) - 0.5) * 0.05;

  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  float sc = uRes.x / uRes.y;
  vec3 bark = vec3(0.17, 0.10, 0.09);
  // main trunk + a few branches, thick and dark like the reference photo
  float d = sdBezier(p, vec2(0.42 * sc, -0.1), vec2(0.52 * sc, 0.45), vec2(0.36 * sc, 1.1));
  float m = smoothstep(0.060, 0.040, d);
  d = sdBezier(p, vec2(0.40 * sc, 0.30), vec2(0.62 * sc, 0.44), vec2(0.95 * sc, 0.26));
  m = max(m, smoothstep(0.034, 0.020, d));
  d = sdBezier(p, vec2(0.44 * sc, 0.62), vec2(0.25 * sc, 0.80), vec2(0.05 * sc, 0.72));
  m = max(m, smoothstep(0.022, 0.010, d));
  d = sdBezier(p, vec2(0.46 * sc, 0.80), vec2(0.72 * sc, 0.95), vec2(1.05 * sc, 0.78));
  m = max(m, smoothstep(0.016, 0.007, d));
  d = sdBezier(p, vec2(0.12 * sc, -0.05), vec2(0.18 * sc, 0.5), vec2(0.06 * sc, 1.05));
  m = max(m, smoothstep(0.038, 0.022, d));
  // seed pods
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 c = vec2((0.14 + 0.02 * fi) * sc, 0.30 + 0.26 * fi);
    m = max(m, smoothstep(0.035, 0.022, length((p - c) * vec2(1.0, 0.8))));
  }
  return mix(col, bark, m * 0.94);
}

vec3 deepBlueCity(vec2 uv) {
  vec3 col = mix(vec3(0.06, 0.14, 0.55), vec3(0.02, 0.06, 0.34), smoothstep(0.0, 1.0, uv.y));
  col += (fbm(uv * vec2(90.0, 90.0)) - 0.5) * 0.05;   // fabric-like dither
  // bright vertical tower strip
  float x = abs(uv.x - 0.5);
  float tower = smoothstep(0.035, 0.012, x) * smoothstep(0.02, 0.25, uv.y);
  col = mix(col, vec3(0.72, 0.58, 0.52), tower * 0.85);
  float glow = smoothstep(0.16, 0.0, x) * smoothstep(0.0, 0.5, uv.y) * 0.18;
  col += vec3(0.5, 0.42, 0.36) * glow;
  col = mix(col, vec3(0.10, 0.14, 0.26), smoothstep(0.16, 0.02, uv.y));
  return col;
}

vec3 islandOcean(vec2 uv) {
  float ar = uRes.x / uRes.y;
  vec3 deep = vec3(0.03, 0.26, 0.52);
  vec3 shallow = vec3(0.20, 0.74, 0.82);
  float waves = fbm(vec2(uv.x * ar * 6.0, uv.y * 22.0) + 3.0);
  vec3 col = mix(deep, shallow, smoothstep(0.30, 0.78, waves * 0.7 + uv.y * 0.5));

  vec2 p = (uv - vec2(0.5, 0.40)) * vec2(ar, 1.0);
  float isl = (fbm(p * 2.2 + 11.0) - 0.5) * 0.34;
  float d = length(p * vec2(0.62, 1.25)) - (0.42 + isl);
  // shallow reef ring around the land
  col = mix(col, vec3(0.42, 0.86, 0.86), smoothstep(0.14, 0.03, d) * 0.75);
  col = mix(col, vec3(0.94, 0.90, 0.72), smoothstep(0.035, 0.0, d));        // beach
  vec3 jungle = mix(vec3(0.04, 0.26, 0.09), vec3(0.24, 0.55, 0.20),
                    fbm(p * 9.0 + 5.0));
  col = mix(col, jungle, smoothstep(0.005, -0.02, d));                      // jungle
  return col;
}

vec2 coverUV(vec2 uv) {
  vec2 imageSize = vec2(textureSize(uWallpaper, 0));
  float imageAspect = imageSize.x / max(imageSize.y, 1.0);
  float viewportAspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = uv;
  if (imageAspect > viewportAspect) {
    float crop = (imageAspect / viewportAspect - 1.0) * 0.5;
    p.x = p.x * (1.0 - 2.0 * crop) + crop;
  } else {
    float crop = (viewportAspect / imageAspect - 1.0) * 0.5;
    p.y = p.y * (1.0 - 2.0 * crop) + crop;
  }
  return clamp(p, vec2(0.001), vec2(0.999));
}

void main() {
  vec2 uv = (vUV - 0.5) / max(uZoom, 0.01) + 0.5;
  vec3 col;
  if (uUseImage == 1) {
    // Wallpaper textures are plain RGBA8 holding display/sRGB values; decode
    // to linear radiance here. They are uploaded top row first (no
    // UNPACK_FLIP_Y_WEBGL), so the lookup flips instead.
    vec2 wallpaperUV = coverUV(uv);
    wallpaperUV.y = 1.0 - wallpaperUV.y;
    col = srgbToLinear(texture(uWallpaper, wallpaperUV).rgb);
  } else {
    // Procedural palette constants are authored as display/sRGB colours. The
    // SRGB render target expects linear shader output and encodes it on write.
    col = srgbToLinear(uScene == 0 ? sunsetBranches(uv)
                       : uScene == 1 ? deepBlueCity(uv)
                                     : islandOcean(uv));
  }
  // Beer-Lambert representation of backdrop darkness. A value of 4 optical
  // density units already corresponds to ~1.8% transmission, enough for the
  // near-black branches while retaining useful precision in RGBA8.
  float lum = max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 0.018);
  float density = clamp(-log(lum) / 4.0, 0.0, 1.0);
  outColor = vec4(col, density);
}`,Ee=`#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform sampler2D uSrc;      // blurred mip chain of the backdrop
uniform sampler2D uBlurSrc;  // tent-upsampled reconstruction chain
uniform vec2  uRes;
uniform vec2  uCenter;       // draw-group bounds centre, px (vertex quad only)
uniform vec2  uHalf;         // element half size, px
const int MAX_SHAPES = 16;
uniform int   uShapeCount;
uniform vec2  uShapeCenters[MAX_SHAPES];
uniform vec2  uShapeHalves[MAX_SHAPES];
uniform int   uShapeTypes[MAX_SHAPES]; // 0 square/rect, 1 capsule, 2 circle
uniform float uShapeRadii[MAX_SHAPES];
uniform float uMergeRadius;  // smooth-union reach, px
uniform float uSquircle;     // superellipse exponent (2 = circular corners)
uniform float uBevel;        // max width of the refracting rim, px
uniform float uHeight;       // max glass height / optical thickness, px
uniform float uSizeAdaptation;// 0 = absolute material lengths, 1 = fit small UI
uniform float uIOR;
uniform float uDispersion;
uniform float uBlurPlateau;  // blur radius in the middle, px
uniform float uBlurRim;      // blur radius at the rim, px
uniform float uOpticalDensity;// dark-detail preservation; 0 = linear radiance
uniform float uMips;         // number of levels in the blurred chain
uniform float uSpecular;
uniform float uSpecPower;
uniform float uHighlightAdapt;
uniform float uHighlightWidth;
uniform float uHighlightSharpness;
uniform float uHighlightBase;
uniform float uFresnel;
uniform float uSat;
uniform float uBright;
uniform float uTintAmount;
uniform vec3  uTintColor;
uniform float uTintAdapt;    // content-aware light/dark material polarity
uniform float uShadow;
uniform float uShadowSize;
uniform float uShadowOffset;
uniform vec2  uLightDir;
uniform float uEdgeLine;
uniform float uEdgeWidth;
uniform float uEdgeDark;
uniform float uRefractScale;
uniform float uMeniscus;     // 1 = concave meniscus rim, 0 = convex lens rim
uniform int   uDebug;        // 0 final, 1 thickness, 2 normals, 3 displacement

float sdSquircle(vec2 p, vec2 b, float r, float n) {
  vec2 q = abs(p) - b + r;
  vec2 m = max(q, 0.0) + 1e-5;
  float e = pow(pow(m.x, n) + pow(m.y, n), 1.0 / n);
  return min(max(q.x, q.y), 0.0) + e - r;
}

float sdPrimitive(vec2 p, vec2 halfSize, int shapeType, float radius) {
  if (shapeType == 2) {
    // Circle is invariant: layout cannot turn it into an ellipse.
    return length(p) - min(halfSize.x, halfSize.y);
  }
  if (shapeType == 1) {
    // Apple's capsule rule: end-cap radius is exactly half the short side.
    return sdSquircle(p, halfSize, min(halfSize.x, halfSize.y), 2.0);
  }
  // Square and rectangular folders share the same fixed-radius corner model;
  // only their bounding boxes differ. The default exponent is 2 per reference.
  return sdSquircle(p, halfSize, radius, max(uSquircle, 2.0));
}

// One distance field represents the complete component group. Because the
// normal is derived from this same field below, the meniscus, refraction and
// highlight bend continuously through the bridge instead of exposing two
// composited glass layers.
float sdAppleShape(vec2 px) {
  float nearest = 1e8;
  for (int i = 0; i < MAX_SHAPES; i++) {
    if (i >= uShapeCount) break;
    float next = sdPrimitive(px - uShapeCenters[i], uShapeHalves[i],
                             uShapeTypes[i], uShapeRadii[i]);
    nearest = min(nearest, next);
  }

  if (uMergeRadius < 0.01) return nearest;

  // Global exponential smooth-min is associative and C-infinity. Pairwise
  // polynomial unions are only C1 and become order-dependent with 3+ shapes;
  // their curvature boundaries show up as diagonal tears under sharp glass
  // highlights. 0.36 matches the polynomial union's depth at equal distances.
  float scale = max(uMergeRadius * 0.36, 0.01);
  float sum = 0.0;
  for (int i = 0; i < MAX_SHAPES; i++) {
    if (i >= uShapeCount) break;
    float next = sdPrimitive(px - uShapeCenters[i], uShapeHalves[i],
                             uShapeTypes[i], uShapeRadii[i]);
    sum += exp(-(next - nearest) / scale);
  }
  return nearest - scale * log(max(sum, 1e-6));
}

// Quintic tangent transition. Besides value and slope, its second derivative
// matches at both ends: f(0/1)=0/1, f'(0/1)=0/1, f''(0/1)=0. This lets a
// circular corner leave a straight side with zero curvature instead of the
// rounded-box SDF's abrupt 0 -> 1/r curvature jump.
float tangentTransition(float u) {
  return u * u * u * (6.0 - 8.0 * u + 3.0 * u * u);
}

vec2 primitiveOpticalGradient(vec2 p, vec2 halfSize,
                              int shapeType, float radius) {
  if (shapeType == 2) return normalize(p + 1e-6);

  float exponent = shapeType == 1 ? 2.0 : max(uSquircle, 2.0);
  float resolvedRadius = shapeType == 1
                       ? min(halfSize.x, halfSize.y) : radius;
  vec2 q = abs(p) - halfSize + resolvedRadius;
  vec2 direction;

  if (q.x > 0.0 && q.y > 0.0) {
    // Analytic Lp-corner normal. Exponents above 2 already approach the side
    // with zero curvature; blend out the circular-corner correction by n=3.
    vec2 lp = normalize(pow(q, vec2(exponent - 1.0)) + 1e-6);
    const float HALF_PI = 1.57079632679;
    const float TRANSITION_ANGLE = 0.43633231299; // 25 degrees at each tangent
    float angle = atan(q.y, q.x);
    float easedAngle = angle;
    if (angle < TRANSITION_ANGLE) {
      easedAngle = TRANSITION_ANGLE *
                   tangentTransition(angle / TRANSITION_ANGLE);
    } else if (angle > HALF_PI - TRANSITION_ANGLE) {
      float fromTop = (HALF_PI - angle) / TRANSITION_ANGLE;
      easedAngle = HALF_PI - TRANSITION_ANGLE *
                   tangentTransition(fromTop);
    }
    vec2 continuousCorner = vec2(cos(easedAngle), sin(easedAngle));
    float circularCorner = 1.0 - smoothstep(2.0, 3.0, exponent);
    direction = normalize(mix(lp, continuousCorner, circularCorner));
  } else if (q.x > q.y) {
    direction = vec2(1.0, 0.0);
  } else {
    direction = vec2(0.0, 1.0);
  }

  return direction * sign(p);
}

vec2 opticalGradient(vec2 px) {
  float nearest = 1e8;
  int nearestIndex = 0;
  for (int i = 0; i < MAX_SHAPES; i++) {
    if (i >= uShapeCount) break;
    float next = sdPrimitive(px - uShapeCenters[i], uShapeHalves[i],
                             uShapeTypes[i], uShapeRadii[i]);
    if (next < nearest) {
      nearest = next;
      nearestIndex = i;
    }
  }

  if (uMergeRadius < 0.01 || uShapeCount == 1) {
    return primitiveOpticalGradient(
      px - uShapeCenters[nearestIndex], uShapeHalves[nearestIndex],
      uShapeTypes[nearestIndex], uShapeRadii[nearestIndex]
    );
  }

  // The derivative of exponential smooth-min is the same weighted average of
  // the primitive derivatives. Reusing those weights keeps fused normals C2
  // through both a primitive's tangent and the union bridge.
  float scale = max(uMergeRadius * 0.36, 0.01);
  vec2 gradientSum = vec2(0.0);
  float weightSum = 0.0;
  for (int i = 0; i < MAX_SHAPES; i++) {
    if (i >= uShapeCount) break;
    vec2 local = px - uShapeCenters[i];
    float next = sdPrimitive(local, uShapeHalves[i],
                             uShapeTypes[i], uShapeRadii[i]);
    float weight = exp(-(next - nearest) / scale);
    gradientSum += primitiveOpticalGradient(
      local, uShapeHalves[i], uShapeTypes[i], uShapeRadii[i]
    ) * weight;
    weightSum += weight;
  }
  return gradientSum / max(weightSum, 1e-6);
}

// Shading adaptation belongs to the primitive under this fragment, not to the
// bounds of the whole draw group. The latter changes whenever any component in
// a connected fusion group moves, making every highlight pulse in sympathy.
//
// Around a genuine smooth-union bridge, use the same exponential influence as
// the distance field so the material centre crosses continuously from one
// primitive to the next. Contributions too weak to affect the visible bridge
// are smoothly discarded; a nearby-but-separate component then has exactly no
// influence on this component's highlight or light/dark tint.
void localComponentMetrics(vec2 px, out vec2 componentCenter,
                           out float componentShortSide) {
  float nearest = 1e8;
  vec2 nearestCenter = uShapeCenters[0];
  float nearestShortSide = 1.0;
  for (int i = 0; i < MAX_SHAPES; i++) {
    if (i >= uShapeCount) break;
    float next = sdPrimitive(px - uShapeCenters[i], uShapeHalves[i],
                             uShapeTypes[i], uShapeRadii[i]);
    if (next < nearest) {
      nearest = next;
      nearestCenter = uShapeCenters[i];
      nearestShortSide = 2.0 * min(uShapeHalves[i].x, uShapeHalves[i].y);
    }
  }

  componentCenter = nearestCenter;
  componentShortSide = nearestShortSide;
  if (uMergeRadius < 0.01 || uShapeCount == 1) return;

  float scale = max(uMergeRadius * 0.36, 0.01);
  vec2 centreSum = vec2(0.0);
  float shortSideSum = 0.0;
  float weightSum = 0.0;
  for (int i = 0; i < MAX_SHAPES; i++) {
    if (i >= uShapeCount) break;
    float next = sdPrimitive(px - uShapeCenters[i], uShapeHalves[i],
                             uShapeTypes[i], uShapeRadii[i]);
    float weight = exp(-(next - nearest) / scale);
    weight *= smoothstep(0.04, 0.20, weight);
    centreSum += uShapeCenters[i] * weight;
    shortSideSum += 2.0 * min(uShapeHalves[i].x, uShapeHalves[i].y) * weight;
    weightSum += weight;
  }
  if (weightSum > 0.0) {
    componentCenter = centreSum / weightSum;
    componentShortSide = shortSideSum / weightSum;
  }
}

vec4 sampleBg(vec2 px, float lod) {
  vec2 uv = clamp(px / uRes, vec2(0.001), vec2(0.999));
  return textureLod(uSrc, uv, lod);
}

vec4 sampleReconstructedBg(vec2 px, float lod) {
  vec2 uv = clamp(px / uRes, vec2(0.001), vec2(0.999));
  return textureLod(uBlurSrc, uv, lod);
}

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
             12.92 * c,
             lessThanEqual(c, vec3(0.0031308)));
}

vec2 softLimitOffset(vec2 offset, float limit) {
  float magnitude = length(offset);
  if (magnitude < 1e-4) return offset;
  float limited = tanh(magnitude / max(limit, 1.0)) * limit;
  return offset * (limited / magnitude);
}

// Variable-radius blur, radius in device px.
//
// A single textureLod() tap on the mip chain is not enough. The chain only
// offers radii in powers of two, and on the top levels one texel is tens of
// pixels wide, so a lone bilinear tap (a) averages in a huge slab of the
// screen, which drags the colour toward the frame mean -> washed out, and
// (b) reconstructs as a handful of big diamonds -> the "too few samples" mush.
// Instead take the level whose own radius is about a third of what we want and
// spread TAPS samples over the remainder on a golden-angle spiral. Neighbouring
// taps then land roughly one texel apart at that level, which is exactly the
// spacing at which the level's own filtering makes the disc continuous, so the
// result is a real wide Gaussian that keeps its local colour.
const int TAPS = 12;
const float GOLDEN_ANGLE = 2.39996323;

vec3 blurBg(vec2 px, float radius) {
  if (radius < 1.0) return sampleBg(px, 0.0).rgb;
  float lod = clamp(log2(radius) - 1.585, 0.0, uMips - 1.0);   // 2^lod ~ r/3
  vec3 acc = vec3(0.0);
  float densityAcc = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < TAPS; i++) {
    float fi = float(i) + 0.5;
    float r  = sqrt(fi / float(TAPS));       // equal-area spacing over the disc
    float a  = fi * GOLDEN_ANGLE;
    float w  = exp(-1.8 * r * r);
    vec2 samplePx = px + vec2(cos(a), sin(a)) * r * radius;
    // Keep narrow blur faithful to the original downsample chain, then lean on
    // the reconstructed chain where coarse mip blocks and temporal breathing
    // become visible. Both samplers return linear radiance from sRGB textures.
    float reconstruction = 0.78 * smoothstep(10.0, 52.0, radius);
    vec4 s = mix(sampleBg(samplePx, lod),
                 sampleReconstructedBg(samplePx, lod), reconstruction);
    acc += s.rgb * w;
    densityAcc += s.a * w;
    wsum += w;
  }
  vec3 linearCol = acc / wsum;

  // A pure radiance average spreads a dark branch but also dilutes it toward
  // the pale sky. The density channel averages -log(luminance), equivalent to
  // geometrically averaging transmission. That preserves the visual weight of
  // dark occluders while keeping uniform light regions unchanged. We retain
  // the linear RGB hue and only restore the missing luminance contrast.
  float linearLum = max(dot(linearCol, vec3(0.2126, 0.7152, 0.0722)), 0.001);
  float densityLum = exp(-4.0 * densityAcc / wsum);
  float densityGap = max(linearLum - densityLum, 0.0);
  float radiusGate = smoothstep(1.0, 8.0, radius);
  float targetLum = max(linearLum * 0.22,
                        linearLum - densityGap * uOpticalDensity * radiusGate);
  return linearCol * (targetLum / linearLum);
}

void main() {
  vec2 px = vUV * uRes;

  float d = sdAppleShape(px);
  float aa = smoothstep(0.8, -0.8, d);
  vec2 adaptCenter;
  float localShortSide;
  localComponentMetrics(px, adaptCenter, localShortSide);
  // Material lengths are authored against the large demo components. Treat
  // them as maxima and fit the complete optical system to 30% of a smaller
  // primitive's short side. The shared metric call above also keeps this scale
  // continuous when differently sized primitives form one fused surface.
  float fittedScale = clamp(0.30 * localShortSide / max(uBevel, 1.0), 0.05, 1.0);
  float opticalScale = mix(1.0, fittedScale,
                           clamp(uSizeAdaptation, 0.0, 1.0));
  float bevel = max(uBevel * opticalScale, 1.0);
  float opticalHeight = uHeight * opticalScale;

  // ---- gradient of the SDF = outward direction of the surface -------------
  vec2 g = normalize(opticalGradient(px) + 1e-6);

  // ---- thickness field / bevel profile -----------------------------------
  float t  = clamp(-d / bevel, 0.0, 1.0);    // 0 at the edge, 1 on the plateau
  float ct = 1.0 - t;
  float h  = sqrt(max(1.0 - ct * ct, 0.0));  // convex (circular) bevel
  float dhdt = ct / max(h, 0.10);            // slope, clamped at the silhouette
  float slope = (opticalHeight / bevel) * dhdt;

  // 0 = convex lens, 1 = the default Apple-like concave rim. Values above 1
  // deliberately exaggerate the inward normal for exploratory tuning.
  float curveSign = 1.0 - 2.0 * uMeniscus;
  vec3 n = normalize(vec3(curveSign * g * slope, 1.0));
  vec3 I = vec3(0.0, 0.0, -1.0);

  // ---- refraction (Snell) + dispersion -----------------------------------
  float path = opticalHeight * mix(0.25, 1.0, h) * uRefractScale;
  vec2 dR, dG, dB;
  {
    float e = 1.0 / max(uIOR - uDispersion, 1.0);
    vec3 R = refract(I, n, e);
    dR = (R == vec3(0.0)) ? vec2(0.0) : R.xy / max(-R.z, 0.25) * path;
    e = 1.0 / max(uIOR, 1.0);
    R = refract(I, n, e);
    dG = (R == vec3(0.0)) ? vec2(0.0) : R.xy / max(-R.z, 0.25) * path;
    e = 1.0 / max(uIOR + uDispersion, 1.0);
    R = refract(I, n, e);
    dB = (R == vec3(0.0)) ? vec2(0.0) : R.xy / max(-R.z, 0.25) * path;
  }

  // Strong concave meniscus normals can make the screen-space mapping fold
  // over itself at multi-shape junctions. On hard-edged wallpapers that reads
  // as triangular tearing rather than refraction. Compress only the extreme
  // tail; ordinary offsets remain almost linear while caustic spikes stay
  // within a bevel-sized optical footprint.
  float maxDisplacement = max(1.15 * bevel, max(12.0 * opticalScale, 3.0));
  dR = softLimitOffset(dR, maxDisplacement);
  dG = softLimitOffset(dG, maxDisplacement);
  dB = softLimitOffset(dB, maxDisplacement);

  // ---- scattering: rim stays readable, plateau is frosted ----------------
  float radius = mix(uBlurRim, uBlurPlateau, smoothstep(0.0, 0.85, t))
               * opticalScale;

  vec3 col;
  col.r = blurBg(px + dR, radius).r;
  col.g = blurBg(px + dG, radius).g;
  col.b = blurBg(px + dB, radius).b;

  // Saturation is boosted on the TRANSMITTED backdrop only (this is what
  // UIVisualEffectView's saturationDeltaFactor does). Any wide blur averages
  // colours toward grey; without this the frosted panel reads pale even though
  // the wallpaper behind it is saturated. Doing it before the reflections keeps
  // the specular/Fresnel highlights neutral.
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, uSat);

  // ---- reflection: backdrop environment + narrow specular lobes -----------
  // Schlick: F0 for glass is ~4%, and the (1-cos)^5 falloff keeps the mirror
  // term confined to the steepest part of the bevel. A softer exponent smears
  // a grey wash across the whole rim and bleaches the refracted image there.
  float f0 = pow((uIOR - 1.0) / (uIOR + 1.0), 2.0);
  float fres = f0 + (1.0 - f0) * pow(1.0 - n.z, 5.0);
  vec2 nn = normalize(n.xy + 1e-6);

  // Keep the reflected environment local to the fragment. Stabilise the lobe
  // controls around the owning primitive below so hard wallpaper edges do not
  // chop one rim into unrelated bright and dark pieces.
  float probeLod = clamp(3.5 + log2(max(opticalScale, 0.05)),
                         0.0, uMips - 1.0);
  float probeRadius = max(1.35 * bevel, max(18.0 * opticalScale, 3.0));
  vec3 envL = sampleBg(px + vec2(-probeRadius, 0.0), probeLod).rgb;
  vec3 envR = sampleBg(px + vec2( probeRadius, 0.0), probeLod).rgb;
  vec3 envB = sampleBg(px + vec2(0.0, -probeRadius), probeLod).rgb;
  vec3 envT = sampleBg(px + vec2(0.0,  probeRadius), probeLod).rgb;
  vec2 fallbackLight = normalize(uLightDir + vec2(1e-5));
  // Highlight adaptation must be stable across one component. Driving its
  // strength and colour from each fragment's probe makes a mountain ridge or
  // tree line cut the rim into bright and dark pieces. Probe around the local
  // component centre while retaining per-fragment environment reflection.
  vec3 adaptL = sampleBg(adaptCenter + vec2(-probeRadius, 0.0), probeLod).rgb;
  vec3 adaptR = sampleBg(adaptCenter + vec2( probeRadius, 0.0), probeLod).rgb;
  vec3 adaptB = sampleBg(adaptCenter + vec2(0.0, -probeRadius), probeLod).rgb;
  vec3 adaptT = sampleBg(adaptCenter + vec2(0.0,  probeRadius), probeLod).rgb;
  vec2 adaptGradient = vec2(luminance(adaptR) - luminance(adaptL),
                            luminance(adaptT) - luminance(adaptB));
  float stableContrast = length(adaptGradient);
  float lightAdapt = clamp(uHighlightAdapt, 0.0, 1.0) *
                     smoothstep(0.025, 0.22, stableContrast);
  // Keep the lobe direction material-local. Steering it with the wallpaper
  // gradient creates a rapidly rotating direction field around hard colour
  // edges, which appears as diagonal tears and lets unrelated components alter
  // each other's highlights. The environment still adapts strength and colour.
  vec2 lightDir = fallbackLight;

  // Reflect the colour seen in the surface-normal direction. A local sample
  // keeps small bright structures (tower lights, clouds, coastlines) attached
  // to the nearby rim instead of turning every frame into the same white ring.
  float wx = clamp(0.5 + 0.5 * nn.x, 0.0, 1.0);
  float wy = clamp(0.5 + 0.5 * nn.y, 0.0, 1.0);
  vec3 envX = mix(envL, envR, wx);
  vec3 envY = mix(envB, envT, wy);
  vec3 ringEnv = (envX * abs(nn.x) + envY * abs(nn.y)) /
                 max(abs(nn.x) + abs(nn.y), 1e-3);
  float localProbeLod = clamp(2.0 + log2(max(opticalScale, 0.05)),
                              0.0, uMips - 1.0);
  vec3 localEnv = sampleBg(px + g * max(0.55 * bevel,
                                        max(6.0 * opticalScale, 2.0)),
                           localProbeLod).rgb;
  vec3 env = mix(ringEnv, localEnv, 0.58);
  float envLum = luminance(env);
  env = mix(env, vec3(envLum), 0.10); // retain wallpaper hue, tame neon spikes
  float envStrength = mix(0.58, 1.0, smoothstep(0.08, 0.75, envLum));
  col = mix(col, env, clamp(fres * uFresnel * envStrength, 0.0, 0.82));

  vec3 L1 = normalize(vec3(lightDir, 0.58));
  vec3 L2 = normalize(vec3(-lightDir, 0.48));
  float sharpness = max(uHighlightSharpness, 0.1);
  float s1 = pow(max(dot(n, L1), 0.0),
                 max(uSpecPower * sharpness, 1.0));
  float s2 = pow(max(dot(n, L2), 0.0),
                 max(uSpecPower * sharpness * 0.78, 1.0)) * 0.18;
  float highlightWidth = clamp(uHighlightWidth, 0.16, 1.0);
  float riseEnd = min(0.10, 0.25 * highlightWidth);
  float specBand = smoothstep(0.015, riseEnd, t) *
                   (1.0 - smoothstep(0.61 * highlightWidth,
                                     highlightWidth, t));
  float baseHighlight = clamp(uHighlightBase, 0.0, 1.0);
  float sourceStrength = baseHighlight + (1.0 - baseHighlight) * lightAdapt;
  vec3 sourceEnv = mix(mix(adaptL, adaptR, 0.5 + 0.5 * lightDir.x),
                       mix(adaptB, adaptT, 0.5 + 0.5 * lightDir.y), 0.5);
  float sourceLum = max(luminance(sourceEnv), 0.08);
  vec3 specColor = clamp(mix(vec3(1.0), sourceEnv / sourceLum, 0.42),
                         vec3(0.45), vec3(2.2));
  col += uSpecular * (s1 + s2) * specBand * sourceStrength * specColor;

  // Dark contour right at the silhouette: at grazing angles the rim reflects
  // the surroundings instead of transmitting, so real glass edges read dark.
  float w = max(uEdgeWidth, 0.5);
  float contour = smoothstep(w, 0.0, abs(d + 0.55 * w));
  col *= 1.0 - uEdgeDark * contour;

  // Crisp inner highlight line; direction and colour follow the local probe.
  float line = smoothstep(1.35 * w, 0.0, abs(d + 2.2 * w));
  float lit = 0.26 + 0.74 * max(dot(g, lightDir), 0.0);
  vec3 stableEnv = (adaptL + adaptR + adaptB + adaptT) * 0.25;
  float stableEnvLum = max(luminance(stableEnv), 0.12);
  vec3 lineColor = mix(vec3(1.0), stableEnv / stableEnvLum, 0.28);
  col += uEdgeLine * line * lit * lineColor;

  // ---- tint --------------------------------------------------------------
  // Tint polarity adapts once per local component, not per draw group.
  // This captures the system-material light/dark switch without letting a hard
  // background edge split one surface into visibly different materials.
  float materialLum = luminance(sampleBg(adaptCenter, uMips - 1.0).rgb);
  float useDarkMaterial = smoothstep(0.38, 0.68, materialLum);
  vec3 automaticTint = mix(vec3(0.97, 0.985, 1.0),
                           vec3(0.035, 0.055, 0.080), useDarkMaterial);
  vec3 resolvedTint = mix(uTintColor, automaticTint, clamp(uTintAdapt, 0.0, 1.0));
  float adaptiveAmount = uTintAmount * mix(1.10, 0.92, useDarkMaterial);
  col = mix(col, resolvedTint, clamp(adaptiveAmount, 0.0, 1.0));
  col += uBright;

  // ---- soft contact shadow ----------------------------------------------
  float ds = sdAppleShape(px + vec2(0.0, uShadowOffset));
  float sh = exp(-max(ds, 0.0) / max(uShadowSize, 0.5)) * uShadow;

  if (uDebug == 1) col = vec3(h);
  if (uDebug == 2) col = vec3(0.5 + 0.5 * n.xy, n.z);
  if (uDebug == 3) col = vec3(length(dG) / max(opticalHeight, 1.0),
                              length(dR - dB) / max(opticalHeight, 1.0) * 6.0, 0.0);

  // The browser drawing buffer stores display/sRGB values, unlike the explicit
  // SRGB8_ALPHA8 offscreen attachments. Encode the final linear material here,
  // then add triangular-distribution noise smaller than one display-space LSB.
  if (uDebug == 0) {
    float n0 = hash12(gl_FragCoord.xy + vec2(17.0, 59.0));
    float n1 = hash12(gl_FragCoord.yx + vec2(83.0, 11.0));
    float noise = (n0 - n1) * (0.85 / 255.0);
    col = clamp(linearToSrgb(col) + noise, 0.0, 1.0);
  }

  float a = aa + sh * (1.0 - aa);
  outColor = vec4(col * aa, a);   // premultiplied; shadow contributes black
}`;var ct=Object.freeze({rect:0,folder:0,pill:1,circle:2});function ut(s){return ct[s]??0}function dt(s,e=0){let t=Math.min(s.w??s.width??0,s.h??s.height??0);return Math.min(s.radius??e,t*.235)}function Re(s,e,t,i,a,r){let o=Math.abs(s)-t+a,l=Math.abs(e)-i+a,n=Math.max(o,0)+1e-5,h=Math.max(l,0)+1e-5,u=(n**r+h**r)**(1/r);return Math.min(Math.max(o,l),0)+u-a}function te(s,e,t,i,a,r,o=2){return a===2?Math.hypot(s,e)-Math.min(t,i):a===1?Re(s,e,t,i,Math.min(t,i),2):Re(s,e,t,i,r,Math.max(o,2))}function ie(s,e){let t=s.w??s.width??s.size??0,i=s.h??s.height??s.size??t;return{cx:(s.x??0)+t/2,cy:(s.y??0)+i/2,halfX:t/2,halfY:i/2,type:ut(s.shape),radius:dt({...s,w:t,h:i},e.radius??0)}}function se(s,e,t,i={},a=i.mergeRadius??0){if(!t.length)return 1/0;let r=t.map(c=>ie(c,i)),o=i.squircle??2,l=1/0,n=r.map(c=>{let b=te(s-c.cx,e-c.cy,c.halfX,c.halfY,c.type,c.radius,o);return b<l&&(l=b),b});if(!(a>=.01)||r.length===1)return l;let h=Math.max(a*.36,.01),u=0;for(let c of n)u+=Math.exp(-(c-l)/h);return l-h*Math.log(Math.max(u,1e-6))}function ke(s,e,t,i={},a={}){let r=a.fusion===!1?0:a.mergeRadius??i.mergeRadius??0,o=a.tolerance??0,l=i.squircle??2;if(a.fusion===!1){for(let h=t.length-1;h>=0;h--){let u=ie(t[h],i);if(te(s-u.cx,e-u.cy,u.halfX,u.halfY,u.type,u.radius,l)<=o)return t[h]}return null}let n=Y(t,r,16).groups;for(let h=n.length-1;h>=0;h--){let u=n[h];if(se(s,e,u,i,r)>o)continue;let c=null,b=1/0;for(let d=u.length-1;d>=0;d--){let f=ie(u[d],i),E=te(s-f.cx,e-f.cy,f.halfX,f.halfY,f.type,f.radius,l);E<b&&(b=E,c=u[d])}return c}return null}function Ae(s,e,t,i={},a=i.mergeRadius??0){let r=Y(t,a,16).groups;if(!r.length)return 1/0;let o=1/0;for(let l of r){let n=se(s,e,l,i,a);n<o&&(o=n)}return o}function ft(s,e){let t=l=>{let n=Number(l.w??l.width??l.size??0),h=Number(l.h??l.height??l.size??n);return{x:Number(l.x??0),y:Number(l.y??0),w:n,h}},i=t(s),a=t(e),r=Math.max(0,Math.max(i.x-(a.x+a.w),a.x-(i.x+i.w))),o=Math.max(0,Math.max(i.y-(a.y+a.h),a.y-(i.y+i.h)));return Math.hypot(r,o)}function Le(s,e=0){if(s.length<=1)return s.length?[s.slice()]:[];let t=Math.max(0,e)*.36*8,i=s.map((o,l)=>l),a=o=>{for(;i[o]!==o;)i[o]=i[i[o]],o=i[o];return o};for(let o=0;o<s.length;o++)for(let l=o+1;l<s.length;l++)ft(s[o],s[l])<=t&&(i[a(o)]=a(l));let r=new Map;return s.forEach((o,l)=>{let n=a(l);r.has(n)||r.set(n,[]),r.get(n).push(o)}),[...r.values()]}function Y(s,e=0,t=16){let i=Le(s,e),a=[],r=!1;for(let o of i){o.length>t&&(r=!0);for(let l=0;l<o.length;l+=t)a.push(o.slice(l,l+t))}return{groups:a,truncated:r}}var Me=`#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uDpr;
uniform float uMips;
uniform float uBackdropBlur;
const int MAX_SHAPES = 16;
uniform int uShapeCount;
uniform vec2 uShapeCenters[MAX_SHAPES];
uniform vec2 uShapeHalves[MAX_SHAPES];
uniform int uShapeTypes[MAX_SHAPES];
uniform float uShapeRadii[MAX_SHAPES];
uniform float uShapeTints[MAX_SHAPES];
uniform float uShapeTintLights[MAX_SHAPES];
uniform float uShapeFrosts[MAX_SHAPES];
uniform float uShapeOpacities[MAX_SHAPES];
uniform float uShapePressures[MAX_SHAPES];
uniform vec2 uShapePressAxes[MAX_SHAPES];
uniform vec2 uLightDirs[MAX_SHAPES];
uniform float uRefraction;
uniform float uEdgeReach;
uniform float uEdgeWidth;
uniform float uDispersion;
uniform float uBody;
uniform float uAbsorption;
uniform float uRim;
uniform float uReflection;
uniform float uHighlight;
uniform float uEcho;
uniform float uHairline;
uniform float uHairWidth;
// 1 while a layer is composited into the sRGB backdrop texture, which encodes
// on write; 0 for the display-referred drawing buffer.
uniform int uOutputLinear;

// Softness ratio -> pre-blur radius, as a fraction of the component short side.
const float FROST_PREBLUR_SCALE = 0.05;
// Strength of the pressed-in squash. The mapping slope at the contour is
// 1 - k, so k must stay below 1 to avoid folding the image.
const float PRESS_SQUASH = 0.85;

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
             12.92 * c,
             lessThanEqual(c, vec3(0.0031308)));
}

vec3 srgbToLinear(vec3 c) {
  bvec3 cutoff = lessThanEqual(c, vec3(0.04045));
  vec3 low = c / 12.92;
  vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(high, low, cutoff);
}

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

// Inside a rounded box the exact distance is max(q.x, q.y), and its gradient
// switches axis across the corner diagonal. Refraction reads that gradient as
// the surface normal, so the switch drew a 45-degree crease into every corner.
// A soft maximum rounds that ridge. It is used for the normal only: distance,
// masks, hairline and silhouette all keep the exact field.
// Unbiased: softMax(a, a, k) == a, so the interior term keeps its sign and
// the clamp below still recognises the inner rectangle.
float softMax(float a, float b, float k) {
  return 0.5 * (a + b + sqrt((a - b) * (a - b) + k * k)) - k * 0.5;
}

float sdRoundBoxSoft(vec2 p, vec2 b, float r, float k) {
  vec2 q = abs(p) - b + r;
  return min(softMax(q.x, q.y, k), 0.0) + length(max(q, 0.0)) - r;
}

float smoothUnion(float d1, float d2, float k) {
  float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
  return mix(d2, d1, h) - k * h * (1.0 - h);
}

float shapeSdf(int index, vec2 point) {
  vec2 p = point - uShapeCenters[index];
  vec2 halfSize = uShapeHalves[index];
  int kind = uShapeTypes[index];
  float radius = min(uShapeRadii[index], min(halfSize.x, halfSize.y));
  if (kind == 0) return sdRoundBox(p, halfSize, radius);
  if (kind == 1) return sdRoundBox(p, halfSize, min(halfSize.x, halfSize.y));
  return length(p) - min(halfSize.x, halfSize.y);
}

/** The silhouette field with a rounded interior ridge, for normals. */
float shapeField(int index, vec2 point) {
  vec2 p = point - uShapeCenters[index];
  vec2 halfSize = uShapeHalves[index];
  int kind = uShapeTypes[index];
  float minHalf = min(halfSize.x, halfSize.y);
  float k = clamp(minHalf * 0.08, 1.5, 12.0);
  if (kind == 0) return sdRoundBoxSoft(p, halfSize, min(uShapeRadii[index], minHalf), k);
  if (kind == 1) return sdRoundBoxSoft(p, halfSize, minHalf, k);
  return length(p) - minHalf;
}

vec2 opticalNormal(int index, vec2 point, vec2 sdfNormal) {
  vec2 p = point - uShapeCenters[index];
  vec2 halfSize = max(uShapeHalves[index], vec2(1.0));
  int kind = uShapeTypes[index];

  if (kind == 0) {
    // The sixth-order superellipse is the optical field, while roundness only
    // controls the silhouette. This separation is part of the V2 model.
    vec2 q = p / halfSize;
    vec2 g = vec2(sign(q.x) * pow(abs(q.x), 5.0) / halfSize.x,
                  sign(q.y) * pow(abs(q.y), 5.0) / halfSize.y);
    return normalize(g + sdfNormal * 0.0001);
  }
  if (kind == 1) {
    vec2 closest;
    if (halfSize.x >= halfSize.y) {
      float segment = max(halfSize.x - halfSize.y, 0.0);
      closest = vec2(clamp(p.x, -segment, segment), 0.0);
    } else {
      float segment = max(halfSize.y - halfSize.x, 0.0);
      closest = vec2(0.0, clamp(p.y, -segment, segment));
    }
    return normalize(p - closest + sdfNormal * 0.0001);
  }
  return normalize(p + sdfNormal * 0.0001);
}

// The shared backdrop pipeline stores linear radiance in SRGB8_ALPHA8.
// V2's optical constants were authored in display space, so convert each
// sample back before applying the V2 equations.
vec3 backdropLod(vec2 uv, float lod) {
  return linearToSrgb(textureLod(uSrc, clamp(uv, vec2(0.001), vec2(0.999)),
                                 clamp(lod, 0.0, max(uMips - 1.0, 0.0))).rgb);
}

// The mip level an implicit texture() lookup selects for a refracted
// coordinate. Explicit sampling never drops below it, so compressed capture
// bands stay filtered exactly as before while pre-blur can raise the level.
float footprintLod(vec2 uv) {
  vec2 dx = dFdx(uv) * uRes;
  vec2 dy = dFdy(uv) * uRes;
  return 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
}

vec3 softBackdrop(vec2 uv, float radius) {
  float lod = log2(max(radius * 0.9, 1.0));
  vec2 r = vec2(max(radius * 0.42, 0.35)) / uRes;
  vec2 center = clamp(uv, vec2(0.001), vec2(0.999));
  vec3 c = backdropLod(center, lod) * 0.44;
  c += backdropLod(center + vec2(r.x, 0.0), lod) * 0.14;
  c += backdropLod(center - vec2(r.x, 0.0), lod) * 0.14;
  c += backdropLod(center + vec2(0.0, r.y), lod) * 0.14;
  c += backdropLod(center - vec2(0.0, r.y), lod) * 0.14;
  return c;
}

// The backdrop blurred before refraction: a frosted layer that the liquid
// glass then bends. Radius is in device pixels; zero is the sharp backdrop.
vec3 preBlurredBackdrop(vec2 uv, float radius, float footprint) {
  if (radius <= 0.0) return backdropLod(uv, footprint);
  float lod = max(log2(max(radius * 0.9, 1e-3)), footprint);
  vec2 r = vec2(radius * 0.42) / uRes;
  vec2 center = clamp(uv, vec2(0.001), vec2(0.999));
  vec3 c = backdropLod(center, lod) * 0.44;
  c += backdropLod(center + vec2(r.x, 0.0), lod) * 0.14;
  c += backdropLod(center - vec2(r.x, 0.0), lod) * 0.14;
  c += backdropLod(center + vec2(0.0, r.y), lod) * 0.14;
  c += backdropLod(center - vec2(0.0, r.y), lod) * 0.14;
  return c;
}

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 interfaceColor(vec2 point, vec2 normal, float preBlur) {
  float radius = max(2.0, preBlur);
  vec3 outsideColor = softBackdrop((point + normal * 1.8) / uRes, radius);
  vec3 insideColor = softBackdrop((point - normal * 1.8) / uRes, radius);
  // Apple's outer interface is a neutral contrast line rather than a copy of
  // the wallpaper colour. Include display-space value as well as luminance so
  // saturated blue/purple fields select a dark line even though their formal
  // luminance is modest. The outside carries more weight because that is the
  // field the silhouette must remain legible against.
  float outsideValue = max(outsideColor.r, max(outsideColor.g, outsideColor.b));
  float insideValue = max(insideColor.r, max(insideColor.g, insideColor.b));
  float outsideLight = max(luminance(outsideColor), outsideValue * 0.72);
  float insideLight = max(luminance(insideColor), insideValue * 0.72);
  float interfaceLight = outsideLight * 0.68 + insideLight * 0.32;
  float darkLine = smoothstep(0.40, 0.61, interfaceLight);
  return mix(vec3(0.92, 0.93, 0.96), vec3(0.014, 0.013, 0.018), darkLine);
}

void main() {
  vec2 point = vUV * uRes;
  int chosen = -1;
  float chosenD = 1e6;
  int nearest = 0;
  float nearestD = 1e6;
  for (int i = 0; i < MAX_SHAPES; i++) {
    if (i >= uShapeCount) break;
    float d = shapeSdf(i, point);
    if (d < nearestD) { nearest = i; nearestD = d; }
    if (d <= 2.1) { chosen = i; chosenD = d; }
  }

  // Screen-space derivatives (fwidth, dFdx/dFdy and implicit texture LOD) are
  // only defined in uniform control flow. Fragments outside every surface
  // return early below; if that happened before the derivatives, a lane in
  // the 2x2 quad that exited with the 1e6 sentinel would make its neighbours'
  // hairline width and mip level garbage on some GPUs, sprinkling stray
  // pixels along the silhouette. So the geometric ALU runs for every lane,
  // evaluated on the nearest surface as a continuous extension for outside
  // fragments, and only the texture fetches are skipped after the return.
  bool covered = chosen >= 0;
  if (!covered) { chosen = nearest; chosenD = nearestD; }
  float edgeAA = max(fwidth(nearestD), 0.72);

  vec2 center = uShapeCenters[chosen];
  vec2 halfSize = uShapeHalves[chosen];
  float minHalf = min(halfSize.x, halfSize.y);
  float e = 1.35;
  float dx = shapeField(chosen, point + vec2(e, 0.0)) - shapeField(chosen, point - vec2(e, 0.0));
  float dy = shapeField(chosen, point + vec2(0.0, e)) - shapeField(chosen, point - vec2(0.0, e));
  vec2 normal = normalize(vec2(dx, dy) + vec2(0.0001));
  float depth = clamp(-chosenD / max(12.0, minHalf * 0.62), 0.0, 1.0);
  float refractionSupport = max(14.0, minHalf * 0.50);
  float edgeCurve = pow(1.0 - smoothstep(0.0, refractionSupport, -chosenD), 2.2);
  vec2 local = (point - center) / max(halfSize, vec2(1.0));

  float edgeDepth = max(-chosenD, 0.0);
  float causticSupport = max(8.0, minHalf * uEdgeWidth);
  float captureX = clamp(edgeDepth / causticSupport, 0.0, 1.0);
  float causticT = 1.0 - smoothstep(0.0, causticSupport, edgeDepth);
  float causticShade = causticT * causticT * (3.0 - 2.0 * causticT);
  // The old double-smoothstep displacement flattened at the visible contour.
  // Its source-coordinate derivative therefore changed sign twice, making a
  // captured line turn back just before it touched the edge. A one-sided exit
  // profile keeps a finite slope at the contour and relaxes to zero only on
  // the inner side of the capture band, leaving a single optical fold.
  float captureProfile = pow(1.0 - captureX, 1.64);
  float refractionX = clamp(edgeDepth / refractionSupport, 0.0, 1.0);
  float refractionProfile = pow(1.0 - refractionX, 2.2);
  // The silhouette and optical superellipse deliberately differ in V2, but
  // the visible contour must still exit along the silhouette normal. Blend to
  // the broader optical field only after leaving the outer edge pixels.
  float opticalNormalMix = smoothstep(0.12, 0.55, captureX);
  vec2 bendNormal = normalize(mix(normal, opticalNormal(chosen, point, normal), opticalNormalMix));
  vec2 inward = -bendNormal;
  // Edge pull used to multiply Capture reach as a second public control. Keep
  // its original default as an internal calibration so the default material
  // retains the same displacement with one unambiguous capture parameter.
  const float CAPTURE_REACH_SCALE = 1.24;
  float captureDistance = uEdgeReach * minHalf * 2.0 * CAPTURE_REACH_SCALE * captureProfile;
  float shallowRefraction = uRefraction * refractionProfile * 0.32;
  vec2 lensShift = inward * (shallowRefraction + captureDistance);
  lensShift += -local * (uRefraction * 0.035) * smoothstep(0.16, 0.92, depth);
  // A held lens is pressed in: a shallow diverging surface that squashes what
  // is seen through it. The outward displacement follows the contour normal,
  // vanishes on the centre line and at the silhouette, and softens the
  // ordinary edge fold instead of inflating the rim.
  float pressure = clamp(uShapePressures[chosen], 0.0, 1.0);
  float pressDepth = clamp(edgeDepth / max(minHalf, 1.0), 0.0, 1.0);
  lensShift *= 1.0 - pressure * 0.35;
  // Per-axis weights let a host shorten the squash along one direction, so a
  // wide capsule can keep its length while it flattens (or vice versa).
  vec2 pressAxes = clamp(uShapePressAxes[chosen], 0.0, 1.0);
  lensShift += normal * pressAxes * (PRESS_SQUASH * minHalf * pressure
                                     * pressDepth * (1.0 - pressDepth));
  vec2 chromaShift = bendNormal * uDispersion * (0.32 + edgeCurve * 0.95);
  vec2 uvR = (point + lensShift * (1.0 + uDispersion * 0.009) + chromaShift) / uRes;
  vec2 uvG = (point + lensShift) / uRes;
  vec2 uvB = (point + lensShift * (1.0 - uDispersion * 0.011) - chromaShift) / uRes;
  // Reach controls where the sample comes from, not how fat a captured line
  // becomes. Preserve the tuned reach=35 softness while preventing larger
  // reaches from silently doubling the blur radius.
  float causticBlur = min(0.7 + 1.13 * uDpr, 0.7 + captureDistance * 0.026);
  // Softness and background pre-blur are the same operation: the backdrop is
  // blurred before the lens bends it. Softness is a ratio of the component
  // short side, so a larger card is naturally more frosted at one setting;
  // pre-blur is an absolute radius. Successive blurs add in quadrature.
  float frostRadius = clamp(uShapeFrosts[chosen], 0.0, 1.0) * minHalf * 2.0 * FROST_PREBLUR_SCALE;
  float preBlur = sqrt(frostRadius * frostRadius + uBackdropBlur * uBackdropBlur);
  float lodR = footprintLod(uvR);
  float lodG = footprintLod(uvG);
  float lodB = footprintLod(uvB);
  vec2 echoUv = (point - normal * 11.0) / uRes;
  float echoLod = footprintLod(echoUv);

  if (!covered) {
    outColor = vec4(0.0);
    return;
  }

  vec3 sr = preBlurredBackdrop(uvR, preBlur, lodR);
  vec3 sg = preBlurredBackdrop(uvG, preBlur, lodG);
  vec3 sb = preBlurredBackdrop(uvB, preBlur, lodB);
  // Captured lines keep their slight softening inside the thin caustic band
  // unless the pre-blurred backdrop is already at least that soft.
  float causticMix = causticShade * 0.18;
  if (causticMix > 0.001 && causticBlur > preBlur) {
    sr = mix(sr, softBackdrop(uvR, causticBlur), causticMix);
    sg = mix(sg, softBackdrop(uvG, causticBlur), causticMix);
    sb = mix(sb, softBackdrop(uvB, causticBlur), causticMix);
  }
  vec3 transmitted = vec3(sr.r, sg.g, sb.b);

  float transmittedLum = luminance(transmitted);
  vec3 bodyTarget = mix(vec3(0.030, 0.031, 0.038), vec3(0.94, 0.95, 0.97),
                        smoothstep(0.58, 0.82, transmittedLum));
  transmitted = mix(transmitted, bodyTarget,
                    clamp(uBody * (0.034 + edgeCurve * 0.012), 0.0, 0.11));
  transmitted = mix(vec3(luminance(transmitted)), transmitted, 1.0 - uBody * 0.045);

  float opticalPath = 0.26 + sqrt(depth) * 0.74;
  transmitted *= exp(-vec3(0.018, 0.011, 0.004) * opticalPath * 2.4 * uAbsorption);
  // Tinted Liquid Glass chooses one light/dark material for the whole
  // component. Choosing per fragment lets high-contrast content punch a
  // checkerboard through the surface instead of producing the coherent milky
  // veil used by notifications and other legibility-first controls.
  vec3 tintTarget = mix(vec3(0.055, 0.057, 0.066), vec3(0.975, 0.970, 0.955),
                        clamp(uShapeTintLights[chosen], 0.0, 1.0));
  float tintOpacity = smoothstep(0.0, 1.5, uShapeTints[chosen]) * 0.78;
  transmitted = mix(transmitted, tintTarget, tintOpacity * (0.88 + depth * 0.12));

  float mask = 1.0 - smoothstep(0.0, 1.35, chosenD);
  float thinRim = exp(-pow((chosenD + 0.65) / 1.4, 2.0));
  float innerRim = exp(-pow((chosenD + 6.2) / 3.8, 2.0));
  float fresnel = pow(clamp(edgeCurve, 0.0, 1.0), 0.72);
  vec2 lightDir = normalize(uLightDirs[chosen] + vec2(0.0001));
  float key = pow(max(dot(normal, lightDir), 0.0), 7.0) * fresnel;
  float opposite = pow(max(dot(normal, -lightDir), 0.0), 5.0) * innerRim;
  vec3 color = transmitted;
  // The rim reflection, echo and interface line only exist in a band around
  // the contour. Their weights are resolved first so interior fragments skip
  // the extra backdrop probes; a skipped weight is below 1/2000.
  float rimMix = clamp((thinRim * 0.42 + innerRim * 0.18 + fresnel * 0.10)
                       * uRim * uReflection, 0.0, 0.72);
  if (rimMix > 0.0005) {
    // A softened environment probe keeps moving video/feed edges from turning
    // into one-frame white flashes while preserving the local colour response.
    vec3 reflected = softBackdrop((point + normal * (8.0 + uRefraction * 0.17)) / uRes,
                                  max(5.2, preBlur));
    vec3 adaptiveRim = reflected * 1.45 + vec3(0.06, 0.035, 0.08);
    adaptiveRim = mix(adaptiveRim, vec3(0.96, 0.97, 1.0), 0.24);
    adaptiveRim = mix(adaptiveRim, vec3(0.035, 0.025, 0.045),
                      smoothstep(0.78, 0.98, luminance(reflected)) * 0.48);
    color = mix(color, adaptiveRim, rimMix);
  }
  color += vec3(1.0, 0.82, 0.92) * key * 0.30 * uRim * uHighlight;
  color *= 1.0 - opposite * 0.12 * uRim;
  float echoMix = exp(-pow((chosenD + 11.0) / 5.5, 2.0)) * 0.075 * uRim * uEcho;
  if (echoMix > 0.0005) {
    vec3 echoColor = preBlurredBackdrop(echoUv, preBlur, echoLod);
    color = mix(color, echoColor * 1.12, echoMix);
  }

  float lineWidth = mix(0.34, 1.08, clamp(uHairWidth, 0.0, 1.0));
  float strokeDistance = abs(chosenD + 0.10) - lineWidth * 0.5;
  float hairline = 1.0 - smoothstep(-edgeAA * 0.72, edgeAA * 0.72, strokeDistance);
  // Premultiplied layer composition exactly reproduces the prototype's two
  // sequential mixes when drawn over the supplied backdrop, and also allows
  // the same shader to work in overlay mode over a DOM/canvas backdrop.
  float hairAlpha = clamp(hairline * uHairline * (0.22 + uRim * 0.20), 0.0, 1.0);
  vec3 hairColor = vec3(0.0);
  if (hairAlpha > 0.0) {
    hairColor = interfaceColor(point, normal, preBlur);
    // The contrast line is the default interface. On the light-facing arc the
    // specular key replaces it with the thin white highlight visible in the
    // native material instead of merely brightening the black line underneath.
    float hairHighlight = clamp(key * uHighlight * 2.5 * (0.65 + uRim * 0.60), 0.0, 0.96);
    hairColor = mix(hairColor, vec3(0.985, 0.99, 1.0), hairHighlight);
  }

  float alpha = hairAlpha + mask * (1.0 - hairAlpha);
  // The rim, key highlight and echo terms can push the body colour past 1.0.
  // Inside the surface the drawing buffer clamps that anyway, but on the
  // anti-aliased fringe a premultiplied rgb larger than alpha composites
  // brighter than either the glass or the backdrop, sprinkling over-bright
  // pixels along the outer edge. Saturate before premultiplying.
  color = clamp(color, 0.0, 1.0);
  if (uOutputLinear == 1) {
    color = srgbToLinear(color);
    hairColor = srgbToLinear(hairColor);
  }
  vec3 premultiplied = hairColor * hairAlpha + color * mask * (1.0 - hairAlpha);
  float surfaceOpacity = clamp(uShapeOpacities[chosen], 0.0, 1.0);
  outColor = vec4(premultiplied * surfaceOpacity, alpha * surfaceOpacity);
}`;function Ce(s,e,t){let i=s.createShader(e);if(s.shaderSource(i,t),s.compileShader(i),!s.getShaderParameter(i,s.COMPILE_STATUS)){let a=s.getShaderInfoLog(i);throw s.deleteShader(i),new Error(a+`
`+t)}return i}function W(s,e,t){let i=s.createProgram(),a=Ce(s,s.VERTEX_SHADER,e),r;try{r=Ce(s,s.FRAGMENT_SHADER,t)}catch(n){throw s.deleteShader(a),s.deleteProgram(i),n}if(s.attachShader(i,a),s.attachShader(i,r),s.linkProgram(i),s.detachShader(i,a),s.detachShader(i,r),s.deleteShader(a),s.deleteShader(r),!s.getProgramParameter(i,s.LINK_STATUS)){let n=s.getProgramInfoLog(i);throw s.deleteProgram(i),new Error(n)}let o={},l=s.getProgramParameter(i,s.ACTIVE_UNIFORMS);for(let n=0;n<l;n++){let h=s.getActiveUniform(i,n).name.replace("[0]","");o[h]=s.getUniformLocation(i,h)}return{p:i,loc:o}}var De=7;var V=class{constructor(e,t={}){let i=e.getContext("webgl2",{alpha:!!t.alpha,antialias:!1,premultipliedAlpha:!0,preserveDrawingBuffer:!!t.preserveDrawingBuffer});if(!i)throw new Error("WebGL2 unavailable");this.gl=i,this.canvas=e,this.materialVersion=t.materialVersion===2?2:1,this.lost=!1,this.tex=null,this.blurTex=null,this.wallpapers=[],this.fbos=[],this.blurFbos=[],this.mipLevels=0,this.w=0,this.h=0,this.createResources()}createResources(){let e=this.gl;this.quad=e.createVertexArray(),e.bindVertexArray(this.quad),this.quadBuffer=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.quadBuffer),e.bufferData(e.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,1,1]),e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),e.bindVertexArray(null),this.progWall=W(e,G,Te),this.progDown=W(e,G,we),this.progUp=W(e,G,Se),this.progBlit=W(e,G,ye),this.progGlass=W(e,xe,this.materialVersion===2?Me:Ee),this.fallbackTexture=e.createTexture(),e.bindTexture(e.TEXTURE_2D,this.fallbackTexture),e.texImage2D(e.TEXTURE_2D,0,e.SRGB8_ALPHA8,1,1,0,e.RGBA,e.UNSIGNED_BYTE,new Uint8Array([0,0,0,255])),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.bindTexture(e.TEXTURE_2D,null)}releaseResources(){let e=this.gl;for(let t of[this.progWall,this.progDown,this.progUp,this.progBlit,this.progGlass])t&&e.deleteProgram(t.p);this.progWall=null,this.progDown=null,this.progUp=null,this.progBlit=null,this.progGlass=null,this.quad&&e.deleteVertexArray(this.quad),this.quadBuffer&&e.deleteBuffer(this.quadBuffer),this.fallbackTexture&&e.deleteTexture(this.fallbackTexture),this.quad=null,this.quadBuffer=null,this.fallbackTexture=null}releaseTargets(){let e=this.gl;this.tex&&e.deleteTexture(this.tex),this.blurTex&&e.deleteTexture(this.blurTex),this.fbos.forEach(t=>e.deleteFramebuffer(t)),this.blurFbos.forEach(t=>e.deleteFramebuffer(t)),this.tex=null,this.blurTex=null,this.fbos=[],this.blurFbos=[],this.mipLevels=0}handleContextLost(){this.lost=!0,this.progWall=null,this.progDown=null,this.progUp=null,this.progBlit=null,this.progGlass=null,this.quad=null,this.quadBuffer=null,this.fallbackTexture=null,this.tex=null,this.blurTex=null,this.fbos=[],this.blurFbos=[];for(let e of this.wallpapers)e.texture=null,e.ready=!1,e.width=0,e.height=0}restore(){if(!this.lost)return this;this.lost=!1,this.createResources();let{w:e,h:t}=this;return this.w=0,this.h=0,e>0&&t>0&&this.resize(e,t),this.createWallpaperTextures(),this}hasLiveBackdrop(){return this.wallpapers.some(e=>e.update==="live")}sourceSize(e){return[Number(e?.videoWidth||e?.naturalWidth||e?.width||0),Number(e?.videoHeight||e?.naturalHeight||e?.height||0)]}isPremultipliedSource(e){let t=e?.tagName?.toUpperCase();return t==="CANVAS"||t==="VIDEO"||e?.constructor?.name==="OffscreenCanvas"||e?.constructor?.name==="VideoFrame"}uploadSource(e){let[t,i]=this.sourceSize(e.source),a=Math.min(1,Math.max(.1,Number(e.scale)||1));if(a>=1||!this.isPremultipliedSource(e.source))return[e.source,t,i];let r=Math.max(1,Math.round(t*a)),o=Math.max(1,Math.round(i*a));e.scaled||(e.scaled=typeof document<"u"?document.createElement("canvas"):new globalThis.OffscreenCanvas(r,o)),e.scaled.width!==r&&(e.scaled.width=r),e.scaled.height!==o&&(e.scaled.height=o);let l=e.scaled.getContext("2d");return l.clearRect(0,0,r,o),l.drawImage(e.source,0,0,r,o),[e.scaled,r,o]}probeSource(e){let t=this.wallpapers[e];if(!t)return null;let i=Math.min(1,Math.max(.1,Number(t.scale)||1));return t.scaled&&i<1?t.scaled:t.source}uploadWallpaper(e,t=!1){if(this.lost||!e.texture)return!1;let[i,a]=this.sourceSize(e.source);if(!(i>0)||!(a>0))return!1;let[r,o,l]=this.uploadSource(e),n=this.gl;n.bindTexture(n.TEXTURE_2D,e.texture);let h=this.isPremultipliedSource(r);return n.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL,h),!t&&e.ready&&e.width===o&&e.height===l?n.texSubImage2D(n.TEXTURE_2D,0,0,0,n.RGBA,n.UNSIGNED_BYTE,r):n.texImage2D(n.TEXTURE_2D,0,n.RGBA8,n.RGBA,n.UNSIGNED_BYTE,r),n.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),e.width=o,e.height=l,e.ready=!0,!0}setWallpaperScale(e){let t=Math.min(1,Math.max(.1,Number(e)||1)),i=!1;for(let a of this.wallpapers)(a.scale??1)!==t&&(i=!0),a.scale=t;return i}resize(e,t){if(e=Math.max(1,Math.round(e)),t=Math.max(1,Math.round(t)),this.lost){this.w=e,this.h=t;return}if(e===this.w&&t===this.h)return;let i=this.gl;this.w=e,this.h=t,this.canvas.width=e,this.canvas.height=t,this.releaseTargets(),this.mipLevels=Math.min(De,Math.floor(Math.log2(Math.max(e,t)))+1);let a=()=>{let r=i.createTexture();return i.bindTexture(i.TEXTURE_2D,r),i.texStorage2D(i.TEXTURE_2D,this.mipLevels,i.SRGB8_ALPHA8,e,t),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.LINEAR_MIPMAP_LINEAR),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.LINEAR),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),r};this.tex=a(),this.blurTex=a(),this.fbos=[],this.blurFbos=[];for(let r=0;r<this.mipLevels;r++){let o=i.createFramebuffer();i.bindFramebuffer(i.FRAMEBUFFER,o),i.framebufferTexture2D(i.FRAMEBUFFER,i.COLOR_ATTACHMENT0,i.TEXTURE_2D,this.tex,r),this.fbos.push(o);let l=i.createFramebuffer();i.bindFramebuffer(i.FRAMEBUFFER,l),i.framebufferTexture2D(i.FRAMEBUFFER,i.COLOR_ATTACHMENT0,i.TEXTURE_2D,this.blurTex,r),this.blurFbos.push(l)}i.bindFramebuffer(i.FRAMEBUFFER,null)}createWallpaperTextures(){if(this.lost)return;let e=this.gl;for(let t of this.wallpapers)t.texture&&e.deleteTexture(t.texture),t.texture=e.createTexture(),t.ready=!1,t.width=0,t.height=0,e.bindTexture(e.TEXTURE_2D,t.texture),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),this.uploadWallpaper(t,!0);e.bindTexture(e.TEXTURE_2D,null)}setWallpapers(e,t={}){let i=this.gl,a=t.update==="live"?"live":"static",r=Math.min(1,Math.max(.1,Number(t.scale)||1));this.lost||this.wallpapers.forEach(o=>i.deleteTexture(o.texture)),this.wallpapers=e.map(o=>({texture:null,source:o,update:a,scale:r,scaled:null,ready:!1,width:0,height:0})),this.createWallpaperTextures()}refreshWallpapers(e=!1){if(!this.lost){for(let t of this.wallpapers)(e||t.update==="live")&&this.uploadWallpaper(t);this.gl.bindTexture(this.gl.TEXTURE_2D,null)}}mipSize(e){return[Math.max(1,this.w>>e),Math.max(1,this.h>>e)]}buildBackdrop(e,t=1){if(this.lost||!this.fbos.length)return;let i=this.gl;this.refreshWallpapers(),i.bindVertexArray(this.quad),i.disable(i.BLEND),i.bindFramebuffer(i.FRAMEBUFFER,this.fbos[0]),i.viewport(0,0,this.w,this.h),i.useProgram(this.progWall.p),i.uniform2f(this.progWall.loc.uRes,this.w,this.h),i.uniform1i(this.progWall.loc.uScene,e),i.uniform1f(this.progWall.loc.uZoom,t);let a=this.wallpapers[e];if(i.activeTexture(i.TEXTURE1),i.bindTexture(i.TEXTURE_2D,a?.ready?a.texture:this.fallbackTexture),i.uniform1i(this.progWall.loc.uWallpaper,1),i.uniform1i(this.progWall.loc.uUseImage,a?.ready?1:0),i.drawArrays(i.TRIANGLE_STRIP,0,4),this.downsampleBackdrop(),this.materialVersion===2)return;let r=this.mipLevels-1,[o,l]=this.mipSize(r);i.bindFramebuffer(i.READ_FRAMEBUFFER,this.fbos[r]),i.bindFramebuffer(i.DRAW_FRAMEBUFFER,this.blurFbos[r]),i.blitFramebuffer(0,0,o,l,0,0,o,l,i.COLOR_BUFFER_BIT,i.NEAREST),i.bindVertexArray(this.quad),i.useProgram(this.progUp.p),i.uniform1i(this.progUp.loc.uLow,0),i.uniform1i(this.progUp.loc.uHigh,1);for(let n=r-1;n>=0;n--){let[h,u]=this.mipSize(n+1),[c,b]=this.mipSize(n);i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,this.blurTex),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_BASE_LEVEL,n+1),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAX_LEVEL,n+1),i.activeTexture(i.TEXTURE1),i.bindTexture(i.TEXTURE_2D,this.tex),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_BASE_LEVEL,n),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAX_LEVEL,n),i.bindFramebuffer(i.FRAMEBUFFER,this.blurFbos[n]),i.viewport(0,0,c,b),i.uniform2f(this.progUp.loc.uLowTexel,1/h,1/u),i.drawArrays(i.TRIANGLE_STRIP,0,4)}i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,this.blurTex),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_BASE_LEVEL,0),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAX_LEVEL,this.mipLevels-1),i.activeTexture(i.TEXTURE1),i.bindTexture(i.TEXTURE_2D,this.tex),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_BASE_LEVEL,0),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAX_LEVEL,this.mipLevels-1)}downsampleBackdrop(){if(this.lost||!this.fbos.length)return;let e=this.gl;e.bindVertexArray(this.quad),e.disable(e.BLEND),e.useProgram(this.progDown.p),e.uniform1i(this.progDown.loc.uTex,0),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.tex);for(let t=1;t<this.mipLevels;t++){let[i,a]=this.mipSize(t-1),[r,o]=this.mipSize(t);e.texParameteri(e.TEXTURE_2D,e.TEXTURE_BASE_LEVEL,t-1),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAX_LEVEL,t-1),e.bindFramebuffer(e.FRAMEBUFFER,this.fbos[t]),e.viewport(0,0,r,o),e.uniform2f(this.progDown.loc.uTexel,1/i,1/a),e.drawArrays(e.TRIANGLE_STRIP,0,4)}e.texParameteri(e.TEXTURE_2D,e.TEXTURE_BASE_LEVEL,0),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAX_LEVEL,this.mipLevels-1)}beginBackdropLayer(){if(this.lost||!this.fbos.length||!this.blurFbos.length)return!1;let e=this.gl;return e.bindFramebuffer(e.READ_FRAMEBUFFER,this.fbos[0]),e.bindFramebuffer(e.DRAW_FRAMEBUFFER,this.blurFbos[0]),e.blitFramebuffer(0,0,this.w,this.h,0,0,this.w,this.h,e.COLOR_BUFFER_BIT,e.NEAREST),!0}commitBackdropLayer(){this.lost||!this.fbos.length||!this.blurFbos.length||([this.tex,this.blurTex]=[this.blurTex,this.tex],[this.fbos,this.blurFbos]=[this.blurFbos,this.fbos],this.downsampleBackdrop())}drawBackdrop(){if(this.lost||!this.tex)return;let e=this.gl;e.bindFramebuffer(e.FRAMEBUFFER,null),e.viewport(0,0,this.w,this.h),e.disable(e.BLEND),e.bindVertexArray(this.quad),e.useProgram(this.progBlit.p),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.tex),e.uniform1i(this.progBlit.loc.uTex,0),e.drawArrays(e.TRIANGLE_STRIP,0,4)}clearOutput(){if(this.lost)return;let e=this.gl;e.bindFramebuffer(e.FRAMEBUFFER,null),e.viewport(0,0,this.w,this.h),e.disable(e.BLEND),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT)}drawGlassGroup(e,t,i,a=t.mergeRadius??0){if(!e.length||this.lost||!this.tex)return;let r=this.gl,{loc:o,p:l}=this.progGlass,n=e.slice(0,16),h=Math.min(...n.map(p=>p.x)),u=Math.min(...n.map(p=>p.y)),c=Math.max(...n.map(p=>p.x+p.w)),b=Math.max(...n.map(p=>p.y+p.h)),d=c-h,f=b-u;r.bindFramebuffer(r.FRAMEBUFFER,null),r.viewport(0,0,this.w,this.h),r.enable(r.BLEND),r.blendFunc(r.ONE,r.ONE_MINUS_SRC_ALPHA),r.bindVertexArray(this.quad),r.useProgram(l);let E=(h+d/2)*i,x=this.h-(u+f/2)*i,g=d/2*i,w=f/2*i,y=new Float32Array(32),R=new Float32Array(32),S=new Float32Array(16),A=new Int32Array(16);n.forEach((p,k)=>{let B=Math.min(p.w,p.h);y[k*2]=(p.x+p.w/2)*i,y[k*2+1]=this.h-(p.y+p.h/2)*i,R[k*2]=p.w/2*i,R[k*2+1]=p.h/2*i,S[k]=Math.min(p.radius??t.radius,B*.235)*i,A[k]=p.shape==="pill"?1:p.shape==="circle"?2:0}),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,this.tex),r.uniform1i(o.uSrc,0),r.activeTexture(r.TEXTURE2),r.bindTexture(r.TEXTURE_2D,this.blurTex),r.uniform1i(o.uBlurSrc,2),r.uniform2f(o.uRes,this.w,this.h),r.uniform2f(o.uCenter,E,x),r.uniform2f(o.uHalf,g,w),r.uniform1i(o.uShapeCount,n.length),r.uniform2fv(o.uShapeCenters,y),r.uniform2fv(o.uShapeHalves,R),r.uniform1iv(o.uShapeTypes,A),r.uniform1fv(o.uShapeRadii,S),r.uniform1f(o.uMergeRadius,Math.max(0,a)*i),r.uniform1f(o.uPad,(t.shadowSize*4+Math.max(a,0)*.3+8)*i),r.uniform1f(o.uSquircle,t.squircle),r.uniform1f(o.uBevel,t.bevel*i),r.uniform1f(o.uHeight,t.height*i),r.uniform1f(o.uSizeAdaptation,t.sizeAdaptation??1),r.uniform1f(o.uIOR,t.ior),r.uniform1f(o.uDispersion,t.dispersion),r.uniform1f(o.uBlurPlateau,t.blurPlateau*i),r.uniform1f(o.uBlurRim,t.blurRim*i),r.uniform1f(o.uOpticalDensity,t.opticalDensity),r.uniform1f(o.uMips,this.mipLevels),r.uniform1f(o.uSpecular,t.specular),r.uniform1f(o.uSpecPower,t.specPower),r.uniform1f(o.uHighlightAdapt,t.highlightAdapt),r.uniform1f(o.uHighlightWidth,t.highlightWidth),r.uniform1f(o.uHighlightSharpness,t.highlightSharpness),r.uniform1f(o.uHighlightBase,t.highlightBase),r.uniform1f(o.uFresnel,t.fresnel),r.uniform1f(o.uSat,t.saturation),r.uniform1f(o.uBright,t.brightness),r.uniform1f(o.uTintAmount,t.tintAmount),r.uniform3f(o.uTintColor,...t.tintColor),r.uniform1f(o.uTintAdapt,t.tintAdapt??0),r.uniform1f(o.uShadow,t.shadow),r.uniform1f(o.uShadowSize,t.shadowSize*i),r.uniform1f(o.uShadowOffset,t.shadowOffset*i),r.uniform2f(o.uLightDir,t.lightX,t.lightY),r.uniform1f(o.uEdgeLine,t.edgeLine),r.uniform1f(o.uEdgeWidth,t.edgeWidth*i),r.uniform1f(o.uEdgeDark,t.edgeDark),r.uniform1f(o.uRefractScale,t.refractScale),r.uniform1f(o.uMeniscus,t.meniscus),r.uniform1i(o.uDebug,t.debug|0),r.drawArrays(r.TRIANGLE_STRIP,0,4),r.disable(r.BLEND)}drawGlass(e,t,i){this.drawGlassGroup([e],t,i,0)}drawGlassV2Group(e,t,i,a=[],r=[],o={}){if(!e.length||this.lost||!this.tex)return;let l=!!o.intoBackdrop&&this.blurFbos.length>0,n=this.gl,{loc:h,p:u}=this.progGlass,c=e.slice(0,16),b=Math.min(...c.map(m=>m.x)),d=Math.min(...c.map(m=>m.y)),f=Math.max(...c.map(m=>m.x+m.w)),E=Math.max(...c.map(m=>m.y+m.h)),x=f-b,g=E-d,w=new Float32Array(32),y=new Float32Array(32),R=new Float32Array(16),S=new Int32Array(16),A=new Float32Array(32),p=new Float32Array(16),k=new Float32Array(16),B=new Float32Array(16),D=new Float32Array(16),T=new Float32Array(16),L=new Float32Array(32);c.forEach((m,v)=>{let F=Math.min(m.w,m.h);w[v*2]=(m.x+m.w/2)*i,w[v*2+1]=this.h-(m.y+m.h/2)*i,y[v*2]=m.w/2*i,y[v*2+1]=m.h/2*i,R[v]=Math.min(m.radius??F*.5*t.roundness,F*.5)*i,S[v]=m.shape==="pill"?1:m.shape==="circle"?2:0;let M=a[v]??[Math.SQRT1_2,Math.SQRT1_2];A[v*2]=M[0],A[v*2+1]=M[1],p[v]=m.tint??t.tint,k[v]=r[v]??1,B[v]=m.frost??t.frost,D[v]=m.opacity??1,T[v]=m.pressure??0,L[v*2]=m.pressureAxes?.[0]??1,L[v*2+1]=m.pressureAxes?.[1]??1}),n.bindFramebuffer(n.FRAMEBUFFER,l?this.blurFbos[0]:null),n.viewport(0,0,this.w,this.h),n.enable(n.BLEND),n.blendFunc(n.ONE,n.ONE_MINUS_SRC_ALPHA),n.bindVertexArray(this.quad),n.useProgram(u),n.activeTexture(n.TEXTURE0),n.bindTexture(n.TEXTURE_2D,this.tex),n.uniform1i(h.uSrc,0),n.uniform1i(h.uOutputLinear,l?1:0),n.uniform2f(h.uRes,this.w,this.h),n.uniform1f(h.uDpr,i),n.uniform2f(h.uCenter,(b+x/2)*i,this.h-(d+g/2)*i),n.uniform2f(h.uHalf,x/2*i,g/2*i),n.uniform1f(h.uPad,4*i),n.uniform1f(h.uMips,this.mipLevels),n.uniform1i(h.uShapeCount,c.length),n.uniform2fv(h.uShapeCenters,w),n.uniform2fv(h.uShapeHalves,y),n.uniform1iv(h.uShapeTypes,S),n.uniform1fv(h.uShapeRadii,R),n.uniform1fv(h.uShapeTints,p),n.uniform1fv(h.uShapeTintLights,k),n.uniform1fv(h.uShapeFrosts,B),n.uniform1fv(h.uShapeOpacities,D),n.uniform1fv(h.uShapePressures,T),n.uniform2fv(h.uShapePressAxes,L),n.uniform2fv(h.uLightDirs,A),n.uniform1f(h.uRefraction,t.refraction*i),n.uniform1f(h.uEdgeReach,t.edgeReach),n.uniform1f(h.uBackdropBlur,(t.backdropBlur??0)*i),n.uniform1f(h.uEdgeWidth,t.edgeWidth),n.uniform1f(h.uDispersion,t.dispersion),n.uniform1f(h.uBody,t.body),n.uniform1f(h.uAbsorption,t.absorption),n.uniform1f(h.uRim,t.rim),n.uniform1f(h.uReflection,t.reflection),n.uniform1f(h.uHighlight,t.highlight),n.uniform1f(h.uEcho,t.echo),n.uniform1f(h.uHairline,t.hairline),n.uniform1f(h.uHairWidth,t.hairWidth),n.drawArrays(n.TRIANGLE_STRIP,0,4),n.disable(n.BLEND)}destroy(){if(this.lost){this.wallpapers=[];return}let e=this.gl;this.releaseTargets(),this.releaseResources(),this.wallpapers.forEach(t=>e.deleteTexture(t.texture)),this.wallpapers=[]}};var Be={radius:64,squircle:2,mergeRadius:52,bevel:34,height:21,sizeAdaptation:1,ior:2,dispersion:.06,refractScale:3,meniscus:1,blurPlateau:4.5,blurRim:11,opticalDensity:.4,specular:.89,specPower:29.5,fresnel:.65,saturation:1.35,brightness:0,tintAmount:.02,tintColor:[1,1,1],tintAdapt:.14,shadow:.09,shadowSize:4,shadowOffset:0,lightX:-.18,lightY:.08,highlightAdapt:.91,highlightWidth:.87,highlightSharpness:.55,highlightBase:.3,edgeLine:.3,edgeWidth:.5,edgeDark:.02,debug:0},Pe={regular:{},clear:{blurPlateau:3,blurRim:1,height:20,bevel:15,refractScale:1.5,specular:.36,fresnel:1,tintAmount:.02,brightness:.02,saturation:1.18},lens:{bevel:26,height:34,ior:1.62,dispersion:.09,refractScale:1.8,blurPlateau:2,blurRim:0,specular:.42,fresnel:1.2}},_e={tintAmount:.86,blurPlateau:0,blurRim:0,refractScale:0,dispersion:0,meniscus:0,specular:.12,fresnel:.15,saturation:1,highlightBase:.06,edgeLine:.22};function pt(s){return{...s,tintColor:[...s.tintColor]}}function Fe(){return pt(Be)}function $(s="regular"){return{...Fe(),...Pe[s]||{}}}var re=Object.freeze({refraction:84,edgeReach:.14,edgeWidth:.21,dispersion:2,frost:0,backdropBlur:0,body:.72,absorption:.58,tint:0,rim:.24,reflection:.31,highlight:.34,lightAngle:136,echo:.28,hairline:.92,hairWidth:.52,roundness:.47}),ae=Object.freeze({refraction:0,edgeReach:0,dispersion:0,frost:0,backdropBlur:0,body:1.5,tint:1.35,reflection:.18,highlight:.12,echo:0}),oe=Object.freeze([["refraction",0,110,1],["edgeReach",0,1.6,.01],["edgeWidth",0,.55,.01],["dispersion",0,7,.1],["frost",0,1,.01],["backdropBlur",0,64,1],["body",0,1.5,.01],["absorption",0,2,.01],["tint",0,1.5,.01],["rim",0,1,.01],["reflection",0,1.5,.01],["highlight",0,1.5,.01],["lightAngle",-180,180,1],["echo",0,1.5,.01],["hairline",0,1.5,.01],["hairWidth",0,1,.01],["roundness",.05,.6,.01]]);var Ti=Object.freeze({rect:0,folder:0,pill:1,circle:2});var mt=new Set,K=new Map,le=0,he=0;var ze=0;function Ne(){ze++,ce(34)}var Oe=()=>globalThis.performance?.now?.()??Date.now();function Ge(){!le&&typeof globalThis.requestAnimationFrame=="function"&&(le=globalThis.requestAnimationFrame(vt))}function ce(s=0){he=Math.max(he,Oe()+s),Ge()}function gt(){for(let s of K.keys())s.isConnected||K.delete(s);return K.size>0}function vt(){le=0;let s=Oe();K.size&&ze++;let e=[];for(let i of mt)i.visible&&e.push(i);for(let i of e)try{i.measure(s)}catch(a){console.error(a)}let t=!1;for(let i of e)try{i.draw(s)&&(t=!0)}catch(a){console.error(a)}(t||s<he||gt())&&Ge()}var Q="data-liquid-glass-layer";var He=s=>typeof Element<"u"&&s instanceof Element,We=new Map,Ve=new Set;function bt(s){let e=We.get(s);if(e)return e;let t=new Image;return t.crossOrigin="anonymous",t.decoding="async",e={url:s,image:t,state:"loading"},e.promise=new Promise(i=>{t.onload=()=>{e.state="ready",i(e),Ve.forEach(a=>a(e))},t.onerror=()=>{e.state="error",console.warn(`LiquidGlass: could not load backdrop image ${s} (a cross-origin image needs CORS headers).`),i(e),Ve.forEach(a=>a(e))}}),t.src=s,We.set(s,e),e}function xt(s){if(!s)return[0,0];let e=s.tagName?.toUpperCase();return e==="IMG"?s.complete?[s.naturalWidth,s.naturalHeight]:[0,0]:e==="VIDEO"?s.readyState>=2?[s.videoWidth,s.videoHeight]:[0,0]:[Number(s.displayWidth??s.width??0),Number(s.displayHeight??s.height??0)]}function P(s,e){let t=[],i=0,a=0;for(let r=0;r<s.length;r++){let o=s[r];o==="("?i++:o===")"?i--:i===0&&(e===" "?/\s/.test(o):o===e)&&(t.push(s.slice(a,r)),a=r+1)}return t.push(s.slice(a)),t.map(r=>r.trim()).filter(Boolean)}function N(s="0%"){if(s==="left"||s==="top")return{ratio:0,px:0};if(s==="center")return{ratio:.5,px:0};if(s==="right"||s==="bottom")return{ratio:1,px:0};let e={ratio:0,px:0},t=/([-+])?\s*(\d*\.?\d+(?:e[-+]?\d+)?)(%|px)?/gi;for(let i=t.exec(s);i;i=t.exec(s)){let a=Number(i[2])*(i[1]==="-"?-1:1);i[3]==="%"?e.ratio+=a/100:e.px+=a}return e}var _=({ratio:s,px:e},t)=>s*t+e;function H(s="50% 50%"){let e=P(s," ");return e.length===1&&e.push("50%"),[N(e[0]),N(e[1])]}function yt(s,e,t,i="cover",a=H()){let r=t.width,o=t.height;if(i==="cover"||i==="contain"){let l=(i==="cover"?Math.max:Math.min)(t.width/s,t.height/e);r=s*l,o=e*l}else if(i==="none"||i==="scale-down"){let l=i==="none"?1:Math.min(1,t.width/s,t.height/e);r=s*l,o=e*l}return{x:t.x+_(a[0],t.width-r),y:t.y+_(a[1],t.height-o),width:r,height:o}}var wt=new Set(["multiply","screen","overlay","darken","lighten","color-dodge","color-burn","hard-light","soft-light","difference","exclusion","hue","saturation","color","luminosity"]);function qe(s,e){wt.has(e.mixBlendMode)&&(s.globalCompositeOperation=e.mixBlendMode)}var I=s=>!s||s==="transparent"||/^rgba\([^)]*,\s*0(\.0*)?\s*\)$/.test(s)||/\/\s*0(\.0*)?%?\s*\)$/.test(s);function St(s,e){let t=(i,a)=>{let r=P(i||"0"," ")[0];return Math.max(0,_(N(r),a))};return[t(s.borderTopLeftRadius,e.width),t(s.borderTopRightRadius,e.width),t(s.borderBottomRightRadius,e.width),t(s.borderBottomLeftRadius,e.width)]}function Tt(s,e,t){s.beginPath(),t?.some(i=>i>0)&&typeof s.roundRect=="function"?s.roundRect(e.x,e.y,e.width,e.height,t):s.rect(e.x,e.y,e.width,e.height),s.clip()}var q=s=>{let e=s.getBoundingClientRect();return{x:e.left,y:e.top,width:e.width,height:e.height}},ue=()=>({x:0,y:0,width:globalThis.innerWidth||document.documentElement.clientWidth,height:globalThis.innerHeight||document.documentElement.clientHeight});function Et(s,e){let t=q(s),i=s.offsetWidth?t.width/s.offsetWidth:1,a=s.offsetHeight?t.height/s.offsetHeight:1,r=(parseFloat(e.borderLeftWidth)||0)+(parseFloat(e.paddingLeft)||0),o=(parseFloat(e.borderTopWidth)||0)+(parseFloat(e.paddingTop)||0),l=(parseFloat(e.borderRightWidth)||0)+(parseFloat(e.paddingRight)||0),n=(parseFloat(e.borderBottomWidth)||0)+(parseFloat(e.paddingBottom)||0);return{x:t.x+r*i,y:t.y+o*a,width:Math.max(0,t.width-(r+l)*i),height:Math.max(0,t.height-(o+n)*a)}}function Xe(s,e){let t=[];for(let i of s){let a=P(i," "),r=[];for(;a.length>1&&/(%|px)$|^calc\(/.test(a[a.length-1]);)r.unshift(a.pop());let o=a.join(" ");r.length||t.push({color:o,offset:null});for(let l of r)t.push({color:o,offset:_(N(l),e)/Math.max(e,1e-6)})}if(!t.length)return t;t[0].offset===null&&(t[0].offset=0),t.at(-1).offset===null&&(t.at(-1).offset=1);for(let i=1;i<t.length;i++){if(t[i].offset!==null){t[i].offset=Math.max(t[i].offset,t[i-1].offset);continue}let a=i;for(;t[a].offset===null;)a++;let r=t[i-1].offset,o=Math.max(t[a].offset,r);for(let l=i;l<a;l++)t[l].offset=r+(o-r)*(l-i+1)/(a-i+1)}return t}function Ye(s){if(s.length<2)return s;let e=s[0].offset,t=s.at(-1).offset-e;if(!(t>5e-4))return s;let i=[];for(let a=Math.floor(-e/t);a<=Math.ceil((1-e)/t);a++)for(let r of s){let o=r.offset+a*t;o<-t||o>1+t||i.push({color:r.color,offset:Math.min(1,Math.max(0,o))})}return i.length>=2?i:s}function $e(s,e){for(let t of e)try{s.addColorStop(Math.min(1,Math.max(0,t.offset)),t.color)}catch{}return s}function Rt(s){let e=/^(-?\d*\.?\d+)(deg|turn|rad|grad)$/.exec(s);if(!e)return null;let t=Number(e[1]);return{deg:t,turn:t*360,rad:t*180/Math.PI,grad:t*.9}[e[2]]}function kt(s,e,t,i=!1){let a=P(e,","),r=180,o=a[0]??"",l=Rt(o);if(l!==null)r=l,a.shift();else if(/^to\s/.test(o)){let E=o.slice(3).trim().split(/\s+/),x=E.includes("right")?1:E.includes("left")?-1:0,g=E.includes("bottom")?1:E.includes("top")?-1:0,w=x&&g?x*t.height:x,y=x&&g?g*t.width:g;r=Math.atan2(w,-y)*180/Math.PI,a.shift()}else/^in\s/.test(o)&&a.shift();let n=r*Math.PI/180,h=Math.abs(t.width*Math.sin(n))+Math.abs(t.height*Math.cos(n)),u=t.x+t.width/2,c=t.y+t.height/2,b=Math.sin(n)*h/2,d=-Math.cos(n)*h/2,f=Xe(a,h);s.fillStyle=$e(s.createLinearGradient(u-b,c-d,u+b,c+d),i?Ye(f):f),s.fillRect(t.x,t.y,t.width,t.height)}function At(s,e,t,i=!1){let a=P(e,","),r=a[0]??"",o=!1,l="farthest-corner",n=null,h=H("50% 50%");if(!(/^(rgb|hsl|hwb|lab|lch|oklab|oklch|color|#|transparent|currentcolor)/i.test(r)||!/(circle|ellipse|closest|farthest|at\s|\d(px|%))/.test(r))){a.shift();let[S,A]=r.split(/\s*\bat\b\s*/);A&&(h=H(A));for(let p of P(S??""," "))p==="circle"?o=!0:p==="ellipse"?o=!1:/^(closest|farthest)-(side|corner)$/.test(p)?l=p:/(px|%)$/.test(p)&&(n??=[]).push(N(p));n?.length===1&&(o=!0)}let c=t.x+_(h[0],t.width),b=t.y+_(h[1],t.height),d=c-t.x,f=t.x+t.width-c,E=b-t.y,x=t.y+t.height-b,g,w;if(n)g=_(n[0],t.width),w=n[1]?_(n[1],t.height):g;else{let S=l.startsWith("closest")?Math.min:Math.max,A=S(Math.abs(d),Math.abs(f)),p=S(Math.abs(E),Math.abs(x));if(o)g=l.endsWith("side")?S(A,p):Math.hypot(A,p),w=g;else{let k=l.endsWith("corner")?Math.SQRT2:1;g=A*k,w=p*k}}g=Math.max(g,.001),w=Math.max(w,.001),s.save(),s.beginPath(),s.rect(t.x,t.y,t.width,t.height),s.clip(),s.translate(c,b),s.scale(1,w/g);let y=Xe(a,g);s.fillStyle=$e(s.createRadialGradient(0,0,0,0,0,g),i?Ye(y):y);let R=Math.max(t.width,t.height)*2+Math.abs(c)+Math.abs(b);s.fillRect(-R,-R*g/w,R*2,R*2*g/w),s.restore()}function Lt(s,e,t){let[i,a]=t??[0,0],r=i>0&&a>0;if(s==="cover"||s==="contain"){if(!r)return[e.width,e.height];let u=(s==="cover"?Math.max:Math.min)(e.width/i,e.height/a);return[i*u,a*u]}let[o="auto",l="auto"]=P(s||"auto"," "),n=o==="auto"?null:_(N(o),e.width),h=l==="auto"?null:_(N(l),e.height);return n===null&&h===null?r?[i,a]:[e.width,e.height]:(n===null&&(n=r?h*i/a:e.width),h===null&&(h=r?n*a/i:e.height),[n,h])}function Mt(s,e,t,i,a){let r=/^url\((['"]?)(.*)\1\)$/.exec(e),o=/^(repeating-)?(linear|radial)-gradient\((.*)\)$/s.exec(e);if(!r&&!o)return!0;let l=null;if(r&&(l=bt(r[2]),l.state!=="ready"))return l.state!=="loading";let n=l?[l.image.naturalWidth,l.image.naturalHeight]:null;if(l&&!(n[0]>0&&n[1]>0))return!0;let h=t.attachment==="fixed"?ue():i,[u,c]=Lt(t.size,h,n);if(!(u>.5&&c>.5))return!0;let b=H(t.position),d=h.x+_(b[0],h.width-u),f=h.y+_(b[1],h.height-c),[E,x]=(()=>{let D=P(t.repeat||"repeat"," ");if(D[0]==="repeat-x")return[!0,!1];if(D[0]==="repeat-y")return[!1,!0];let T=D[0]!=="no-repeat",L=(D[1]??D[0])!=="no-repeat";return[T,L]})(),g=Math.max(i.x,a.x),w=Math.min(i.x+i.width,a.x+a.width),y=Math.max(i.y,a.y),R=Math.min(i.y+i.height,a.y+a.height);if(g>=w||y>=R)return!0;let S=E?d+Math.floor((g-d)/u)*u:d,A=x?f+Math.floor((y-f)/c)*c:f,p=E?w:d+1,k=x?R:f+1,B=0;for(let D=A;D<k&&B<1024;D+=c)for(let T=S;T<p&&B<1024;T+=u){B++;let L={x:T,y:D,width:u,height:c};l?s.drawImage(l.image,T,D,u,c):o[2]==="linear"?kt(s,o[3],L,!!o[1]):At(s,o[3],L,!!o[1])}return!0}function je(s,e,t,{canvas:i=!1}={}){let a=getComputedStyle(e);if(a.display==="none")return!0;let r=q(e),o=i?1:Number(a.opacity);if(!(o>.004))return!0;let l=a.backgroundImage&&a.backgroundImage!=="none"?P(a.backgroundImage,","):[],n=a.backgroundColor;if(!l.length&&I(n))return!0;s.save(),s.globalAlpha*=Number.isFinite(o)?o:1,i||qe(s,a),i?(s.beginPath(),s.rect(t.x,t.y,t.width,t.height),s.clip()):Tt(s,r,St(a,r)),I(n)||(s.fillStyle=n,s.fillRect(t.x,t.y,t.width,t.height));let h=x=>P(x||"",","),u=h(a.backgroundSize),c=h(a.backgroundPosition),b=h(a.backgroundRepeat),d=h(a.backgroundAttachment),f=(x,g,w)=>x.length?x[g%x.length]:w,E=!0;for(let x=l.length-1;x>=0;x--)E=Mt(s,l[x],{size:f(u,x,"auto"),position:f(c,x,"0% 0%"),repeat:f(b,x,"repeat"),attachment:f(d,x,"scroll")},i?q(document.documentElement):r,t)&&E;return s.restore(),E}function Ct(s,e,t,i,a,r){let[o,l]=xt(e);if(!(o>0&&l>0)||!(t.width>0&&t.height>0)||t.x>=r.x+r.width||t.x+t.width<=r.x||t.y>=r.y+r.height||t.y+t.height<=r.y)return;let n=yt(o,l,t,i,a);s.save(),s.beginPath(),s.rect(t.x,t.y,t.width,t.height),s.clip();try{s.drawImage(e,n.x,n.y,n.width,n.height)}catch{}s.restore()}function Ke(s,e,t){let{element:i}=e,a=getComputedStyle(i);if(a.display==="none"||a.visibility==="hidden")return;let r=Number(a.opacity);if(!(r>.004))return;s.save(),s.globalAlpha*=Number.isFinite(r)?r:1,qe(s,a);let o=e.anchor?Dt(e.anchor):Et(i,a);Ct(s,i,o,e.fit??a.objectFit??"fill",e.position??H(a.objectPosition),t),s.restore()}function Dt(s){return s==="viewport"||s==null?ue():s==="document"?q(document.documentElement):He(s)?q(s):ue()}var Bt="[data-liquid-glass], [data-liquid-glass-control]",Pt=new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","HEAD","META","LINK","TITLE","BR","WBR","IFRAME","OBJECT","EMBED","INPUT","TEXTAREA","SELECT","OPTION","BUTTON"]),_t=new Set(["IMG","VIDEO","CANVAS"]),Ft="http://www.w3.org/1999/xhtml",It=-.6,Qe=-.4,U=null,X=!0,Ze=!1,fe=null,pe=new Map;function tt(s,e){let t=Math.min(s.length,e.length);for(let i=0;i<t;i++){if(s[i][0]!==e[i][0])return s[i][0]-e[i][0];if(s[i][1]!==e[i][1])return s[i][1]-e[i][1]}return s.length-e.length}var Je=s=>s.backgroundImage!=="none"||!I(s.backgroundColor),Ut=s=>["Top","Right","Bottom","Left"].some(e=>parseFloat(s[`border${e}Width`])>0&&s[`border${e}Style`]!=="none"&&!I(s[`border${e}Color`]));function zt(s,e){return e&&s.zIndex!=="auto"||s.position==="fixed"||s.position==="sticky"||Number(s.opacity)<1||s.transform!=="none"||s.filter!=="none"||s.isolation==="isolate"||s.mixBlendMode!=="normal"||s.backdropFilter&&s.backdropFilter!=="none"||/paint|strict|content/.test(s.contain||"")}function Nt(s){let e=s.fontStyle.startsWith("oblique")?"italic":s.fontStyle,t=s.fontVariantCaps==="small-caps"?"small-caps ":"";return`${e} ${t}${s.fontWeight} ${s.fontSize} ${s.fontFamily}`}function Ot(s,e){let t=pe.get(s);if(t)return t;fe??=document.createElement("canvas").getContext("2d"),fe.font=s;let i=fe.measureText("Hg");return t={ascent:i.fontBoundingBoxAscent??e*.8,descent:i.fontBoundingBoxDescent??e*.2},pe.set(s,t),t}function Gt(s){if(!s||s==="none")return null;let e=P(P(s,",")[0]," "),t=e.find(a=>!/^-?[\d.]+(px)?$/.test(a)),i=e.filter(a=>/^-?[\d.]+(px)?$/.test(a)).map(parseFloat);return!t||i.length<2?null:{color:t,x:i[0],y:i[1],blur:i[2]??0}}function Wt(s,e){return e==="uppercase"?s.toUpperCase():e==="lowercase"?s.toLowerCase():e==="capitalize"?s.replace(/^\p{L}/u,t=>t.toUpperCase()):s}var it=(s,e)=>s.x<e.x+e.width&&s.x+s.width>e.x&&s.y<e.y+e.height&&s.y+s.height>e.y;function Vt(){let s=globalThis.scrollX||0,e=globalThis.scrollY||0,t=globalThis.innerWidth||document.documentElement.clientWidth,i=globalThis.innerHeight||document.documentElement.clientHeight,a={x:-t*.5,y:-i,width:t*2,height:i*3},r=[],o=new Map,l=document.createRange(),n=0,h=getComputedStyle(document.documentElement),u=Je(h);function c(d,f,E,x,g){let w=d.data;if(!/\S/.test(w))return;let y=f.webkitTextFillColor||f.color,R=parseFloat(f.webkitTextStrokeWidth)||0;if(I(y)&&!(R>0))return;l.selectNodeContents(d);let S=l.getBoundingClientRect();if(!S.width||!it({x:S.left,y:S.top,width:S.width,height:S.height},a))return;let A=g?0:s,p=g?0:e,k=[],B=(T,L)=>{L.width>0&&k.push({text:Wt(T,f.textTransform),x:L.left+A,y:L.top+p,width:L.width,height:L.height})},D=/\S+/g;for(let T=D.exec(w);T;T=D.exec(w)){l.setStart(d,T.index),l.setEnd(d,T.index+T[0].length);let L=l.getClientRects();if(L.length<=1){L.length&&B(T[0],L[0]);continue}let m="",v=null;for(let F=0;F<T[0].length;F++){l.setStart(d,T.index+F),l.setEnd(d,T.index+F+1);let M=l.getBoundingClientRect();v&&Math.abs(M.top-v.top)>1&&(B(m,v),m="",v=null),m+=T[0][F],v=v?{left:v.left,top:v.top,width:M.right-v.left,height:v.height}:{left:M.left,top:M.top,width:M.width,height:M.height}}v&&B(m,v)}k.length&&r.push({type:"text",key:E,fixed:g,alpha:x,words:k,box:{x:S.left+A,y:S.top+p,width:S.width,height:S.height},font:Nt(f),size:parseFloat(f.fontSize)||16,fill:I(y)?null:y,stroke:R>0?{width:R,color:f.webkitTextStrokeColor}:null,letterSpacing:f.letterSpacing!=="normal"?f.letterSpacing:"",shadow:Gt(f.textShadow)})}function b(d,f,E,x,g=!0){if(d.namespaceURI!==Ft)return;let w=d.tagName.toUpperCase();if(Pt.has(w)||d.id==="mega-display-controls")return;let y=getComputedStyle(d);if(y.display==="none"||y.display==="contents"&&!d.childNodes.length)return;let R=y.position!=="static",S=zt(y,R),A=Number.parseInt(y.zIndex,10),p=R&&Number.isFinite(A)?A:R||S?0:y.display.startsWith("inline")?Qe:It,k=[...f,[p,n++]],B=x||y.position==="fixed";d.matches(Bt)&&(o.set(d,k),d.getAttribute("data-liquid-glass")!=="fallback"&&(g=!1));let D=Number(y.opacity),T=E*(Number.isFinite(D)?D:1),L=y.visibility==="visible"&&T>.004,m=_t.has(w);if(g&&L&&(m||Je(y)||Ut(y))){let M=d.getBoundingClientRect();M.width&&M.height&&r.push({type:m?"media":"box",element:d,key:k,fixed:B,alpha:E,box:{x:M.left+(B?0:s),y:M.top+(B?0:e),width:M.width,height:M.height}})}if(m)return;let v=S||R?k:f,F=w==="SLOT"?d.assignedNodes({flatten:!0}):(d.shadowRoot||d).childNodes;for(let M of F.length?F:d.childNodes)M.nodeType===1?b(M,v,T,B):M.nodeType===3&&L&&c(M,y,[...v,[Qe,n++]],T,B)}return document.body&&b(document.body,[],1,!1,u),r.sort((d,f)=>tt(d.key,f.key)),{items:r,hosts:o,scrollX:s,scrollY:e,width:t,height:i}}function et(){let s=globalThis.innerWidth||0,e=globalThis.innerHeight||0,t=U&&(Math.abs((globalThis.scrollY||0)-U.scrollY)>e*.5||Math.abs((globalThis.scrollX||0)-U.scrollX)>s*.25||s!==U.width||e!==U.height);return(!U||X||t)&&(U=Vt(),X=!1),U}function O(){X||(X=!0,Ne())}function Ht(){if(Ze||typeof document>"u")return;Ze=!0,typeof MutationObserver=="function"&&new MutationObserver(e=>{for(let t of e){let i=t.target.nodeType===1?t.target:t.target.parentElement;if(!(!i||t.type==="attributes"&&i.closest(`[${Q}]`))){O();return}}}).observe(document.documentElement,{subtree:!0,childList:!0,characterData:!0,attributes:!0,attributeFilter:["style","class","hidden","src","open"]}),globalThis.addEventListener("scroll",e=>{e.target!==document&&e.target!==document.documentElement&&O()},{capture:!0,passive:!0}),globalThis.addEventListener("resize",O,{passive:!0});for(let e of["transitionend","transitioncancel","animationend","load"])document.addEventListener(e,O,!0);let s=()=>{pe.clear(),O()};document.fonts?.addEventListener?.("loadingdone",s),document.fonts?.ready?.then(s)}function qt(s,e,t,i,a){let{ascent:r,descent:o}=Ot(e.font,e.size);s.font=e.font,s.textBaseline="alphabetic",s.textAlign="left",e.letterSpacing&&"letterSpacing"in s&&(s.letterSpacing=e.letterSpacing),e.shadow&&(s.shadowColor=e.shadow.color,s.shadowOffsetX=e.shadow.x,s.shadowOffsetY=e.shadow.y,s.shadowBlur=e.shadow.blur),e.fill&&(s.fillStyle=e.fill),e.stroke&&(s.strokeStyle=e.stroke.color,s.lineWidth=e.stroke.width);let l=a.x+a.width,n=a.y+a.height;for(let h of e.words){let u=h.x+t,c=h.y+i;if(u>l||u+h.width<a.x||c>n||c+h.height<a.y)continue;let b=c+(h.height-(r+o))/2+r;e.fill&&s.fillText(h.text,u,b),e.stroke&&s.strokeText(h.text,u,b)}}function Xt(s){let e=et();if(!s)return{state:e,end:e.items.length};let t=e.hosts.get(s);if(t||(X=!0,e=et(),t=e.hosts.get(s)),!t)return{state:e,end:0};let i=0,a=e.items.length;for(;i<a;){let r=i+a>>1;tt(e.items[r].key,t)<0?i=r+1:a=r}return{state:e,end:i}}function de(s,e,t){Ht();let{state:i,end:a}=Xt(t),r=globalThis.scrollX||0,o=globalThis.scrollY||0,l=!0;for(let n=0;n<a;n++){let h=i.items[n],u=h.fixed?0:-r,c=h.fixed?0:-o;if(it({...h.box,x:h.box.x+u,y:h.box.y+c},e)){s.save(),s.globalAlpha*=h.alpha;try{h.type==="text"?qt(s,h,u,c,e):h.type==="media"?Ke(s,{element:h.element},e):(l=je(s,h.element,e)&&l,Yt(s,h.element))}finally{s.restore()}}}return l}function Yt(s,e){let t=getComputedStyle(e),i=parseFloat(t.borderTopWidth)||0;if(!(i>0)||t.borderTopStyle==="none"||I(t.borderTopColor))return;let a=e.getBoundingClientRect(),r=Math.max(0,(parseFloat(t.borderTopLeftRadius)||0)-i/2);s.save(),s.globalAlpha*=Number(t.opacity)||1,s.strokeStyle=t.borderTopColor,s.lineWidth=i,s.beginPath();let o=a.left+i/2,l=a.top+i/2,n=Math.max(0,a.width-i),h=Math.max(0,a.height-i);r>0&&typeof s.roundRect=="function"?s.roundRect(o,l,n,h,Math.min(r,n/2,h/2)):s.rect(o,l,n,h),s.stroke(),s.restore()}function me(){O()}var si=Object.freeze({refraction:17,edgeReach:.14,edgeWidth:.22,dispersion:0,frost:0,backdropBlur:0,body:.72,absorption:.58,tint:0}),ri=Object.freeze({outerWidth:.13,outerHeight:1.24,innerLength:0,innerHeight:.24});var es=Object.freeze({switch:{tint:1.5,frost:.24,tintTone:"light"},navbar:{tint:.34,frost:.32,tintTone:"dark"}});var be=Object.freeze({FOLDER:"folder",RECT:"rect",PILL:"pill",CIRCLE:"circle"}),Z=Object.freeze({REPLACE:"replace",OVERLAY:"overlay"}),z=Object.freeze({AUTO:"auto",STATIC:"static",LIVE:"live"}),ai="(prefers-reduced-transparency: reduce)";function oi(s){if(!Object.values(Z).includes(s))throw new TypeError(`Unknown liquid glass composite mode: ${s}`);return s}function ni(s){let e=s?.tagName?.toUpperCase();return e==="CANVAS"||e==="VIDEO"||s?.constructor?.name==="OffscreenCanvas"||s?.constructor?.name==="VideoFrame"}function li(s,e=z.AUTO){if(!Object.values(z).includes(e))throw new TypeError(`Unknown liquid glass backdrop update mode: ${e}`);return e===z.AUTO?ni(s)?z.LIVE:z.STATIC:e}function hi(s){let e=s==="folderRect"?be.RECT:s;if(!Object.values(be).includes(e))throw new TypeError(`Unknown liquid glass shape: ${s}`);return e}function st(s){return typeof s!="string"?Promise.resolve(s):new Promise((e,t)=>{let i=new Image;i.onload=()=>e(i),i.onerror=()=>t(new Error(`Unable to load liquid glass wallpaper: ${s}`)),i.src=s})}function ve(s,e){let t=Number(s.w??s.width??s.size??0),i=Number(s.h??s.height??s.size??t);if(!(t>0)||!(i>0))throw new TypeError("Liquid glass elements need a positive width and height.");return{...s,id:s.id??`glass-${e+1}`,shape:hi(s.shape??be.FOLDER),x:Number(s.x??0),y:Number(s.y??0),w:t,h:i}}function ci(s){return typeof globalThis.matchMedia=="function"?globalThis.matchMedia(s):null}var J=class{static isSupported(){if(typeof document>"u")return!1;try{let t=document.createElement("canvas").getContext("webgl2");return t?(t.getExtension("WEBGL_lose_context")?.loseContext(),!0):!1}catch{return!1}}constructor(e,t={}){if(!e||typeof e.getContext!="function")throw new TypeError("LiquidGlassWebGL needs an HTMLCanvasElement.");this.canvas=e,this.compositeMode=oi(t.compositeMode??Z.REPLACE),this.renderer=new V(e,{alpha:this.compositeMode===Z.OVERLAY,preserveDrawingBuffer:!!t.preserveDrawingBuffer}),this.material=typeof t.material=="string"?$(t.material):{...$("regular"),...t.material||{}},this.elements=[],this.fusion=!!(t.fusion??!1),this.wallpaperIndex=0,this.wallpaperZoom=t.wallpaperZoom??1,this.running=!1,this.animationFrame=0,this.onContextLost=t.onContextLost??null,this.onContextRestored=t.onContextRestored??null,this.dirty=!0,this.backdropDirty=!0,this.lastFrame={width:0,height:0,dpr:0},this.warnedShapeLimit=!1,this.respectReducedTransparency=t.respectReducedTransparency??!0,this.reducedTransparencyQuery=this.respectReducedTransparency?ci(ai):null,this.handleReducedTransparencyChange=()=>{this.markDirty(),this.render()},this.reducedTransparencyQuery?.addEventListener?.("change",this.handleReducedTransparencyChange),this.handleContextLost=i=>{i.preventDefault(),this.renderer.handleContextLost(),this.markBackdropDirty(),this.onContextLost?.(i)},this.handleContextRestored=i=>{this.renderer.restore(),this.markBackdropDirty(),this.lastFrame={width:0,height:0,dpr:0},this.onContextRestored?.(i),this.render()},e.addEventListener("webglcontextlost",this.handleContextLost,!1),e.addEventListener("webglcontextrestored",this.handleContextRestored,!1),this.resizeObserver=null,(t.autoResize??!0)&&typeof globalThis.ResizeObserver=="function"&&(this.resizeObserver=new globalThis.ResizeObserver(()=>{this.markDirty(),this.render()}),this.resizeObserver.observe(e)),t.elements&&this.setElements(t.elements,!1),t.wallpapers&&this.setWallpapers(t.wallpapers,!1),t.backdrop&&this.setBackdrop(t.backdrop,{update:t.backdropUpdate,autoStart:t.autoStart,shouldRender:!1})}get contextLost(){return this.renderer.lost}get reducedTransparency(){return!!this.reducedTransparencyQuery?.matches}get effectiveMaterial(){return this.reducedTransparency?{...this.material,..._e}:this.material}markDirty(){return this.dirty=!0,this}markBackdropDirty(){return this.backdropDirty=!0,this.markDirty()}setElements(e,t=!0){return this.elements=e.map((i,a)=>ve(i,a)),this.markDirty(),t&&this.render(),this}addElement(e,t=!0){let i=ve(e,this.elements.length);return this.elements.push(i),this.markDirty(),t&&this.render(),i.id}updateElement(e,t,i=!0){let a=this.elements.findIndex(r=>r.id===e);return a===-1?this:(this.elements[a]=ve({...this.elements[a],...t},a),this.markDirty(),i&&this.render(),this)}removeElement(e,t=!0){return this.elements=this.elements.filter(i=>i.id!==e),this.markDirty(),t&&this.render(),this}setMaterial(e,t=!0){return this.material=typeof e=="string"?$(e):{...this.material,...e||{}},this.markDirty(),t&&this.render(),this}setFusion(e,t=this.material.mergeRadius,i=!0){return this.fusion=!!e,Number.isFinite(t)&&(this.material.mergeRadius=Math.max(0,t)),this.markDirty(),i&&this.render(),this}setWallpapers(e,t=!0){return this.renderer.setWallpapers(e,{update:z.STATIC}),this.markBackdropDirty(),t&&this.render(),this}setBackdrop(e,t={}){if(!e||typeof e=="string")throw new TypeError("setBackdrop needs a CanvasImageSource. Use loadBackdrop for a URL.");let i=li(e,t.update);return this.renderer.setWallpapers([e],{update:i,scale:t.scale}),this.wallpaperIndex=0,this.markBackdropDirty(),(t.autoStart??i===z.LIVE)&&this.start(),(t.shouldRender??!0)&&this.render(),this}async loadBackdrop(e,t={}){let i=await st(e);return this.setBackdrop(i,{...t,update:t.update??z.STATIC})}updateBackdrop(e=!0){return this.renderer.refreshWallpapers(!0),this.markBackdropDirty(),e&&this.render(),this}async loadWallpapers(e,t=!0){let i=await Promise.all(e.map(st));return this.setWallpapers(i,t)}async setWallpaper(e,t=!0){return this.loadWallpapers([e],t)}setWallpaperIndex(e,t=!0){return this.wallpaperIndex=Math.max(0,Math.floor(e)),this.markBackdropDirty(),t&&this.render(),this}distanceAt(e,t,i={}){let a=i.fusion??this.fusion?i.mergeRadius??this.material.mergeRadius:0;return Ae(e,t,this.elements,this.material,a)}hitTest(e,t,i={}){return ke(e,t,this.elements,this.material,{fusion:i.fusion??this.fusion,mergeRadius:i.mergeRadius,tolerance:i.tolerance??0})}pointerPosition(e){let t=this.canvas.getBoundingClientRect(),i=e.touches?.[0]??e.changedTouches?.[0]??e;return{x:i.clientX-t.left,y:i.clientY-t.top}}hitTestEvent(e,t={}){let{x:i,y:a}=this.pointerPosition(e),r=t.tolerance??(e.pointerType&&e.pointerType!=="mouse"?8:0);return this.hitTest(i,a,{...t,tolerance:r})}start(){if(this.running)return this;if(typeof globalThis.requestAnimationFrame!="function")throw new Error("LiquidGlassWebGL.start() requires requestAnimationFrame.");this.running=!0;let e=()=>{this.running&&(this.render(),this.animationFrame=globalThis.requestAnimationFrame(e))};return this.animationFrame=globalThis.requestAnimationFrame(e),this}stop(){return this.running=!1,this.animationFrame&&typeof globalThis.cancelAnimationFrame=="function"&&globalThis.cancelAnimationFrame(this.animationFrame),this.animationFrame=0,this}resize(e=this.canvas.clientWidth||this.canvas.width||1,t=this.canvas.clientHeight||this.canvas.height||1,i=Math.min(globalThis.devicePixelRatio||1,2)){return this.renderer.resize(Math.round(e*i),Math.round(t*i)),{width:e,height:t,dpr:i}}render(e={}){if(this.renderer.lost)return this;let t=this.canvas.clientWidth||this.canvas.width||1,i=this.canvas.clientHeight||this.canvas.height||1,a=Number(e.dpr??globalThis.devicePixelRatio??1),r=Math.max(.5,Math.min(Number.isFinite(a)?a:1,2)),o=t!==this.lastFrame.width||i!==this.lastFrame.height||r!==this.lastFrame.dpr;if(!e.force&&!this.dirty&&!o&&!this.renderer.hasLiveBackdrop())return this;let l=this.renderer.hasLiveBackdrop();this.resize(t,i,r),(this.backdropDirty||o||l)&&(this.renderer.buildBackdrop(this.wallpaperIndex,this.wallpaperZoom),this.backdropDirty=!1),this.compositeMode===Z.OVERLAY?this.renderer.clearOutput():this.renderer.drawBackdrop();let n=this.effectiveMaterial;if(this.fusion){let{groups:h,truncated:u}=Y(this.elements,n.mergeRadius,16);u&&!this.warnedShapeLimit&&(this.warnedShapeLimit=!0,console.warn(`LiquidGlassWebGL: more than ${16} fused shapes are within merging distance of each other. They are drawn in separate passes, so the silhouette will not bridge across every one of them.`));for(let c of h)this.renderer.drawGlassGroup(c,n,r,n.mergeRadius)}else for(let h of this.elements)this.renderer.drawGlass(h,n,r);return this.dirty=!1,this.lastFrame={width:t,height:i,dpr:r},this}destroy(){this.stop(),this.canvas.removeEventListener("webglcontextlost",this.handleContextLost,!1),this.canvas.removeEventListener("webglcontextrestored",this.handleContextRestored,!1),this.reducedTransparencyQuery?.removeEventListener?.("change",this.handleReducedTransparencyChange),this.resizeObserver?.disconnect(),this.resizeObserver=null,this.renderer.destroy(),this.elements=[]}};var ui="snell-v1";return ht(di);})();
