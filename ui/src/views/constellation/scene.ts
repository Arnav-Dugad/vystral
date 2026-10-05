import type * as ThreeNS from 'three';
import type { GalaxyLayout } from './layout';

/**
 * Imperative three.js renderer for the Constellation. `three` is passed in from a dynamic
 * import so the library only loads when this view is opened. One `Points` draw call handles
 * tens of thousands of stars; picking is done in screen space against the projected points.
 * The loop only runs while something is moving and never while paused (hidden window, game
 * running, view offscreen); under reduced motion it renders on demand only.
 */

type Three = typeof ThreeNS;
export type PauseLevel = 'none' | 'soft' | 'hard';

export interface StarAttributes {
  /** rgb 0..1 per star, in layout order. */
  colors: Float32Array;
  sizes: Float32Array;
  /** 0..1 brightness per star (installed games are brighter). */
  brightness: Float32Array;
}

export interface SceneCallbacks {
  onHover(index: number | null): void;
  onPick(index: number | null): void;
}

export interface SceneOverlay {
  labels: (HTMLElement | null)[];
  hover: HTMLElement | null;
  selected: HTMLElement | null;
}

export interface ConstellationScene {
  setData(layout: GalaxyLayout, attrs: StarAttributes): void;
  setOverlay(overlay: SceneOverlay): void;
  setHover(index: number | null): void;
  setSelected(index: number | null): void;
  /** Frames a cluster (or the whole galaxy for null). */
  focusCluster(index: number | null): void;
  setReducedMotion(reduce: boolean): void;
  /** 'soft': no animation loop, but explicit changes still draw one frame. 'hard': no GPU work at all. */
  setPaused(level: PauseLevel): void;
  zoom(factor: number): void;
  dispose(): void;
}

const VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aBright;
attribute float aPhase;
uniform float uTime;
uniform float uScale;
uniform float uTwinkle;
uniform float uFocusCluster;
attribute float aCluster;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 1.0 + uTwinkle * 0.16 * sin(uTime * 1.4 + aPhase);
  float dim = (uFocusCluster < 0.0 || abs(aCluster - uFocusCluster) < 0.5) ? 1.0 : 0.42;
  gl_PointSize = clamp(aSize * uScale * tw / -mv.z, 2.0, 72.0);
  vColor = aColor;
  vAlpha = aBright * dim;
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float glow = exp(-d * d * 22.0);
  float core = smoothstep(0.16, 0.0, d);
  float a = (glow * 0.85 + core) * vAlpha;
  if (a < 0.012) discard;
  vec3 col = vColor * (0.55 + glow * 0.75) + vec3(core * 0.7);
  gl_FragColor = vec4(col, a);
}`;

const DUST_VERT = /* glsl */ `
attribute float aSize;
uniform float uScale;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / -mv.z, 1.0, 6.0);
  vA = 0.5;
}`;

const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vA * 0.35;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
}`;

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

