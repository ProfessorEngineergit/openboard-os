var MegaGlass=(()=>{var u=Object.defineProperty;var v=Object.getOwnPropertyDescriptor;var h=Object.getOwnPropertyNames;var d=Object.prototype.hasOwnProperty;var f=(n,t)=>{for(var e in t)u(n,e,{get:t[e],enumerable:!0})},m=(n,t,e,a)=>{if(t&&typeof t=="object"||typeof t=="function")for(let r of h(t))!d.call(n,r)&&r!==e&&u(n,r,{get:()=>t[r],enumerable:!(a=v(t,r))||a.enumerable});return n};var R=n=>m(u({},"__esModule",{value:!0}),n);var A={};f(A,{WebGLGlass:()=>c,default:()=>x});var g=`#version 300 es
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
}`,p=`#version 300 es
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
}`;var c=class{gl;canvas;lensCount=0;capacity=0;dpr=1;_data=new Float32Array(0);_source=null;program;quadBuf;instBuf;vao;tex;uResolution;uTex;constructor(t){let e=t.getContext("webgl2",{premultipliedAlpha:!1,alpha:!0,antialias:!1});if(!e)throw new Error("WebGL2 not available");this.gl=e,this.canvas=t,this.program=this.makeProgram(g,p),this.uResolution=e.getUniformLocation(this.program,"uResolution"),this.uTex=e.getUniformLocation(this.program,"uTex"),this.vao=e.createVertexArray(),e.bindVertexArray(this.vao);let a=new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]);this.quadBuf=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.quadBuf),e.bufferData(e.ARRAY_BUFFER,a,e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),this.instBuf=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.instBuf);let r=36;e.enableVertexAttribArray(1),e.vertexAttribPointer(1,4,e.FLOAT,!1,r,0),e.vertexAttribDivisor(1,1),e.enableVertexAttribArray(2),e.vertexAttribPointer(2,4,e.FLOAT,!1,r,16),e.vertexAttribDivisor(2,1),e.enableVertexAttribArray(3),e.vertexAttribPointer(3,1,e.FLOAT,!1,r,32),e.vertexAttribDivisor(3,1),e.bindVertexArray(null),this.tex=e.createTexture(),e.bindTexture(e.TEXTURE_2D,this.tex),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.enable(e.BLEND),e.blendFuncSeparate(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA,e.ONE,e.ONE_MINUS_SRC_ALPHA)}makeProgram(t,e){let a=this.gl,r=a.createProgram();if(a.attachShader(r,this.makeShader(a.VERTEX_SHADER,t)),a.attachShader(r,this.makeShader(a.FRAGMENT_SHADER,e)),a.linkProgram(r),!a.getProgramParameter(r,a.LINK_STATUS))throw new Error(`link: ${a.getProgramInfoLog(r)}`);return r}makeShader(t,e){let a=this.gl,r=a.createShader(t);if(a.shaderSource(r,e),a.compileShader(r),!a.getShaderParameter(r,a.COMPILE_STATUS))throw new Error(`compile: ${a.getShaderInfoLog(r)}`);return r}setSource(t){let e=this.gl;e.bindTexture(e.TEXTURE_2D,this.tex),e.pixelStorei(e.UNPACK_FLIP_Y_WEBGL,!1),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,t),this._source=t}updateSource(){this._source&&this.setSource(this._source)}resize(t,e,a=window.devicePixelRatio||1){this.canvas.width=Math.round(t*a),this.canvas.height=Math.round(e*a),this.canvas.style.width=`${t}px`,this.canvas.style.height=`${e}px`,this.dpr=a}setLenses(t){let e=this.gl,a=this.dpr||1,r=t.length;r>this.capacity&&(this.capacity=Math.max(r,this.capacity*2||16),this._data=new Float32Array(this.capacity*9));let i=this._data;for(let l=0;l<r;l++){let o=t[l],s=l*9;i[s]=(o.x+o.w/2)*a,i[s+1]=(o.y+o.h/2)*a,i[s+2]=o.w/2*a,i[s+3]=o.h/2*a,i[s+4]=Math.min(o.radius??9999,Math.min(o.w,o.h)/2)*a,i[s+5]=(o.depth??12)*a,i[s+6]=(o.scale??90)*a,i[s+7]=o.chroma??.4,i[s+8]=o.specular??.4}this.lensCount=r,e.bindBuffer(e.ARRAY_BUFFER,this.instBuf),e.bufferData(e.ARRAY_BUFFER,i,e.DYNAMIC_DRAW)}render(){let t=this.gl;t.viewport(0,0,this.canvas.width,this.canvas.height),t.clearColor(0,0,0,0),t.clear(t.COLOR_BUFFER_BIT),this.lensCount&&(t.useProgram(this.program),t.uniform2f(this.uResolution,this.canvas.width,this.canvas.height),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this.tex),t.uniform1i(this.uTex,0),t.bindVertexArray(this.vao),t.drawArraysInstanced(t.TRIANGLES,0,6,this.lensCount),t.bindVertexArray(null))}destroy(){let t=this.gl;t.deleteBuffer(this.quadBuf),t.deleteBuffer(this.instBuf),t.deleteVertexArray(this.vao),t.deleteTexture(this.tex),t.deleteProgram(this.program)}},x=c;return R(A);})();
