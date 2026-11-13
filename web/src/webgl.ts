// One-time WebGL capability probe. `?nowebgl` forces the 2D fallback (for testing).
let cached: boolean | null = null;

export function hasWebGL(): boolean {
  if (cached != null) return cached;
  try {
    if (new URLSearchParams(location.search).has('nowebgl')) return (cached = false);
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    cached = !!gl;
    // release the probe context so it does not count against the browser's context limit
    (gl as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}

export function markWebGLBroken() {
  cached = false;
}
