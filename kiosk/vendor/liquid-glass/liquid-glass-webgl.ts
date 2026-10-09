/**
 * liquid-glass-webgl.ts
 * ---------------------
 * A WebGL2 backend for refracting a surface that's *already a texture* — an
 * image, a <canvas>, a <video>, or any `TexImageSource`. Displacement is
 * computed analytically in the shader and every lens is one instance of a single
 * draw call, so cost is flat in the number of lenses.
 *
 * Usage:
 *   const r = new WebGLGlass(canvas);
 *   r.setSource(imageOrCanvasOrVideo);
 *   r.resize(width, height);
 *   r.setLenses([{ x, y, w, h, radius, depth, scale, chroma, specular }]);
 *   r.render();
 */

import type { LensSpec } from "./types.js";

const VERT = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aRect;
layout(location=2) in vec4 aParams;
layout(location=3) in float aSpecular;
uniform vec2 uResolution;
out vec2 vLocal;
out vec2 vHalf;
out vec4 vParams;
out float vSpec;
void main() {
  vHalf = aRect.zw;
  vParams = aParams;
  vSpec = aSpecular;
  vec2 corner = aCorner * 2.0 - 1.0;
  float margin = 2.0;
  vec2 px = aRect.xy + corner * (vHalf + margin);
  vLocal = px - aRect.xy;
  vec2 clip = (px / uResolution) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vHalf;
in vec4 vParams;
in float vSpec;
uniform sampler2D uTex;
uniform vec2 uResolution;
out vec4 outColor;

float sdfRoundRect(vec2 p, vec2 hs, float r) {
  vec2 q = abs(p) - (hs - r);
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

void main() {
  float radius = vParams.x;
  float depth  = vParams.y;
  float scale  = vParams.z;
  float chroma = vParams.w;
  float r = min(radius, min(vHalf.x, vHalf.y));

  float sdf = sdfRoundRect(vLocal, vHalf, r);
  float alpha = smoothstep(1.0, -1.0, sdf);
  if (alpha <= 0.001) discard;

  float e = 1.0;
  vec2 grad = vec2(
    sdfRoundRect(vLocal + vec2(e, 0.0), vHalf, r) - sdfRoundRect(vLocal - vec2(e, 0.0), vHalf, r),
    sdfRoundRect(vLocal + vec2(0.0, e), vHalf, r) - sdfRoundRect(vLocal - vec2(0.0, e), vHalf, r)
  );
  grad = (length(grad) > 1e-4) ? normalize(grad) : vec2(0.0);

  float rim = max(1.0, depth);
  float mag = 1.0 - smoothstep(0.0, 1.0, -sdf / rim);
  vec2 dispPx = grad * mag * scale;

  vec2 base = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uResolution;
  vec2 d = dispPx / uResolution;
  d.y = -d.y;

  float cr = texture(uTex, base + d * (1.0 + 0.18 * chroma)).r;
  float cg = texture(uTex, base + d * (1.0 + 0.09 * chroma)).g;
  float cb = texture(uTex, base + d).b;
  vec3 col = vec3(cr, cg, cb);

  vec2 light = normalize(vec2(-0.7071, 0.7071));
  float facing = max(0.0, dot(grad, light));
  col += vSpec * mag * facing * facing;

  outColor = vec4(col, alpha);
}`;

const FLOATS_PER_LENS = 9; // rect(4) + params(4) + specular(1)

export class WebGLGlass {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;

  private lensCount = 0;
  private capacity = 0;
  private dpr = 1;
  private _data: Float32Array = new Float32Array(0);
  private _source: TexImageSource | null = null;

  private readonly program: WebGLProgram;
  private readonly quadBuf: WebGLBuffer;
  private readonly instBuf: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly tex: WebGLTexture;
  private readonly uResolution: WebGLUniformLocation | null;
  private readonly uTex: WebGLUniformLocation | null;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      alpha: true,
      antialias: false,
    });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.canvas = canvas;

    this.program = this.makeProgram(VERT, FRAG);
    this.uResolution = gl.getUniformLocation(this.program, "uResolution");
    this.uTex = gl.getUniformLocation(this.program, "uTex");

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const stride = FLOATS_PER_LENS * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
  }

  private makeProgram(vsrc: string, fsrc: string): WebGLProgram {
    const gl = this.gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, this.makeShader(gl.VERTEX_SHADER, vsrc));
    gl.attachShader(p, this.makeShader(gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
    return p;
  }
  private makeShader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(`compile: ${gl.getShaderInfoLog(s)}`);
    return s;
  }

  /** Upload the source surface (image / canvas / video / bitmap). */
  setSource(src: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this._source = src;
  }

  /** Re-upload a changing source (e.g. a playing video) each frame. */
  updateSource(): void {
    if (this._source) this.setSource(this._source);
  }

  resize(
    width: number,
    height: number,
    dpr = window.devicePixelRatio || 1,
  ): void {
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.dpr = dpr;
  }

  /** Lens coordinates are CSS px relative to the canvas top-left. */
  setLenses(lenses: LensSpec[]): void {
    const gl = this.gl;
    const dpr = this.dpr || 1;
    const n = lenses.length;
    if (n > this.capacity) {
      this.capacity = Math.max(n, this.capacity * 2 || 16);
      this._data = new Float32Array(this.capacity * FLOATS_PER_LENS);
    }
    const a = this._data;
    for (let i = 0; i < n; i++) {
      const L = lenses[i];
      const o = i * FLOATS_PER_LENS;
      a[o] = (L.x + L.w / 2) * dpr;
      a[o + 1] = (L.y + L.h / 2) * dpr;
      a[o + 2] = (L.w / 2) * dpr;
      a[o + 3] = (L.h / 2) * dpr;
      a[o + 4] = Math.min(L.radius ?? 9999, Math.min(L.w, L.h) / 2) * dpr;
      a[o + 5] = (L.depth ?? 12) * dpr;
      a[o + 6] = (L.scale ?? 90) * dpr;
      a[o + 7] = L.chroma ?? 0.4;
      a[o + 8] = L.specular ?? 0.4;
    }
    this.lensCount = n;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, a, gl.DYNAMIC_DRAW);
  }

  render(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.lensCount) return;

    gl.useProgram(this.program);
    gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.uTex, 0);

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.lensCount);
    gl.bindVertexArray(null);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.quadBuf);
    gl.deleteBuffer(this.instBuf);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.tex);
    gl.deleteProgram(this.program);
  }
}

export default WebGLGlass;
