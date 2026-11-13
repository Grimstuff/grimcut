import { keyRgb, rgbToUv, spillChannel } from "../core/chromakey";
import type { KeyParams } from "../core/types";

/**
 * Live chroma key for the preview: video frame → WebGL passes → canvas with alpha.
 * Mirrors the export chain (chromakey → erosion × choke → gblur feather → despill) at source
 * resolution so what you see is what FFmpeg writes.
 */

const VERT = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

// Pass 1: 3×3 mean chroma distance → alpha; despill the color.
const KEY_FRAG = `
precision highp float;
uniform sampler2D src;
uniform vec2 size;
uniform vec2 keyUv;
uniform float sim;
uniform float blend;
uniform float spill;
uniform int spillCh; // 0 none, 1 green, 2 blue
vec2 uvOf(vec3 c) {
  c *= 255.0;
  return vec2(128.0 + (-0.16874 * c.r - 0.33126 * c.g + 0.5 * c.b),
              128.0 + (0.5 * c.r - 0.41869 * c.g - 0.08131 * c.b));
}
void main() {
  vec2 px = gl_FragCoord.xy;
  float diff = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 q = clamp(px + vec2(float(dx), float(dy)), vec2(0.5), size - 0.5);
      vec2 d = uvOf(texture2D(src, q / size).rgb) - keyUv;
      diff += sqrt(dot(d, d) / (255.0 * 255.0 * 2.0));
    }
  }
  diff /= 9.0;
  float a = blend > 0.0001 ? clamp((diff - sim) / blend, 0.0, 1.0) : (diff > sim ? 1.0 : 0.0);
  vec3 c = texture2D(src, px / size).rgb;
  if (spillCh == 1) {
    float s = max(c.g - (c.r * 0.5 + c.b * 0.5), 0.0);
    c.g = max(c.g - s * spill, 0.0);
  } else if (spillCh == 2) {
    float s = max(c.b - (c.r * 0.5 + c.g * 0.5), 0.0);
    c.b = max(c.b - s * spill, 0.0);
  }
  gl_FragColor = vec4(c, a);
}
`;

// Separable min (choke) over ±radius px along `dir`.
const MIN_FRAG = `
precision highp float;
uniform sampler2D src;
uniform vec2 size;
uniform vec2 dir;
uniform float radius;
void main() {
  vec2 px = gl_FragCoord.xy;
  vec4 c = texture2D(src, px / size);
  float a = c.a;
  for (int i = 1; i <= 8; i++) {
    if (float(i) > radius) break;
    vec2 o = dir * float(i);
    a = min(a, texture2D(src, clamp(px + o, vec2(0.5), size - 0.5) / size).a);
    a = min(a, texture2D(src, clamp(px - o, vec2(0.5), size - 0.5) / size).a);
  }
  gl_FragColor = vec4(c.rgb, a);
}
`;

// Separable Gaussian on alpha only (feather).
const BLUR_FRAG = `
precision highp float;
uniform sampler2D src;
uniform vec2 size;
uniform vec2 dir;
uniform float sigma;
void main() {
  vec2 px = gl_FragCoord.xy;
  vec4 c = texture2D(src, px / size);
  float sum = c.a;
  float wsum = 1.0;
  for (int i = 1; i <= 24; i++) {
    float fi = float(i);
    if (fi > sigma * 3.0) break;
    float w = exp(-(fi * fi) / (2.0 * sigma * sigma));
    vec2 o = dir * fi;
    sum += w * texture2D(src, clamp(px + o, vec2(0.5), size - 0.5) / size).a;
    sum += w * texture2D(src, clamp(px - o, vec2(0.5), size - 0.5) / size).a;
    wsum += 2.0 * w;
  }
  gl_FragColor = vec4(c.rgb, sum / wsum);
}
`;

// Final: flip to screen orientation, premultiply for the canvas.
const OUT_FRAG = `
precision highp float;
uniform sampler2D src;
uniform vec2 size;
void main() {
  vec2 uv = vec2(gl_FragCoord.x / size.x, 1.0 - gl_FragCoord.y / size.y);
  vec4 c = texture2D(src, uv);
  gl_FragColor = vec4(c.rgb * c.a, c.a);
}
`;

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

export class KeyRenderer {
  private gl: WebGLRenderingContext;
  private key: Prog;
  private min: Prog;
  private blur: Prog;
  private out: Prog;
  private srcTex: WebGLTexture;
  private pp: { tex: WebGLTexture; fb: WebGLFramebuffer }[] = [];
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL unavailable");
    this.gl = gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.key = this.prog(KEY_FRAG, ["src", "size", "keyUv", "sim", "blend", "spill", "spillCh"]);
    this.min = this.prog(MIN_FRAG, ["src", "size", "dir", "radius"]);
    this.blur = this.prog(BLUR_FRAG, ["src", "size", "dir", "sigma"]);
    this.out = this.prog(OUT_FRAG, ["src", "size"]);
    this.srcTex = this.texture();
  }

  private prog(frag: string, names: string[]): Prog {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, "p");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    const u: Prog["u"] = {};
    for (const n of names) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }

  private texture() {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private resize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    const gl = this.gl;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const t of this.pp) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    this.pp = [0, 1].map(() => {
      const tex = this.texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb };
    });
  }

  private pass(prog: Prog, input: WebGLTexture, target: WebGLFramebuffer | null, set: (u: Prog["u"]) => void) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.uniform1i(prog.u.src, 0);
    gl.uniform2f(prog.u.size, this.w, this.h);
    set(prog.u);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Key the video's current frame onto the canvas. False when the frame can't be read. */
  render(video: HTMLVideoElement, k: KeyParams): boolean {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return false;
    const gl = this.gl;
    this.resize(vw, vh);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch {
      return false;
    }
    const [r, g, b] = keyRgb(k.color);
    const [u, v] = rgbToUv(r, g, b);
    const ch = spillChannel(k.color);
    let cur = 0;
    this.pass(this.key, this.srcTex, this.pp[0].fb, (un) => {
      gl.uniform2f(un.keyUv, u, v);
      gl.uniform1f(un.sim, k.similarity);
      gl.uniform1f(un.blend, k.blend);
      gl.uniform1f(un.spill, k.spill);
      gl.uniform1i(un.spillCh, ch === "green" ? 1 : ch === "blue" ? 2 : 0);
    });
    const twoPass = (prog: Prog, set: (un: Prog["u"]) => void) => {
      for (const dir of [
        [1, 0],
        [0, 1],
      ]) {
        const next = 1 - cur;
        this.pass(prog, this.pp[cur].tex, this.pp[next].fb, (un) => {
          gl.uniform2f(un.dir, dir[0], dir[1]);
          set(un);
        });
        cur = next;
      }
    };
    const choke = Math.round(Math.max(0, Math.min(8, k.choke)));
    if (choke > 0) twoPass(this.min, (un) => gl.uniform1f(un.radius, choke));
    if (k.feather > 0.05) twoPass(this.blur, (un) => gl.uniform1f(un.sigma, Math.min(8, k.feather)));
    this.pass(this.out, this.pp[cur].tex, null, () => {});
    return true;
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
