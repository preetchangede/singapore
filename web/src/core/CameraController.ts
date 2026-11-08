import * as THREE from 'three';

export interface View {
  x: number; z: number; y: number;   // target point (world)
  range: number;                      // distance camera -> target (m)
  heading: number;                    // radians, 0 = north, clockwise
  pitch: number;                      // radians, negative = looking down
}

type Mode = 'orbit' | 'walk';
const DEG = Math.PI / 180;

function wrapAngle(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function smootherstep(t: number) { t = Math.min(1, Math.max(0, t)); return t * t * t * (t * (t * 6 - 15) + 10); }
function damp(cur: number, goal: number, tau: number, dt: number) { return goal + (cur - goal) * Math.exp(-dt / tau); }

/**
 * Orbit-style "globe" navigation (grab the ground, zoom to cursor, tilt/rotate) with
 * exponential smoothing, plus a first-person street mode and cinematic fly-to paths.
 */
export class CameraController {
  mode: Mode = 'orbit';
  view: View = { x: 0, z: 0, y: 0, range: 3000, heading: 0, pitch: -40 * DEG };
  goal: View = { ...this.view };
  // first-person
  walk = { x: 0, y: 2, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0 };
  walkGoal = { yaw: 0, pitch: 0 };
  heightAt: (x: number, z: number) => number = () => 0;
  obstacleAt: (x: number, z: number) => number = () => 0;  // roof height of buildings below
  onUserInput: () => void = () => {};
  flight: null | {
    t: number; dur: number; from: View; to: View;
    S: number; u0: [number, number]; u1: [number, number]; w0: number; w1: number; r0: number; d: number; rho: number;
    done?: () => void;
  } = null;
  enabled = true;
  private keys = new Set<string>();
  private pointers = new Map<number, { x: number; y: number }>();
  private dragMode: 'pan' | 'rotate' | 'look' | null = null;
  private grab = new THREE.Vector3();
  private grabPlaneY = 0;
  private last = { x: 0, y: 0 };
  private pinch = { dist: 0, angle: 0, midY: 0 };
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private tmp = new THREE.Vector3();
  private velocity = { x: 0, z: 0 };
  private lastMoveT = 0;

  constructor(public camera: THREE.PerspectiveCamera, private el: HTMLElement) {
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // ------------------------------------------------------------------ helpers
  private rayFromScreen(cx: number, cy: number) {
    const r = this.el.getBoundingClientRect();
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.ray;
  }

  /** Intersect a screen ray with the horizontal plane y = py. Returns null for rays above the horizon. */
  groundPoint(cx: number, cy: number, py: number, out: THREE.Vector3) {
    const ray = this.rayFromScreen(cx, cy);
    const dy = ray.direction.y;
    if (dy > -0.02) {
      // near-horizon: clamp to a far point along the ray projected on the plane
      const far = Math.min(this.view.range * 6, 60000);
      out.copy(ray.origin).addScaledVector(ray.direction, far);
      out.y = py;
      return out;
    }
    const t = (py - ray.origin.y) / dy;
    const tt = Math.min(t, Math.max(this.view.range * 8, 2000));
    return out.copy(ray.origin).addScaledVector(ray.direction, tt);
  }

  private cancelFlight() {
    if (this.flight) {
      this.flight = null;
    }
  }

  // ------------------------------------------------------------------ input
  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.el.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.cancelFlight();
    this.onUserInput();
    this.velocity.x = this.velocity.z = 0;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch.dist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinch.angle = Math.atan2(b.y - a.y, b.x - a.x);
      this.pinch.midY = (a.y + b.y) / 2;
      this.dragMode = null;
      return;
    }
    this.last.x = e.clientX; this.last.y = e.clientY;
    if (this.mode === 'walk') { this.dragMode = 'look'; return; }
    const rotate = e.button === 2 || e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
    if (rotate) { this.dragMode = 'rotate'; return; }
    this.dragMode = 'pan';
    this.grabPlaneY = this.goal.y;
    this.groundPoint(e.clientX, e.clientY, this.grabPlaneY, this.grab);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) { this.onPinch(); return; }
    const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
    this.last.x = e.clientX; this.last.y = e.clientY;
    if (this.dragMode === 'look') {
      this.walkGoal.yaw += dx * 0.0032;
      this.walkGoal.pitch = Math.max(-80 * DEG, Math.min(80 * DEG, this.walkGoal.pitch + dy * 0.0032));
    } else if (this.dragMode === 'rotate') {
      this.goal.heading = this.goal.heading - dx * 0.0045;
      this.goal.pitch = Math.max(this.minPitch(), Math.min(this.maxPitch(), this.goal.pitch - dy * 0.0035));
    } else if (this.dragMode === 'pan') {
      // keep the grabbed ground point under the cursor (evaluate against the *goal* camera)
      this.applyGoalToCamera();
      const p = this.groundPoint(e.clientX, e.clientY, this.grabPlaneY, this.tmp);
      const ox = this.grab.x - p.x, oz = this.grab.z - p.z;
      const lim = Math.max(this.goal.range * 2, 400);
      const sx = Math.max(-lim, Math.min(lim, ox)), sz = Math.max(-lim, Math.min(lim, oz));
      this.goal.x += sx; this.goal.z += sz;
      const now = performance.now();
      const dtm = Math.max(1, now - this.lastMoveT) / 1000;
      this.lastMoveT = now;
      this.velocity.x = this.velocity.x * 0.6 + (sx / dtm) * 0.4;
      this.velocity.z = this.velocity.z * 0.6 + (sz / dtm) * 0.4;
      this.applyCurrentToCamera();
    }
  };

  private onPinch() {
    const [a, b] = [...this.pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const midY = (a.y + b.y) / 2;
    if (this.pinch.dist > 0) {
      const s = this.pinch.dist / Math.max(dist, 1);
      if (this.mode === 'orbit') {
        this.goal.range = this.clampRange(this.goal.range * s);
        this.goal.heading -= wrapAngle(ang - this.pinch.angle);
        this.goal.pitch = Math.max(this.minPitch(), Math.min(this.maxPitch(), this.goal.pitch - (midY - this.pinch.midY) * 0.004));
      } else {
        const f = (1 - s) * 40;
        this.walk.x += Math.sin(this.walk.yaw) * f;
        this.walk.z -= Math.cos(this.walk.yaw) * f;
      }
    }
    this.pinch.dist = dist; this.pinch.angle = ang; this.pinch.midY = midY;
  }

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      // fling momentum after a pan
      if (this.dragMode === 'pan' && performance.now() - this.lastMoveT < 80) {
        this.goal.x += this.velocity.x * 0.25;
        this.goal.z += this.velocity.z * 0.25;
      }
      this.dragMode = null;
    }
    if (this.pointers.size === 1) {
      const p = [...this.pointers.values()][0];
      this.last.x = p.x; this.last.y = p.y;
      this.pinch.dist = 0;
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.cancelFlight();
    this.onUserInput();
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 33;
    if (e.deltaMode === 2) d *= 400;
    d = Math.max(-600, Math.min(600, d));
    if (this.mode === 'walk') {
      const f = -d * 0.05;
      this.walk.x += Math.sin(this.walk.yaw) * f;
      this.walk.z -= Math.cos(this.walk.yaw) * f;
      return;
    }
    const factor = Math.exp(d * 0.0016);
    const newRange = this.clampRange(this.goal.range * factor);
    const k = 1 - newRange / this.goal.range;
    // zoom toward the cursor
    this.applyGoalToCamera();
    const p = this.groundPoint(e.clientX, e.clientY, this.goal.y, this.tmp);
    this.applyCurrentToCamera();
    this.goal.x += (p.x - this.goal.x) * k;
    this.goal.z += (p.z - this.goal.z) * k;
    this.goal.range = newRange;
    this.goal.pitch = Math.max(this.minPitch(), Math.min(this.maxPitch(), this.goal.pitch));
  };

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    this.keys.add(e.code);
    if (/^(Key[WASDQERF]|Arrow|Space|PageUp|PageDown|Equal|Minus)/.test(e.code)) {
      this.cancelFlight();
      this.onUserInput();
    }
  };

  // ------------------------------------------------------------------ limits
  clampRange(r: number) { return Math.max(12, Math.min(140000, r)); }
  minPitch() { return -89.5 * DEG; }
  maxPitch() {
    // allow near-horizontal views when close to the ground
    const r = this.goal.range;
    return -(1.5 + 10 * smootherstep((r - 200) / 8000)) * DEG;
  }

  // ------------------------------------------------------------------ camera math
  private placeCamera(v: View) {
    const cp = Math.cos(v.pitch), sp = Math.sin(v.pitch);
    const fx = Math.sin(v.heading) * cp, fy = sp, fz = -Math.cos(v.heading) * cp;
    let px = v.x - fx * v.range, py = v.y - fy * v.range, pz = v.z - fz * v.range;
    const floor = Math.max(this.heightAt(px, pz), this.obstacleAt(px, pz)) + 3;
    if (py < floor) py = floor;
    this.camera.position.set(px, py, pz);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(px + fx, py + fy, pz + fz);
    this.camera.updateMatrixWorld();
  }
  applyGoalToCamera() { this.placeCamera(this.goal); }
  applyCurrentToCamera() { this.placeCamera(this.view); }

  setView(v: Partial<View>, immediate = false) {
    Object.assign(this.goal, v);
    if (v.y === undefined && (v.x !== undefined || v.z !== undefined)) this.goal.y = this.heightAt(this.goal.x, this.goal.z);
    if (immediate) Object.assign(this.view, this.goal);
  }

  // ------------------------------------------------------------------ fly-to (van Wijk & Nuij 2003)
  flyTo(to: View, opts: { duration?: number; done?: () => void } = {}) {
    if (this.mode === 'walk') this.exitWalk(false);
    const from = { ...this.view };
    to = { ...to, heading: from.heading + wrapAngle(to.heading - from.heading) };
    const rho = 1.42;
    const u0: [number, number] = [from.x, from.z], u1: [number, number] = [to.x, to.z];
    const w0 = from.range, w1 = to.range;
    const d = Math.hypot(u1[0] - u0[0], u1[1] - u0[1]);
    let S: number, r0 = 0;
    if (d < 1) {
      S = Math.abs(Math.log(w1 / w0)) / rho;
    } else {
      const b0 = (w1 * w1 - w0 * w0 + rho ** 4 * d * d) / (2 * w0 * rho * rho * d);
      const b1 = (w1 * w1 - w0 * w0 - rho ** 4 * d * d) / (2 * w1 * rho * rho * d);
      r0 = Math.log(-b0 + Math.sqrt(b0 * b0 + 1));
      const r1 = Math.log(-b1 + Math.sqrt(b1 * b1 + 1));
      S = (r1 - r0) / rho;
    }
    const dur = opts.duration ?? Math.max(1.6, Math.min(9, 1.2 + S * 0.9));
    this.flight = { t: 0, dur, from, to, S, u0, u1, w0, w1, r0, d, rho, done: opts.done };
    this.goal = { ...to };
  }

  private stepFlight(dt: number) {
    const f = this.flight!;
    f.t += dt;
    const a = Math.min(1, f.t / f.dur);
    const e = smootherstep(a);
    const s = e * f.S;
    let x: number, z: number, w: number;
    if (f.d < 1) {
      x = f.u0[0] + (f.u1[0] - f.u0[0]) * e;
      z = f.u0[1] + (f.u1[1] - f.u0[1]) * e;
      w = f.w0 * Math.exp(Math.log(f.w1 / f.w0) * e);
    } else {
      const k = (f.w0 / (f.rho * f.rho)) * (Math.cosh(f.r0) * Math.tanh(f.rho * s + f.r0) - Math.sinh(f.r0)) / f.d;
      x = f.u0[0] + (f.u1[0] - f.u0[0]) * k;
      z = f.u0[1] + (f.u1[1] - f.u0[1]) * k;
      w = (f.w0 * Math.cosh(f.r0)) / Math.cosh(f.rho * s + f.r0);
    }
    const v = this.view;
    v.x = x; v.z = z; v.range = w;
    v.y = f.from.y + (f.to.y - f.from.y) * e;
    // heading & pitch: ease, with a slightly more top-down pitch at the apex of long flights
    v.heading = f.from.heading + (f.to.heading - f.from.heading) * smootherstep(Math.min(1, a * 1.15));
    const apex = Math.sin(Math.PI * a) * Math.min(1, f.S / 3);
    const basePitch = f.from.pitch + (f.to.pitch - f.from.pitch) * e;
    v.pitch = basePitch + (-62 * DEG - basePitch) * apex * 0.45;
    if (a >= 1) {
      const done = f.done;
      this.flight = null;
      Object.assign(this.goal, f.to);
      Object.assign(this.view, f.to);
      done?.();
    }
  }

  // ------------------------------------------------------------------ walk mode
  enterWalk(x: number, z: number, yaw: number) {
    this.mode = 'walk';
    this.walk.x = x; this.walk.z = z; this.walk.y = this.heightAt(x, z) + 1.7;
    this.walk.yaw = this.walkGoal.yaw = yaw;
    this.walk.pitch = this.walkGoal.pitch = 4 * DEG;
  }
  exitWalk(animate = true) {
    if (this.mode !== 'walk') return;
    this.mode = 'orbit';
    const h = this.heightAt(this.walk.x, this.walk.z);
    const back: View = {
      x: this.walk.x + Math.sin(this.walk.yaw) * 150, z: this.walk.z - Math.cos(this.walk.yaw) * 150, y: h,
      range: 520, heading: this.walk.yaw, pitch: -24 * DEG,
    };
    // start the orbit view where the walker currently stands
    Object.assign(this.view, { x: this.walk.x + Math.sin(this.walk.yaw) * 20, z: this.walk.z - Math.cos(this.walk.yaw) * 20, y: h, range: 20, heading: this.walk.yaw, pitch: -5 * DEG });
    Object.assign(this.goal, this.view);
    if (animate) this.flyTo(back, { duration: 2.2 });
  }

  // ------------------------------------------------------------------ update
  update(dt: number) {
    dt = Math.min(dt, 0.1);
    if (this.mode === 'walk') { this.updateWalk(dt); return; }
    if (this.flight) {
      this.stepFlight(dt);
      this.placeCamera(this.view);
      return;
    }
    // keyboard navigation (orbit)
    const g = this.goal;
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1;
    const sp = g.range * 0.9 * dt * fast;
    const fx = Math.sin(g.heading), fz = -Math.cos(g.heading);
    let mx = 0, mz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) { mx += fx; mz += fz; }
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) { mx -= fx; mz -= fz; }
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) { mx += fz; mz -= fx; }
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) { mx -= fz; mz += fx; }
    g.x += mx * sp; g.z += mz * sp;
    if (this.keys.has('KeyQ')) g.heading -= 1.1 * dt;
    if (this.keys.has('KeyE')) g.heading += 1.1 * dt;
    if (this.keys.has('KeyR')) g.pitch = Math.min(this.maxPitch(), g.pitch + 0.8 * dt);
    if (this.keys.has('KeyF')) g.pitch = Math.max(this.minPitch(), g.pitch - 0.8 * dt);
    if (this.keys.has('Equal') || this.keys.has('PageUp')) g.range = this.clampRange(g.range * Math.exp(-1.6 * dt));
    if (this.keys.has('Minus') || this.keys.has('PageDown')) g.range = this.clampRange(g.range * Math.exp(1.6 * dt));
    // keep goal on the ground & inside the world
    g.x = Math.max(-120000, Math.min(120000, g.x));
    g.z = Math.max(-120000, Math.min(120000, g.z));
    g.y = this.heightAt(g.x, g.z);
    g.pitch = Math.max(this.minPitch(), Math.min(this.maxPitch(), g.pitch));
    // smooth
    const v = this.view;
    v.x = damp(v.x, g.x, 0.09, dt);
    v.z = damp(v.z, g.z, 0.09, dt);
    v.y = damp(v.y, g.y, 0.25, dt);
    v.range = Math.exp(damp(Math.log(v.range), Math.log(g.range), 0.11, dt));
    v.heading = damp(v.heading, g.heading, 0.1, dt);
    v.pitch = damp(v.pitch, g.pitch, 0.1, dt);
    this.placeCamera(v);
  }

  private updateWalk(dt: number) {
    const w = this.walk;
    w.yaw = damp(w.yaw, this.walkGoal.yaw, 0.06, dt);
    w.pitch = damp(w.pitch, this.walkGoal.pitch, 0.06, dt);
    const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = run ? 22 : 6;
    const fx = Math.sin(w.yaw), fz = -Math.cos(w.yaw);
    let mx = 0, mz = 0, my = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) { mx += fx; mz += fz; }
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) { mx -= fx; mz -= fz; }
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) { mx += fz; mz -= fx; }
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) { mx -= fz; mz += fx; }
    if (this.keys.has('KeyE') || this.keys.has('Space')) my += 1;
    if (this.keys.has('KeyQ')) my -= 1;
    const l = Math.hypot(mx, mz) || 1;
    w.vx = damp(w.vx, (mx / l) * speed, 0.18, dt);
    w.vz = damp(w.vz, (mz / l) * speed, 0.18, dt);
    w.vy = damp(w.vy, my * speed * 0.8, 0.2, dt);
    w.x += w.vx * dt; w.z += w.vz * dt;
    const ground = this.heightAt(w.x, w.z) + 1.7;
    w.y = Math.max(ground, w.y + w.vy * dt);
    if (my === 0 && w.y - ground < 3) w.y = damp(w.y, ground, 0.15, dt);
    // subtle walking bob
    const moving = Math.hypot(w.vx, w.vz);
    const bob = w.y - ground < 0.5 ? Math.sin(performance.now() * 0.0105) * 0.025 * Math.min(1, moving / 5) : 0;
    const cp = Math.cos(w.pitch);
    this.camera.position.set(w.x, w.y + bob, w.z);
    this.camera.lookAt(w.x + fx * cp, w.y + bob + Math.sin(w.pitch), w.z + fz * cp);
    this.camera.updateMatrixWorld();
    if (this.keys.has('Escape')) this.exitWalk();
  }

  /** Altitude of the camera above the terrain (m). */
  altitude() { return this.camera.position.y - this.heightAt(this.camera.position.x, this.camera.position.z); }
}
