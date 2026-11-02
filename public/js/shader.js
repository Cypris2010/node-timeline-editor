// Rendert Shadertoy-artige Fragment-Shader per WebGL in der Matrix-Auflösung.

const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
const HEADER = `precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform float iProgress;
uniform vec4 iAudio;
uniform vec4 iParam;
`;
const FOOTER = `
void main() {
  vec4 c = vec4(0.0, 0.0, 0.0, 1.0);
  mainImage(c, gl_FragCoord.xy);
  float a = clamp(c.a, 0.0, 1.0);
  gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0) * a, a);
}`;
const HEADER_LINES = HEADER.split('\n').length - 1;
const MAX_CACHE = 30;

export class ShaderRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: true, alpha: true });
    this.programs = new Map();   // Code → { program, uniforms } | { error }
    if (!this.gl) return;
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vert = this.compile(gl.VERTEX_SHADER, VERT).shader;
  }

  compile(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) || 'Unbekannter Fehler';
      gl.deleteShader(s);
      // Zeilennummern auf den Code des Nutzers umrechnen
      return { error: log.replace(/\0/g, '').replace(/ERROR: 0:(\d+)/g, (_, n) => `Zeile ${Math.max(1, n - HEADER_LINES)}`).trim() };
    }
    return { shader: s };
  }

  program(code) {
    let entry = this.programs.get(code);
    if (entry) return entry;
    const gl = this.gl;
    const frag = this.compile(gl.FRAGMENT_SHADER, HEADER + code + FOOTER);
    if (frag.error) entry = { error: frag.error };
    else {
      const program = gl.createProgram();
      gl.attachShader(program, this.vert);
      gl.attachShader(program, frag.shader);
      gl.bindAttribLocation(program, 0, 'p');
      gl.linkProgram(program);
      gl.deleteShader(frag.shader);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) entry = { error: gl.getProgramInfoLog(program) };
      else {
        const u = (n) => gl.getUniformLocation(program, n);
        entry = { program, uniforms: { res: u('iResolution'), time: u('iTime'), progress: u('iProgress'), audio: u('iAudio'), param: u('iParam') } };
      }
    }
    this.programs.set(code, entry);
    if (this.programs.size > MAX_CACHE) {
      const [oldCode, old] = this.programs.entries().next().value;
      if (old.program) gl.deleteProgram(old.program);
      this.programs.delete(oldCode);
    }
    return entry;
  }

  // Liefert { canvas } oder { error }
  render(code, w, h, { time, progress, audio, params }) {
    const gl = this.gl;
    if (!gl) return { error: 'WebGL ist in diesem Browser nicht verfügbar.' };
    const entry = this.program(code);
    if (entry.error) return { error: entry.error };
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(entry.program);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const u = entry.uniforms;
    gl.uniform3f(u.res, w, h, 1);
    gl.uniform1f(u.time, time);
    gl.uniform1f(u.progress, progress);
    gl.uniform4f(u.audio, audio.level, audio.bass, audio.mid, audio.high);
    gl.uniform4f(u.param, ...params);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { canvas: this.canvas };
  }
}
