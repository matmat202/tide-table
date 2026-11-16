/* Copied from stanford-on-github/site/story/gl.js (itself from name-years, from paper-of-the-year). The WebGL layer: N round points, each moving between two layouts (A -> B) as `t` goes
 * 0 -> 1. Plain WebGL1 so it runs everywhere; no libraries. */

const VS = `
attribute vec4 a; // x, y, colour, alpha in layout A
attribute vec4 b; // the same in layout B
attribute float seed;
uniform float t, time, size, dpr;
uniform vec4 rect;  // plot x, y, w, h in device pixels (y from the top)
uniform vec2 res;
uniform vec3 pal[6];
varying vec4 col;
vec3 pick(float i) {
  vec3 c = pal[0];
  for (int k = 1; k < 6; k++) if (abs(i - float(k)) < 0.5) c = pal[k];
  return c;
}
void main() {
  // a sweep from left to right: each point starts a little after the one to its left
  float d = 0.35 * mix(a.x, b.x, 0.5) + 0.1 * seed;
  float k = clamp((t - d) / (1.0 - 0.45), 0.0, 1.0);
  k = k * k * (3.0 - 2.0 * k);
  vec2 p = mix(a.xy, b.xy, k);
  // an arc mid-flight, and a slow breathing drift so the field never sits dead still
  p.y += sin(3.14159 * k) * (0.06 + 0.08 * seed) * step(0.001, distance(a.xy, b.xy));
  float alive = mix(a.w, b.w, k);
  float drift = 0.004 * (1.0 - step(0.999, alive));
  p += drift * vec2(sin(time * 0.6 + seed * 40.0), cos(time * 0.5 + seed * 31.0));
  vec2 px = rect.xy + vec2(p.x, 1.0 - p.y) * rect.zw;
  gl_Position = vec4(px / res * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  gl_PointSize = size * dpr * (0.6 + 0.4 * alive);
  col = vec4(mix(pick(a.z), pick(b.z), k), alive);
}`;

const FS = `
precision mediump float;
varying vec4 col;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float e = 1.0 - smoothstep(0.38, 0.5, r);
  if (e * col.a < 0.01) discard;
  gl_FragColor = vec4(col.rgb, 1.0) * e * col.a;
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export function createPoints(canvas, N, palette) {
  const gl = canvas.getContext('webgl', { antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const loc = (n) => gl.getUniformLocation(prog, n);
  const u = { t: loc('t'), time: loc('time'), size: loc('size'), dpr: loc('dpr'), rect: loc('rect'), res: loc('res'), pal: loc('pal') };
  gl.uniform3fv(u.pal, new Float32Array(palette.flat()));

  const buf = (name, size, data) => {
    const bo = gl.createBuffer(), at = gl.getAttribLocation(prog, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, bo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, size, gl.FLOAT, false, 0, 0);
    return bo;
  };
  const seeds = new Float32Array(N).map((_, i) => ((i * 2654435761) % 1000) / 1000);
  const bA = buf('a', 4, new Float32Array(N * 4));
  const bB = buf('b', 4, new Float32Array(N * 4));
  buf('seed', 1, seeds);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  let A = null, B = null;
  return {
    gl,
    set(a, b) {
      if (a !== A) { gl.bindBuffer(gl.ARRAY_BUFFER, bA); gl.bufferSubData(gl.ARRAY_BUFFER, 0, a); A = a; }
      if (b !== B) { gl.bindBuffer(gl.ARRAY_BUFFER, bB); gl.bufferSubData(gl.ARRAY_BUFFER, 0, b); B = b; }
    },
    draw({ t, time, size, rect, dpr }) {
      const w = canvas.width, h = canvas.height;
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(u.t, t);
      gl.uniform1f(u.time, time);
      gl.uniform1f(u.size, size);
      gl.uniform1f(u.dpr, dpr);
      gl.uniform4f(u.rect, rect[0] * dpr, rect[1] * dpr, rect[2] * dpr, rect[3] * dpr);
      gl.uniform2f(u.res, w, h);
      gl.drawArrays(gl.POINTS, 0, N);
    },
  };
}