export function createConstellationScene(
  THREE: Three,
  host: HTMLElement,
  accent: [number, number, number],
  callbacks: SceneCallbacks,
): ConstellationScene {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power', premultipliedAlpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.className = 'cst-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 4000);

  // ---- Orbit state (spherical around a target) ----
  const target = new THREE.Vector3();
  const goalTarget = new THREE.Vector3();
  let theta = 0.75, phi = 1.02, radius = 60;
  let goalTheta = theta, goalPhi = phi, goalRadius = radius;
  let minRadius = 6, maxRadius = 400;
  let vTheta = 0, vPhi = 0;
  let reduce = false;
  let pause: PauseLevel = 'none';
  let disposed = false;
  let focused = -1;
  let extent = 20;

  const uniforms = {
    uTime: { value: 0 },
    uScale: { value: 300 },
    uTwinkle: { value: 1 },
    uFocusCluster: { value: -1 },
  };

  let stars: ThreeNS.Points | null = null;
  let starGeo: ThreeNS.BufferGeometry | null = null;
  const starMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  // Faint disc dust and orbit rings: purely decorative, give the plane its depth.
  const dustGeo = new THREE.BufferGeometry();
  const dustUniforms = { uScale: uniforms.uScale, uColor: { value: new THREE.Color(accent[0], accent[1], accent[2]) } };
  const dustMat = new THREE.ShaderMaterial({ vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, uniforms: dustUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const dust = new THREE.Points(dustGeo, dustMat);
  scene.add(dust);
  const ringMat = new THREE.LineBasicMaterial({ color: new THREE.Color(accent[0], accent[1], accent[2]), transparent: true, opacity: 0.07, depthWrite: false });
  const rings: ThreeNS.LineLoop[] = [];

  let layout: GalaxyLayout | null = null;
  let sizes: Float32Array = new Float32Array(0);
  let overlay: SceneOverlay = { labels: [], hover: null, selected: null };
  let hoverIndex: number | null = null;
  let selectedIndex: number | null = null;

  // ---- Resize ----
  let width = 1, height = 1;
  const resize = () => {
    const r = host.getBoundingClientRect();
    width = Math.max(1, Math.round(r.width));
    height = Math.max(1, Math.round(r.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // Point sizes are in CSS-pixel-ish units scaled by the drawing buffer.
    uniforms.uScale.value = (height / 900) * 300 * renderer.getPixelRatio();
    if (focused === -1 && layout) fitOverview();
    measureLabels();
    invalidate();
  };

  /**
   * Frames every cluster: the target moves to the centre of the clusters' footprint (big clusters
   * are rarely at the origin) and the camera backs off until that footprint's bounding circle fits
   * the viewport at the orbit's tilt, including the near edge growing with perspective.
   */
  function fitOverview() {
    if (!layout || layout.centers.length === 0) {
      goalTarget.set(0, 0, 0);
      goalRadius = Math.min(maxRadius, extent * 1.85);
      return;
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of layout.centers) {
      minX = Math.min(minX, c.x - c.radius);
      maxX = Math.max(maxX, c.x + c.radius);
      minZ = Math.min(minZ, c.z - c.radius);
      maxZ = Math.max(maxZ, c.z + c.radius);
    }
    goalTarget.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    const r = Math.hypot(maxX - minX, maxZ - minZ) / 2 + 1.5;
    const vHalf = (camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    const needV = (r * Math.cos(goalPhi)) / Math.tan(vHalf) + r * Math.sin(goalPhi);
    const needH = r / Math.tan(hHalf) + r * Math.sin(goalPhi) * 0.5;
    goalRadius = Math.min(maxRadius, Math.max(minRadius, Math.max(needV, needH) * 1.06));
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  // ---- Loop ----
  let raf = 0;
  let staticRaf = 0;
  let last = performance.now();
  let clock = 0;
  let lost = false;

  function invalidate() {
    if (disposed || lost || pause === 'hard') return;
    if (pause === 'soft') {
      staticRaf ||= requestAnimationFrame(() => {
        staticRaf = 0;
        if (!disposed && !lost && pause !== 'hard') render();
      });
      return;
    }
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  function settled() {
    return (
      Math.abs(goalTheta - theta) < 1e-4 &&
      Math.abs(goalPhi - phi) < 1e-4 &&
      Math.abs(goalRadius - radius) < 1e-3 &&
      target.distanceToSquared(goalTarget) < 1e-6 &&
      Math.abs(vTheta) < 1e-5 &&
      Math.abs(vPhi) < 1e-5
    );
  }

  function frame(now: number) {
    raf = 0;
    if (pause !== 'none' || disposed || lost) return;
    const interactive = dragging || !settled();
    // Ambient-only motion (auto-rotation, twinkle) runs at ~30 fps to stay light.
    if (!interactive && !reduce && now - last < 31) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (!reduce) {
      clock += dt;
      uniforms.uTime.value = clock;
      // Slow auto-rotation of the view around the disc (off while a cluster is framed).
      // Paused while a star is hovered so it doesn't drift out from under the pointer.
      if (focused < 0 && !dragging && hoverIndex == null) {
        goalTheta += dt * 0.035;
        theta += dt * 0.035;
      }
    }
    if (Math.abs(vTheta) > 1e-5 || Math.abs(vPhi) > 1e-5) {
      goalTheta += vTheta;
      goalPhi = clampPhi(goalPhi + vPhi);
      const decay = Math.pow(0.0025, dt);
      vTheta *= decay;
      vPhi *= decay;
    }
    const k = reduce ? 1 : 1 - Math.pow(0.0009, dt);
    theta += (goalTheta - theta) * k;
    phi += (goalPhi - phi) * k;
    radius += (goalRadius - radius) * k;
    target.lerp(goalTarget, k);

    render();
    if (!reduce || !settled()) raf = requestAnimationFrame(frame);
  }

  const clampPhi = (p: number) => Math.min(1.45, Math.max(0.18, p));

  const proj = new THREE.Matrix4();

  function render() {
    const sp = Math.sin(phi);
    camera.position.set(target.x + radius * sp * Math.sin(theta), target.y + radius * Math.cos(phi), target.z + radius * sp * Math.cos(theta));
    camera.lookAt(target);
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    placeOverlay();
  }

  /** Projects a world point to CSS pixels; returns null when behind the camera. */
  function project(x: number, y: number, z: number): { x: number; y: number; depth: number } | null {
    const e = proj.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 0.01) return null;
    const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
    const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
    return { x: (cx * 0.5 + 0.5) * width, y: (1 - (cy * 0.5 + 0.5)) * height, depth: w };
  }

  function placeAt(el: HTMLElement | null, index: number | null) {
    if (!el) return;
    if (index == null || !layout || index >= layout.order.length) {
      el.style.opacity = '0';
      return;
    }
    const p = layout.positions;
    const s = project(p[index * 3], p[index * 3 + 1], p[index * 3 + 2]);
    if (!s || s.x < -40 || s.y < -40 || s.x > width + 40 || s.y > height + 40) {
      el.style.opacity = '0';
      return;
    }
    const px = Math.max(14, Math.min(64, (sizes[index] * uniforms.uScale.value) / s.depth / renderer.getPixelRatio()) * 0.9);
    el.style.opacity = '1';
    el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0)`;
    el.style.setProperty('--marker', `${px.toFixed(1)}px`);
  }

  let labelSizes: { w: number; h: number }[] = [];
  function measureLabels() {
    labelSizes = overlay.labels.map((el) => ({ w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 }));
  }

  function placeOverlay() {
    if (!layout) return;
    const near = radius * 0.6, far = radius * 2.2;
    const focal = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const tilt = Math.max(0.3, Math.cos(phi));
    // Priority: the framed cluster, then larger clusters (layout order is largest first).
    const order = layout.centers.map((_, i) => i);
    if (focused >= 0) order.sort((a, b) => (a === focused ? -1 : b === focused ? 1 : a - b));
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const i of order) {
      const c = layout.centers[i];
      const el = overlay.labels[i];
      if (!el) continue;
      const s = project(c.x, c.y, c.z);
      if (!s) {
        el.style.opacity = '0';
        el.dataset.hidden = 'true';
        continue;
      }
      // Sit just above the cluster's visible top edge rather than on its stars.
      const top = s.y - (c.radius * focal * tilt) / s.depth - 6;
      const size = labelSizes[i] ?? { w: 80, h: 22 };
      const rect = { x0: s.x - size.w / 2 - 4, y0: top - size.h - 2, x1: s.x + size.w / 2 + 4, y1: top + 2 };
      const clash = taken.some((r) => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0);
      if (clash && focused !== i) {
        el.style.opacity = '0';
        el.dataset.hidden = 'true';
        continue;
      }
      taken.push(rect);
      // Fade far labels; keep the focused cluster's label crisp.
      const t = Math.min(1, Math.max(0, (far - s.depth) / (far - near)));
      const opacity = focused === i ? 1 : focused >= 0 ? 0.45 + t * 0.25 : 0.55 + t * 0.45;
      el.style.opacity = opacity.toFixed(2);
      delete el.dataset.hidden;
      el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${top.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
    placeAt(overlay.hover, hoverIndex);
    placeAt(overlay.selected, selectedIndex);
  }

  // ---- Picking ----
  function pick(clientX: number, clientY: number): number | null {
    if (!layout || !layout.order.length) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    const p = layout.positions;
    const e = proj.elements;
    const pr = renderer.getPixelRatio();
    let best: number | null = null;
    let bestScore = Infinity;
    for (let i = 0, n = layout.order.length; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 0.01) continue;
      const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * width;
      const sy = (1 - ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5 + 0.5)) * height;
      const dx = sx - mx, dy = sy - my;
      const d2 = dx * dx + dy * dy;
      const rad = Math.max(9, (sizes[i] * uniforms.uScale.value) / w / pr * 0.35);
      if (d2 > rad * rad) continue;
      // Prefer the closest star on screen, then nearer to the camera.
      const score = d2 + w * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  // ---- Pointer orbit controls ----
  let dragging = false;
  let dragMoved = false;
  let downX = 0, downY = 0, lastX = 0, lastY = 0;
  let pointerId = -1;

  /** UI floating over the canvas (cards, buttons, labels) opts out of orbiting with data-no-orbit. */
  const blocked = (e: Event) => e.target instanceof Element && !!e.target.closest('[data-no-orbit]');

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || blocked(e)) return;
    dragging = true;
    dragMoved = false;
    pointerId = e.pointerId;
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    vTheta = vPhi = 0;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (dragging && e.pointerId === pointerId) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (!dragMoved && Math.hypot(e.clientX - downX, e.clientY - downY) > 4) {
        dragMoved = true;
        try {
          host.setPointerCapture(e.pointerId);
        } catch {
          // capture is best-effort
        }
        host.dataset.dragging = 'true';
      }
      if (dragMoved) {
        const sx = (-dx / Math.max(1, height)) * Math.PI;
        const sy = (-dy / Math.max(1, height)) * Math.PI * 0.8;
        goalTheta += sx;
        goalPhi = clampPhi(goalPhi + sy);
        vTheta = reduce ? 0 : sx * 0.35;
        vPhi = reduce ? 0 : sy * 0.35;
        if (hoverIndex != null) callbacks.onHover(null);
        invalidate();
      }
      return;
    }
    const hit = blocked(e) ? null : pick(e.clientX, e.clientY);
    if (hit !== hoverIndex) callbacks.onHover(hit);
    host.style.cursor = hit != null ? 'pointer' : '';
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    delete host.dataset.dragging;
    try {
      host.releasePointerCapture(e.pointerId);
    } catch {
      // not captured
    }
    if (!dragMoved) callbacks.onPick(pick(e.clientX, e.clientY) ?? hoverIndex);
    if (reduce) vTheta = vPhi = 0;
    invalidate();
  };
  const onPointerLeave = () => {
    if (!dragging && hoverIndex != null) callbacks.onHover(null);
  };
  const onWheel = (e: WheelEvent) => {
    if (blocked(e)) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    zoom(Math.exp(delta * 0.0012));
  };

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  host.addEventListener('pointerleave', onPointerLeave);
  host.addEventListener('wheel', onWheel, { passive: false });

  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const onRestored = () => {
    lost = false;
    invalidate();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  function zoom(factor: number) {
    goalRadius = Math.min(maxRadius, Math.max(minRadius, goalRadius * factor));
    invalidate();
  }

  function buildDecor() {
    for (const r of rings) {
      scene.remove(r);
      r.geometry.dispose();
    }
    rings.length = 0;
    for (const f of [0.38, 0.68, 1.02]) {
      const pts: number[] = [];
      const R = extent * f;
      for (let i = 0; i < 160; i++) {
        const a = (i / 160) * Math.PI * 2;
        pts.push(Math.cos(a) * R, 0, Math.sin(a) * R);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const loop = new THREE.LineLoop(g, ringMat);
      rings.push(loop);
      scene.add(loop);
    }
    const rand = seeded(42);
    const n = 1400;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Two loose logarithmic arms plus a soft halo.
      const arm = i % 2;
      const t = Math.pow(rand(), 0.7);
      const r = t * extent * 1.25;
      const a = arm * Math.PI + t * 4.2 + (rand() - 0.5) * 0.9;
      pos[i * 3] = Math.cos(a) * r + (rand() - 0.5) * 3;
      pos[i * 3 + 1] = (rand() - 0.5) * (1.6 - t);
      pos[i * 3 + 2] = Math.sin(a) * r + (rand() - 0.5) * 3;
      size[i] = 2 + rand() * 4;
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    dustGeo.computeBoundingSphere();
  }

  const api: ConstellationScene = {
    setData(next, attrs) {
      layout = next;
      sizes = attrs.sizes;
      extent = Math.max(8, next.extent);
      if (stars) {
        scene.remove(stars);
        starGeo?.dispose();
      }
      starGeo = new THREE.BufferGeometry();
      const n = next.order.length;
      const phase = new Float32Array(n);
      const cluster = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        phase[i] = (i * 2.399) % (Math.PI * 2);
        cluster[i] = next.clusterOf[i];
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(next.positions, 3));
      starGeo.setAttribute('aColor', new THREE.BufferAttribute(attrs.colors, 3));
      starGeo.setAttribute('aSize', new THREE.BufferAttribute(attrs.sizes, 1));
      starGeo.setAttribute('aBright', new THREE.BufferAttribute(attrs.brightness, 1));
      starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
      starGeo.setAttribute('aCluster', new THREE.BufferAttribute(cluster, 1));
      starGeo.computeBoundingSphere();
      stars = new THREE.Points(starGeo, starMat);
      stars.frustumCulled = false;
      scene.add(stars);
      buildDecor();
      minRadius = 5;
      maxRadius = extent * 6;
      focused = -1;
      uniforms.uFocusCluster.value = -1;
      fitOverview();
      if (reduce || radius === 60) {
        radius = goalRadius;
        target.copy(goalTarget);
      }
      hoverIndex = null;
      selectedIndex = null;
      invalidate();
    },
    setOverlay(next) {
      overlay = next;
      measureLabels();
      invalidate();
    },
    setHover(index) {
      hoverIndex = index;
      invalidate();
    },
    setSelected(index) {
      selectedIndex = index;
      invalidate();
    },
    focusCluster(index) {
      if (!layout) return;
      if (index == null || index < 0 || index >= layout.centers.length) {
        focused = -1;
        uniforms.uFocusCluster.value = -1;
        fitOverview();
      } else {
        const c = layout.centers[index];
        focused = index;
        uniforms.uFocusCluster.value = index;
        goalTarget.set(c.x, c.y, c.z);
        goalRadius = Math.max(minRadius, c.radius * 4.2 + 6);
      }
      vTheta = vPhi = 0;
      invalidate();
    },
    setReducedMotion(next) {
      reduce = next;
      uniforms.uTwinkle.value = next ? 0 : 1;
      if (next) vTheta = vPhi = 0;
      invalidate();
    },
    setPaused(next) {
      if (pause === next) return;
      pause = next;
      if (pause !== 'none') {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (pause === 'hard') {
        cancelAnimationFrame(staticRaf);
        staticRaf = 0;
      }
      invalidate();
    },
    zoom,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(staticRaf);
      ro.disconnect();
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('pointerleave', onPointerLeave);
      host.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      starGeo?.dispose();
      starMat.dispose();
      dustGeo.dispose();
      dustMat.dispose();
      for (const r of rings) r.geometry.dispose();
      ringMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };

  resize();
  return api;
}
