import { useEffect, useRef } from 'react';

// Full-viewport topographic iso-line field. Raw WebGL2 (no three) so it stays cheap.
// Lines bend toward the cursor via a gaussian bump added to the height field.

const VERT = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uPull;
out vec4 o;
vec2 h2(vec2 p){ p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3))); return -1.+2.*fract(sin(p)*43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(dot(h2(i),f), dot(h2(i+vec2(1,0)),f-vec2(1,0)),u.x),
             mix(dot(h2(i+vec2(0,1)),f-vec2(0,1)), dot(h2(i+vec2(1,1)),f-vec2(1,1)),u.x),u.y); }
float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<4;i++){ s+=a*n(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return s; }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes.y;
  vec2 m = uMouse / uRes.y;
  float t = uTime * 0.012;
  float f = fbm(uv*1.6 + vec2(t, -t*0.6)) + 0.35*fbm(uv*3.1 - vec2(t*0.7, t));
  float d = distance(uv, m);
  f += uPull * 0.22 * exp(-d*d / 0.018);
  float k = f * 14.0;
  float w = fwidth(k);
  float line = 1.0 - smoothstep(0.0, w*1.1, abs(fract(k) - 0.5) - 0.5 + w*0.9);
  float idx = 1.0 - smoothstep(0.0, w*1.4, abs(fract(k/5.0) - 0.5)*5.0 - 2.5 + w*1.2);
  vec3 bg = vec3(0.0549, 0.0588, 0.0627);       // #0E0F10
  vec3 ln = vec3(0.1098, 0.1176, 0.1255);       // #1C1E20
  vec3 ix = vec3(0.1490, 0.1580, 0.1650);       // index contour, a touch brighter
  vec3 c = mix(bg, ln, line);
  c = mix(c, ix, idx);
  // faint vignette toward the corners
  vec2 q = gl_FragCoord.xy / uRes - 0.5;
  c *= 1.0 - 0.35*dot(q,q);
  o = vec4(c, 1.0);
}`;

export default function ContourBackground({ reduced, webgl }: { reduced: boolean; webgl: boolean }) {
  return webgl ? <ContourGL reduced={reduced} /> : <div className="contour-static" aria-hidden />;
}

function ContourGL({ reduced }: { reduced: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = cv.getContext('webgl2', { antialias: false, alpha: false });
    } catch {
      gl = null;
    }
    if (!gl) return;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uMouse = gl.getUniformLocation(prog, 'uMouse');
    const uPull = gl.getUniformLocation(prog, 'uPull');

    const scale = Math.min(window.devicePixelRatio || 1, 1.25);
    const resize = () => {
      cv.width = Math.floor(window.innerWidth * scale);
      cv.height = Math.floor(window.innerHeight * scale);
      gl.viewport(0, 0, cv.width, cv.height);
    };
    resize();
    window.addEventListener('resize', resize);

    const target = { x: cv.width * 0.5, y: cv.height * 0.5, pull: 0 };
    const cur = { x: target.x, y: target.y, pull: 0 };
    const onMove = (e: PointerEvent) => {
      target.x = e.clientX * scale;
      target.y = (window.innerHeight - e.clientY) * scale;
      target.pull = 1;
    };
    const onLeave = () => (target.pull = 0);
    window.addEventListener('pointermove', onMove);
    document.addEventListener('pointerleave', onLeave);

    let raf = 0;
    const t0 = performance.now();
    const frame = () => {
      cur.x += (target.x - cur.x) * 0.06;
      cur.y += (target.y - cur.y) * 0.06;
      cur.pull += (target.pull - cur.pull) * 0.04;
      gl.uniform2f(uRes, cv.width, cv.height);
      gl.uniform1f(uTime, reduced ? 0 : (performance.now() - t0) / 1000);
      gl.uniform2f(uMouse, cur.x, cur.y);
      gl.uniform1f(uPull, cur.pull);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
    };
  }, [reduced]);
  return <canvas ref={ref} className="contour-bg" aria-hidden />;
}
