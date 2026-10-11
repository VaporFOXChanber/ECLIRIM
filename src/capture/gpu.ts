import type { Rect } from '../shared/types';
import type { Pixels } from '../engine/sampling';

const VERTEX = `#version 300 es
uniform vec4 region;
out vec2 at;
void main() {
  // One triangle that covers the target. Row 0 of what is read back is the top of the picture.
  vec2 p = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.;
  at = region.xy + p * region.zw;
  gl_Position = vec4(p * 2. - 1., 0., 1.);
}`;
const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D picture;
in vec2 at;
out vec4 colour;
void main() { colour = vec4(texture(picture, at).rgb, 1.); }`;

/**
 * Reads a video frame scaled down by the GPU.
 *
 * Drawing a video into a 2D canvas that is read back makes Chrome copy the whole decoded frame out of the GPU first,
 * so its cost grows with the resolution of the video (measured on an Apple M4: about 7 ms at 1080p, 22 ms at 4K),
 * however small the canvas is. Here the frame stays on the GPU, is scaled there, and only the small result is copied
 * out (about 3 ms and 5 ms). The scaling is the same bilinear one the 2D canvas does, so the colours are the same.
 *
 * It asks for nothing a canvas does not: a video Chrome will not let a canvas read (another origin without CORS) throws
 * here as well, and a protected one gives no picture here either.
 */
export class GpuReader {
  private canvas: OffscreenCanvas | null = null; private gl: WebGL2RenderingContext | null = null;
  private region: WebGLUniformLocation | null = null; private data = new Uint8ClampedArray(0); private bytes = new Uint8Array(0);
  private failed = false;
  private open(): WebGL2RenderingContext | null {
    if (this.gl || this.failed) return this.gl;
    try {
      const canvas = new OffscreenCanvas(2, 2);
      // No software WebGL: where there is no GPU, the 2D canvas is the faster way.
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true });
      if (!gl) throw new Error('no WebGL 2');
      const program = gl.createProgram()!;
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
        const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader); gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('shader');
      gl.useProgram(program); this.region = gl.getUniformLocation(program, 'region');
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // A page may hold only so many WebGL contexts, and Chrome drops the oldest. If ours goes, the 2D canvas takes over.
      canvas.addEventListener('webglcontextlost', () => { if (this.canvas === canvas) this.close(true); });
      this.canvas = canvas; this.gl = gl;
    } catch { this.close(true); }
    return this.gl;
  }
  /**
   * `region` of the video's current frame as `width`×`height` pixels, or null where this way of reading is not
   * available (the caller then uses the 2D canvas). Throws what a canvas would throw for a video that may not be read.
   */
  read(video: HTMLVideoElement, region: Rect, width: number, height: number, space: PredefinedColorSpace): Pixels | null {
    const gl = this.open(), canvas = this.canvas;
    if (!gl || !canvas || !video.videoWidth || !video.videoHeight) return null;
    // Colours of a wide-gamut video are kept only where WebGL can be told which colour space to read them in.
    if (!('unpackColorSpace' in gl)) { if (space !== 'srgb') return null; }
    else if (gl.unpackColorSpace !== space) { gl.unpackColorSpace = space; gl.drawingBufferColorSpace = space; }
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    if (this.bytes.length !== width * height * 4) { this.bytes = new Uint8Array(width * height * 4); this.data = new Uint8ClampedArray(this.bytes.buffer); }
    try {
      gl.viewport(0, 0, width, height);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.uniform4f(this.region, region.x / video.videoWidth, region.y / video.videoHeight, region.width / video.videoWidth, region.height / video.videoHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.bytes);
    } catch (error) {
      // Not ours to read: the same refusal a canvas gives, passed on as it is.
      if ((error as DOMException)?.name === 'SecurityError') throw error;
      this.close(true); return null;
    }
    // A lost context reads back as black without saying so.
    if (gl.isContextLost()) { this.close(true); return null; }
    return { width, height, data: this.data };
  }
  /** Gives the WebGL context back. `failed`: for good, so that it is not opened again. */
  close(failed = false): void {
    if (failed) this.failed = true;
    try { this.gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Already gone. */ }
    this.gl = null; this.canvas = null; this.region = null;
  }
  get available(): boolean { return !this.failed; }
}
