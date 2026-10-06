import { useEffect, useRef } from 'react';
import { cssOklch, fallbackPalette, labToLch, lchToLab, mixLch, parseOklch, type LCh, type RGB } from '../../lib/color';
import { MOOD_INDEX, moodFor, moodSpeed, type Mood } from '../../lib/mood';
import { paletteFor } from '../../lib/palette';
import { clampAccent, FOLLOW, followRgb, initialFollow, labDistance, stepFollow, useHeroTrailer, type FollowState } from '../../lib/trailer/tint';
import { useGameRunning, useReducedMotion, useStore } from '../../state/store';

/**
 * The Living Canvas: an ambient, palette-driven background rendered with one small WebGL2
 * shader at reduced resolution (≤30 fps). It reacts to the focused game, pauses whenever the
 * window is hidden or a game is running, renders a single still frame under reduced motion,
 * and falls back to a static CSS gradient when WebGL is unavailable or quality is "low".
 *
 * While a hero trailer is visibly playing, a third palette layer (uL, weighted by uLive) eases
 * toward the trailer's colours (lib/trailer/tint.ts) and back to the artwork when it stops.
 */

const VERT = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;

const FRAG = `#version 300 es
precision mediump float;
uniform float uT, uMix, uMoodA, uMoodB, uIntensity, uSpeed;
uniform vec2 uRes;
uniform vec3 uA[4], uB[4], uL[4];
uniform float uLive;
out vec4 o;

float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f*=f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+1.),f.x), f.y); }
float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<3;i++){ v+=a*n(p); p*=2.03; a*=.5; } return v; }

vec3 mood(float m, vec2 uv, float t){
  vec3 c = vec3(0.);
  if (m < .5) return c;                                   // drift: base only
  if (m < 1.5) {                                          // velocity: sweeping light trails
    for (int i=0;i<5;i++){ float fi=float(i);
      float y = fract(.17*fi + .11) ;
      float x = fract(uv.x*.6 - t*(.12+.05*fi) + h(vec2(fi,3.)));
      float line = smoothstep(.006,.0, abs(uv.y - y - (uv.x-.5)*.18)) * smoothstep(0.,.6,x) * smoothstep(1.,.75,x);
      c += line * .55;
    } return c;
  }
  if (m < 2.5) {                                          // cosmos: parallax stars
    for (int l=0;l<3;l++){ float fl=float(l);
      vec2 g = uv*vec2(uRes.x/uRes.y,1.)*(40.+fl*35.) + vec2(t*(.4+fl*.3),0.);
      vec2 id=floor(g), f=fract(g)-.5; float r=h(id+fl*13.);
      float s = smoothstep(.06,.0,length(f-(vec2(h(id+1.),h(id+2.))-.5)*.6)) * step(.93,r);
      c += s * (.35+.65*sin(t*3.+r*40.)*.5+.3) * (1.-fl*.25);
    } return c;
  }
  if (m < 3.5) {                                          // ember: warm rising motes
    vec2 g = uv*vec2(uRes.x/uRes.y,1.)*18. + vec2(0., -t*1.2);
    vec2 id=floor(g), f=fract(g)-.5; float r=h(id);
    float s = smoothstep(.12,.0,length(f-(vec2(h(id+3.),h(id+5.))-.5)*.7)) * step(.86,r);
    return vec3(1.,.62,.32) * s * (.5+.5*sin(t*2.+r*30.)) * smoothstep(.0,.6,1.-uv.y);
  }
  if (m < 4.5) {                                          // dread: low drifting fog
    float f = fbm(uv*vec2(3.,5.) + vec2(t*.05, 0.));
    return vec3(.6,.62,.7) * smoothstep(.45,.9,f) * smoothstep(.75,.0,uv.y) * .5;
  }
  float w = sin(uv.y*28. + sin(uv.x*6.+t*.6)*1.4 - t*.5);   // tide: calm bands
  return vec3(.7,.85,1.) * smoothstep(.96,1.,w) * .25;
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float t = uT * uSpeed;
  vec2 q = uv + .35*vec2(n(uv*2.+t*.03), n(uv*2.-t*.03+5.2));
  float a = n(q*1.7+t*.03), b = n(q*2.3-t*.021);
  vec3 c0=mix(mix(uA[0],uB[0],uMix),uL[0],uLive), c1=mix(mix(uA[1],uB[1],uMix),uL[1],uLive);
  vec3 c2=mix(mix(uA[2],uB[2],uMix),uL[2],uLive), c3=mix(mix(uA[3],uB[3],uMix),uL[3],uLive);
  vec3 col = mix(mix(c0,c1,a), mix(c2,c3,b), smoothstep(.2,.8,q.y));
  float glow = smoothstep(1.25,.15,length(uv-vec2(.62,.78)));
  col *= .5 + .75*glow*uIntensity;
  vec3 m = mix(mood(uMoodA,uv,t), mood(uMoodB,uv,t), uMix);
  col += m * mix(c3, vec3(1.), .5) * uIntensity;
  float darken = mix(step(3.5,uMoodA)*step(uMoodA,4.5), step(3.5,uMoodB)*step(uMoodB,4.5), uMix);
  col *= 1. - .35*darken;
  col *= smoothstep(1.35,.35,length((uv-.5)*vec2(1.2,1.)));   // vignette
  col += (h(gl_FragCoord.xy + uT) - .5) / 255.;                 // dither: no banding on dark gradients
  o = vec4(col, 1.);
}`;

