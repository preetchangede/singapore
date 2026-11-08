import * as THREE from 'three';
import { U } from './core/uniforms';
import { Post } from './core/Post';
import { CameraController, View } from './core/CameraController';
import { TimeOfDay } from './core/TimeOfDay';
import { Atmosphere } from './world/Atmosphere';
import { Terrain } from './world/Terrain';
import { Ocean } from './world/Ocean';
import { Sky } from './world/Sky';
import { TileManager } from './streaming/TileManager';
import { Clipmap } from './world/Clipmap';
import { buildingUniforms, makeShadowMaterial } from './world/Buildings';
import { Shadows } from './world/Shadows';
import { Trees } from './world/Trees';
import { Reflection } from './world/Reflection';
import { Landmarks } from './world/Landmarks';
import { Clouds } from './world/Clouds';
import { Traffic } from './world/Traffic';
import { Ships } from './world/Ships';
import { Tier, detectTier, Governor } from './core/Quality';
import {
  Manifest, loadManifest, fetchGz, decodeHeights, heightTexture, byteTexture, loadImageTexture, HeightField,
} from './data/assets';

export interface LoadProgress { (fraction: number, label: string): void }

export class App {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controller: CameraController;
  time = new TimeOfDay();
  post: Post;
  atmosphere: Atmosphere;
  terrain!: Terrain;
  ocean!: Ocean;
  sky!: Sky;
  tiles!: TileManager;
  clipmap!: Clipmap;
  shadows!: Shadows;
  trees!: Trees;
  reflection: Reflection;
  landmarks!: Landmarks;
  clouds!: Clouds;
  traffic!: Traffic;
  ships!: Ships;
  private shadowMat = makeShadowMaterial();
  manifest!: Manifest;
  heights!: HeightField;
  hdr!: THREE.WebGLRenderTarget;
  pixelRatio = 1;
  renderScale = 1;
  private clock = new THREE.Clock();
  private frameHooks: ((dt: number) => void)[] = [];
  private beforeRender: ((dt: number) => void)[] = [];
  fps = 60;
  tier: Tier;
  governor: Governor;
  private frameTimes: number[] = [];
  running = false;

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false, depth: true,
      powerPreference: 'high-performance', reversedDepthBuffer: true, preserveDrawingBuffer: false,
    });
    this.renderer.autoClear = true;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x000000, 1);
    this.tier = detectTier(this.renderer);
    this.renderScale = this.tier.scale;
    this.governor = new Governor(this.tier, (s) => this.setRenderScale(s));
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 2.0e6);
    this.controller = new CameraController(this.camera, canvas);
    this.post = new Post(this.renderer);
    this.atmosphere = new Atmosphere(this.renderer);
    this.reflection = new Reflection(this.renderer);
    this.reflection.enabled = this.tier.reflection > 0;
    this.reflection.scale = this.tier.reflection || 0.5;
    this.atmosphere.setHaze(2.4, 1.6);
    this.atmosphere.bake();
    U.uShadowOn.value = 0;
    window.addEventListener('resize', () => this.resize());
  }

  get reversedDepth() { return this.renderer.capabilities.reversedDepthBuffer; }

  async load(progress: LoadProgress) {
    progress(0.02, 'Reading the map');
    this.manifest = await loadManifest();
    const m = this.manifest;
    const parts: { w: number; done: number }[] = [];
    const track = (w: number) => {
      const p = { w, done: 0 };
      parts.push(p);
      return (l: number, t: number) => {
        p.done = t ? l / t : 0;
        const tot = parts.reduce((s, x) => s + x.w, 0);
        const d = parts.reduce((s, x) => s + x.w * Math.min(1, x.done), 0);
        progress(0.05 + 0.85 * (d / Math.max(tot, 1)), 'Raising the island');
      };
    };
    const [near, far, coast, canopy, overview] = await Promise.all([
      fetchGz(m.terrain.near.file, track(2.5)),
      fetchGz(m.terrain.far.file, track(2.2)),
      fetchGz(m.terrain.coast.file, track(1.7)),
      fetchGz(m.terrain.canopy.file, track(3.7)),
      loadImageTexture(m.ground.overview),
    ]);
    progress(0.92, 'Painting the ground');
    const hn = decodeHeights(near, m.terrain.near.size, m.terrain.near.enc[0], m.terrain.near.enc[1]);
    const hf = decodeHeights(far, m.terrain.far.size, m.terrain.far.enc[0], m.terrain.far.enc[1]);
    this.heights = new HeightField(hn, m.terrain.near.size, m.terrain.near.half);
    const farField = new HeightField(hf, m.terrain.far.size, m.terrain.far.half);
    U.tHeightNear.value = heightTexture(hn, m.terrain.near.size);
    U.tHeightFar.value = heightTexture(hf, m.terrain.far.size);
    U.tCoast.value = byteTexture(coast, m.terrain.coast.size);
    U.tCanopy.value = byteTexture(canopy, m.terrain.canopy.size);
    U.tOverview.value = overview;
    U.uDomainHalf.value = m.terrain.near.half;
    U.uFarHalf.value = m.terrain.far.half;
    U.uCoastMaxD.value = m.terrain.coast.maxd;
    // placeholders until the clipmap / night lights exist
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    black.needsUpdate = true;
    for (const k of ['tClip0', 'tClip1', 'tClip2', 'tClipM0', 'tClipM1', 'tClipM2', 'tReflection', 'tNightLights', 'tShadow'] as const) {
      if (!U[k].value) U[k].value = black;
    }
    U.uShadowReversed.value = this.reversedDepth ? 1 : 0;
    // height lookup for the camera (world x,z -> pipeline x,y)
    const half = m.terrain.near.half;
    this.controller.heightAt = (x, z) => {
      const inside = Math.abs(x) < half && Math.abs(z) < half;
      const h = inside ? this.heights.sample(x, -z) : farField.sample(x, -z);
      return Math.max(h, 0);
    };
    this.sky = new Sky();
    this.terrain = new Terrain();
    this.ocean = new Ocean();
    this.scene.add(this.sky.mesh, this.terrain.mesh, this.ocean.mesh);
    this.tiles = new TileManager(m, hn);
    this.scene.add(this.tiles.group);
    this.tiles.detailRadius = this.tier.detailRadius;
    this.clipmap = new Clipmap(this.renderer, this.tier.clipRes);
    this.tiles.onGround = (t) => this.clipmap.addTile(t);
    this.shadows = new Shadows(this.renderer, Math.max(this.tier.shadowSize, 512));
    this.shadows.enabled = this.tier.shadowSize > 0;
    this.trees = new Trees();
    this.trees.density = this.tier.treeDensity;
    this.trees.range = this.tier.treeRange;
    this.scene.add(this.trees.group);
    U.uTreeRange.value = this.trees.range;
    this.traffic = new Traffic();
    this.traffic.density = this.tier.name === 'low' ? 0.5 : 1;
    this.traffic.range = this.tier.name === 'low' ? 800 : 1300;
    this.scene.add(this.traffic.group);
    this.tiles.onDetail = (t) => {
      this.shadows.version++;
      if (t.trees) this.trees.addTile(t.key, t.trees, t.ox, t.oy);
      this.traffic.addTile(t.key, t.traffic, t.ox, t.oy);
    };
    this.tiles.onDetailRemoved = (t) => {
      this.shadows.version++;
      this.trees.removeTile(t.key);
      this.traffic.removeTile(t.key);
    };
    this.shadowHooks.push((on) => this.trees.setDepthMode(on));
    this.clouds = new Clouds(this.renderer);
    this.clouds.scale = this.tier.name === 'low' ? 0.25 : this.tier.name === 'ultra' ? 0.45 : 0.33;
    this.clouds.steps = this.tier.name === 'low' ? 28 : this.tier.name === 'medium' ? 40 : 56;
    this.landmarks = new Landmarks((x, z) => this.controller.heightAt(x, z));
    await this.landmarks.load();
    this.scene.add(this.landmarks.group);
    this.shadowHooks.push((on) => this.landmarks.setDepthMode(on));
    this.ships = new Ships();
    await this.ships.load().catch((e) => console.warn('ships unavailable', e));
    this.scene.add(this.ships.group);
    this.shadowHooks.push((on) => this.ships.setDepthMode(on));
    this.tiles.onGroundRemoved = (t) => this.clipmap.removeTile(t);
    progress(0.94, 'Raising the skyline');
    await this.tiles.loadOverview((f) => progress(0.94 + 0.05 * f, 'Raising the skyline'));
    // night lights (far-field city glow): not needed for the first frame
    loadImageTexture('ground/lights.jpg').then((t) => { t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; U.tNightLights.value = t; }).catch(() => {});
    // compile shaders up-front so the intro doesn't stutter
    this.resize();
    this.clouds.setSize(this.hdr.width, this.hdr.height);
    progress(0.97, 'Warming up');
    this.time.update(0);
    this.atmosphere.update(500);
    this.terrain.update(this.camera);
    this.renderer.compile(this.scene, this.camera);
    progress(1, 'Ready');
  }

  addFrameHook(f: (dt: number) => void) { this.frameHooks.push(f); }
  addBeforeRender(f: (dt: number) => void) { this.beforeRender.push(f); }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.tier.dprCap);
    this.renderer.setPixelRatio(this.pixelRatio * this.renderScale);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const bw = Math.max(1, Math.round(w * this.pixelRatio * this.renderScale));
    const bh = Math.max(1, Math.round(h * this.pixelRatio * this.renderScale));
    if (this.hdr) this.hdr.dispose();
    const depth = new THREE.DepthTexture(bw, bh, THREE.FloatType);
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    this.hdr = new THREE.WebGLRenderTarget(bw, bh, {
      type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, samples: this.tier.msaa,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthTexture: depth,
    });
    this.clouds?.setSize(bw, bh);
    this.post.setSize(bw, bh);
    this.post.final.uniforms.uFxaa.value = this.tier.msaa > 0 ? 0 : 1;
    this.reflection.setSize(bw, bh);
    U.uResolution.value.set(bw, bh);
  }

  setRenderScale(s: number) {
    if (Math.abs(s - this.renderScale) < 0.02) return;
    this.renderScale = s;
    this.resize();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      this.frame();
    };
    requestAnimationFrame(loop);
  }

  frame(render = true) {
    const raw = this.clock.getDelta();
    const dt = Math.min(raw, 0.1);
    U.uTime.value += dt;
    if (this.running && document.visibilityState === 'visible') this.governor.frame(raw);
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    this.fps = this.frameTimes.length / this.frameTimes.reduce((a, b) => a + b, 0);
    this.time.update(dt);
    // light inter-monsoon breeze moving the cloud field
    U.uCloudWind.value.x += dt * 4.0;
    U.uCloudWind.value.y += dt * 1.6;
    this.controller.update(dt);
    for (const f of this.frameHooks) f(dt);
    // near plane adapts to altitude for depth precision on non-reversed-Z devices
    const alt = Math.max(1, this.controller.altitude());
    this.camera.near = this.reversedDepth ? 0.5 : Math.min(Math.max(0.5, alt * 0.02), 50);
    this.camera.far = 2.0e6;
    this.camera.updateProjectionMatrix();
    this.atmosphere.update(this.camera.position.y);
    this.sky.update(this.camera);
    this.terrain.update(this.camera);
    this.tiles.update(this.camera, alt);
    this.trees.update(this.camera);
    this.traffic.update(U.uTime.value, this.camera, this.time.hour);
    buildingUniforms.uHour.value = this.time.hour;
    this.landmarks.update(U.uTime.value, this.time.hour);
    const epochHours = Date.UTC(this.time.year, this.time.month - 1, this.time.day) / 3.6e6 + this.time.hour;
    this.ships.update(U.uTime.value, epochHours, this.time.hour,
      this.hdr.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)),
      this.camera, this.tier.name === 'low' ? 30000 : 60000);
    if (!render) return;
    this.clipmap.update(this.camera, alt, performance.now());
    this.shadows.update(this.camera, alt, [], this.scene, (on) => this.swapShadow(on));
    if (alt < 3500) {
      this.reflection.render(this.scene, this.camera, [this.ocean.mesh, this.tiles.water.group],
        (c) => this.sky.update(c), () => this.sky.update(this.camera));
    } else {
      U.uReflectionOn.value = 0;
    }
    for (const f of this.beforeRender) f(dt);
    this.renderer.setRenderTarget(this.hdr);
    this.renderer.render(this.scene, this.camera);
    this.clouds.render(this.camera, this.hdr.depthTexture!, this.hdr, this.reversedDepth);
    this.post.render(this.hdr.texture);
  }

  flyTo(v: View, done?: () => void) { this.controller.flyTo(v, { done }); }

  /** Shadow pass: hide receivers-only, swap casters to depth materials. */
  private swapShadow(on: boolean) {
    for (const o of [this.sky.mesh, this.terrain.mesh, this.ocean.mesh, this.tiles.water.group]) o.visible = !on;
    this.tiles.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.parent === this.tiles.water.group) return;
      if (on) {
        m.userData.mat = m.material;
        if (m.userData.kind === 'overview') {
          if (!m.userData.shadowMat) m.userData.shadowMat = makeShadowMaterial((m.material as THREE.ShaderMaterial).uniforms.uHideMask);
          m.material = m.userData.shadowMat;
        } else {
          m.material = this.shadowMat;
        }
      } else if (m.userData.mat) {
        m.material = m.userData.mat;
      }
    });
    for (const f of this.shadowHooks) f(on);
  }
  shadowHooks: ((on: boolean) => void)[] = [];

  /** Render until streaming has settled (used for deterministic captures). */
  async settle(maxMs = 60000) {
    const t0 = performance.now();
    let calm = 0;
    while (performance.now() - t0 < maxMs) {
      this.frame(false);
      const s = this.tiles.stats;
      await new Promise((r) => setTimeout(r, 40));
      if (s.inflight === 0 && (this.tiles as any).queue.length === 0) calm++; else calm = 0;
      if (calm >= 4) break;
    }
    this.frame();
  }
}