interface CanvasState {
  a: RGB[];
  b: RGB[];
  moodA: Mood;
  moodB: Mood;
  mix: number;
  mixStart: number;
  /** Artwork accent of the focused game (restored when trailer-following ends). */
  accentCss: string | null;
}

/** How often (at most) trailer-following may nudge the page accent, and by how much at least. */
const ACCENT_EVERY_MS = 2600;
const ACCENT_MIN_SHIFT = 0.03;
/** Share of the trailer's accent blended into the game's artwork accent at full follow. */
const ACCENT_FOLLOW = 0.5;

export function LivingCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const settings = useStore((s) => s.settings);
  const focusId = useStore((s) => s.focusGameId);
  const game = useStore((s) => (focusId ? s.gamesById.get(focusId) : undefined));
  const running = useGameRunning();
  const reduce = useReducedMotion();
  const safeMode = useStore((s) => s.info?.safeMode ?? false);
  const state = useRef<CanvasState>({ a: fallbackPalette().ambient, b: fallbackPalette().ambient, moodA: 'drift', moodB: 'drift', mix: 1, mixStart: 0, accentCss: null });
  const requestFrame = useRef<() => void>(() => {});

  const enabled = !!settings?.['appearance.livingCanvas'] && settings['appearance.quality'] !== 'low' && !safeMode;
  const intensity = settings?.['appearance.canvasIntensity'] ?? 0.7;
  const quality = settings?.['appearance.quality'] ?? 'auto';
  const fixedAccent = settings?.['appearance.accent'] && settings['appearance.accent'] !== 'auto' ? settings['appearance.accent'] : null;
  const followTrailer = settings?.['canvas.followTrailer'] !== false;
  const live = useRef({ fixedAccent, focusId, follow: followTrailer, intensity });
  live.current = { fixedAccent, focusId, follow: followTrailer, intensity };
  // Intensity is a uniform: a slider drag only redraws, it never rebuilds the GL program.
  useEffect(() => requestFrame.current(), [intensity]);

  // Palette + mood follow the focused game, debounced so fast browsing doesn't thrash.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const palette = game ? await paletteFor(game) : fallbackPalette();
      if (cancelled) return;
      const root = document.documentElement.style;
      const s = state.current;
      if (!fixedAccent) {
        root.setProperty('--game', palette.accent);
        root.setProperty('--game-2', palette.accent2);
        s.accentCss = palette.accent;
      } else s.accentCss = null;
      const now = performance.now();
      // Start from wherever the current blend is, so rapid changes never jump.
      const t = Math.min(1, (now - s.mixStart) / 1200);
      s.a = s.a.map((c, i) => c.map((v, j) => v + (s.b[i][j] - v) * t) as RGB);
      s.moodA = t > 0.5 ? s.moodB : s.moodA;
      s.b = palette.ambient;
      s.moodB = moodFor(game);
      s.mixStart = now;
      requestFrame.current();
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [game, fixedAccent]);

  useEffect(() => {
    if (!fixedAccent || fixedAccent === 'system') return; // 'system': applied by SystemBackdrop
    const map: Record<string, [string, string]> = {
      violet: ['oklch(0.7 0.17 292)', 'oklch(0.68 0.15 255)'],
      blue: ['oklch(0.7 0.15 255)', 'oklch(0.72 0.12 220)'],
      cyan: ['oklch(0.78 0.12 210)', 'oklch(0.7 0.14 255)'],
      rose: ['oklch(0.74 0.16 5)', 'oklch(0.7 0.15 330)'],
      amber: ['oklch(0.82 0.15 75)', 'oklch(0.74 0.16 45)'],
      emerald: ['oklch(0.78 0.15 160)', 'oklch(0.74 0.12 195)'],
    };
    const [a, b] = map[fixedAccent] ?? map.violet;
    document.documentElement.style.setProperty('--game', a);
    document.documentElement.style.setProperty('--game-2', b);
  }, [fixedAccent]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !enabled) return;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
    if (!gl) return;
    const program = link(gl);
    if (!program) return;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (n: string) => gl.getUniformLocation(program, n);
    const uT = u('uT'), uRes = u('uRes'), uMix = u('uMix'), uMA = u('uMoodA'), uMB = u('uMoodB'), uI = u('uIntensity'), uS = u('uSpeed'), uA = u('uA'), uB = u('uB'), uL = u('uL'), uLive = u('uLive');

    const scale = quality === 'high' ? 0.55 : 0.4;
    let disposed = false;
    const resize = () => {
      const w = Math.max(64, Math.floor(innerWidth * scale));
      const h = Math.max(64, Math.floor(innerHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    resize();

    let raf = 0;
    let last = 0;
    const start = performance.now();
    const animate = !reduce && !running;

    // Trailer following: only while animating (never under reduced motion or while a game runs).
    let follow: FollowState = initialFollow();
    let lastStep = 0;
    let accentAt = 0;
    let appliedAccent: LCh | null = null;
    const followAccent = (now: number) => {
      const { fixedAccent: fixed } = live.current;
      const art = parseOklch(state.current.accentCss);
      if (fixed || !art) return;
      if (follow.weight <= 0.02) {
        // Done following: hand the accent back to the artwork (once).
        if (appliedAccent) {
          appliedAccent = null;
          document.documentElement.style.setProperty('--game', state.current.accentCss!);
        }
        return;
      }
      if (now - accentAt < ACCENT_EVERY_MS) return;
      const next = clampAccent(mixLch(art, labToLch(follow.accent), ACCENT_FOLLOW * (follow.weight / FOLLOW.maxWeight)));
      if (appliedAccent && labDistance(lchToLab(appliedAccent), lchToLab(next)) < ACCENT_MIN_SHIFT) return;
      accentAt = now;
      appliedAccent = next;
      // --game is a registered property with a 900 ms transition, so this glides.
      document.documentElement.style.setProperty('--game', cssOklch(next));
    };

    const draw = (now: number) => {
      if (disposed) return;
      const s = state.current;
      const mix = Math.min(1, (now - s.mixStart) / 1200);
      const eased = mix < 0.5 ? 4 * mix ** 3 : 1 - (-2 * mix + 2) ** 3 / 2;
      gl.uniform1f(uT, reduce ? 12 : (now - start) / 1000);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uMix, eased);
      gl.uniform1f(uMA, MOOD_INDEX[s.moodA]);
      gl.uniform1f(uMB, MOOD_INDEX[s.moodB]);
      gl.uniform1f(uI, live.current.intensity);
      gl.uniform1f(uS, moodSpeed(eased > 0.5 ? s.moodB : s.moodA));
      gl.uniform3fv(uA, s.a.flat());
      gl.uniform3fv(uB, s.b.flat());
      if (animate) {
        const tint = useHeroTrailer.getState().tint;
        const target = live.current.follow && tint && tint.gameId === live.current.focusId ? tint : null;
        follow = stepFollow(follow, target, lastStep ? now - lastStep : 0);
        lastStep = now;
        followAccent(now);
      }
      gl.uniform3fv(uL, followRgb(follow).flat());
      gl.uniform1f(uLive, follow.weight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = (now: number) => {
      raf = 0;
      if (document.hidden) {
        lastStep = 0;
        return;
      }
      if (now - last >= 33) {
        last = now;
        draw(now);
      }
      if (animate) raf = requestAnimationFrame(loop);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    // Still frames (reduced motion / game running) still redraw when the palette changes.
    requestFrame.current = () => {
      if (animate) return kick();
      const s = state.current;
      const settle = () => {
        if (disposed) return;
        draw(performance.now());
        if (performance.now() - s.mixStart < 1300) requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    };
    const onVis = () => !document.hidden && kick();
    document.addEventListener('visibilitychange', onVis);
    addEventListener('resize', resize);
    kick();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      removeEventListener('resize', resize);
      requestFrame.current = () => {};
      if (appliedAccent && state.current.accentCss && !live.current.fixedAccent) document.documentElement.style.setProperty('--game', state.current.accentCss);
      gl.deleteProgram(program);
      gl.deleteBuffer(buf);
    };
  }, [enabled, reduce, running, quality]);

  return (
    <div className="living-canvas" aria-hidden data-enabled={enabled}>
      {enabled && <canvas ref={ref} className="living-canvas__gl" />}
      <div className="living-canvas__scrim" />
    </div>
  );
}

function link(gl: WebGL2RenderingContext): WebGLProgram | null {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('[LivingCanvas] shader error', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  };
  const v = compile(gl.VERTEX_SHADER, VERT);
  const f = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!v || !f) {
    if (v) gl.deleteShader(v);
    if (f) gl.deleteShader(f);
    return null;
  }
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  // The linked program keeps what it needs; the shader objects can go.
  gl.detachShader(p, v);
  gl.detachShader(p, f);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    gl.deleteProgram(p);
    return null;
  }
  gl.useProgram(p);
  return p;
}
