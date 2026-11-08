import './ui/styles.css';
import { App } from './App';
import * as THREE from 'three';
if (new URLSearchParams(location.search).has('debugnan')) {
  const orig = THREE.BufferGeometry.prototype.computeBoundingSphere;
  THREE.BufferGeometry.prototype.computeBoundingSphere = function (this: THREE.BufferGeometry) {
    orig.call(this);
    if (this.boundingSphere && Number.isNaN(this.boundingSphere.radius)) console.warn('NaN geometry attrs=' + Object.keys(this.attributes).join(',') + ' n=' + this.getAttribute('position').count + ' ' + new Error().stack?.split('\n').slice(2, 5).join(' | '));
  };
}
import { UI } from './ui/UI';
import { INTRO_TARGET, PLACES } from './data/places';
import { llToWorld } from './core/geo';
import { sgNow } from './core/astro';

const DEG = Math.PI / 180;
const params = new URLSearchParams(location.search);
const canvas = document.getElementById('world') as HTMLCanvasElement;

// ---------------------------------------------------------------- loader
const loader = document.createElement('div');
loader.id = 'loader';
loader.innerHTML = `<div class="inner">
  <div class="title">Singapore</div>
  <div class="scripts">新加坡 · Singapura · சிங்கப்பூர்</div>
  <div class="bar"><i></i></div>
  <div class="status" aria-live="polite"></div>
</div>`;
document.body.append(loader);
const bar = loader.querySelector('.bar i') as HTMLElement;
const status = loader.querySelector('.status') as HTMLElement;

function fail(msg: string) {
  status.innerHTML = `<div class="error">${msg}</div>`;
}

async function boot() {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) {
    fail('This reconstruction needs WebGL 2. Try a recent version of Chrome, Edge, Firefox or Safari, with hardware acceleration enabled.');
    return;
  }
  const app = new App(canvas);
  (window as unknown as { app: App }).app = app;
  try {
    await app.load((f, label) => {
      bar.style.width = `${Math.round(f * 100)}%`;
      status.textContent = label;
    });
  } catch (e) {
    console.error(e);
    fail('The map data could not be loaded. Check your connection and reload the page.');
    return;
  }
  const ui = new UI(app);
  await ui.init();
  app.addFrameHook(() => ui.update());

  // ---------------------------------------------------------------- capture mode (automated screenshots)
  const v = params.get('view');
  const hour = params.get('hour');
  if (params.get('frames')) {
    if (hour) app.time.setHour(parseFloat(hour));
    if (v) {
      const [x, z, range, heading, pitch] = v.split(',').map(Number);
      app.controller.setView({ x, z, range, heading: heading * DEG, pitch: pitch * DEG }, true);
    }
    loader.remove();
    if (params.get('ui')) ui.show();
    await app.settle(90000);
    if (params.has('night0')) { const { U } = await import('./core/uniforms'); U.uNight.value = 0; }
    for (let i = 0; i < Number(params.get('frames')); i++) app.frame();
    if (params.has('debugatmo')) {
      const rt = (app.atmosphere as unknown as { params: import('three').WebGLRenderTarget }).params;
      const buf = new Float32Array(8 * 4);
      app.renderer.readRenderTargetPixels(rt, 0, 0, 8, 1, buf);
      console.log('atmo params', Array.from(buf).map((v) => v.toExponential(2)).join(' '), 'sunDir', JSON.stringify(app.time.sunEl));
      const sv = (app.atmosphere as unknown as { skyView: import('three').WebGLRenderTarget }).skyView;
      const px = new Float32Array(4);
      const rows: string[] = [];
      for (const [x, y] of [[0, 54], [0, 50], [0, 30], [96, 54], [191, 54], [191, 30], [0, 70], [191, 70]]) {
        app.renderer.readRenderTargetPixels(sv, x, y, 1, 1, px);
        rows.push(`(${x},${y})=${px[0].toExponential(2)},${px[1].toExponential(2)},${px[2].toExponential(2)}`);
      }
      console.log('skyview', rows.join(' '));
    }
    (window as unknown as { __stats: unknown }).__stats = app.tiles.stats;
    (window as unknown as { __ready: boolean }).__ready = true;
    return;
  }

  // deep links: #marina-bay etc.
  const hash = location.hash.replace('#', '');
  const linked = PLACES.find((p) => p.id === hash);
  const skipIntro = params.has('nointro') || !!linked || !!v;

  // ---------------------------------------------------------------- intro
  const [tx, tz] = llToWorld(INTRO_TARGET.lon, INTRO_TARGET.lat);
  const end = { x: tx, z: tz, y: app.controller.heightAt(tx, tz), range: INTRO_TARGET.range, heading: INTRO_TARGET.heading * DEG, pitch: INTRO_TARGET.pitch * DEG };
  const titles = document.createElement('div');
  titles.id = 'titles';
  titles.innerHTML = '<div><div class="big">Singapore</div><div class="sub">1°17′N · 103°51′E</div></div>';
  const skip = document.createElement('button');
  skip.id = 'skip';
  skip.textContent = 'Skip';
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    titles.remove();
    skip.remove();
    app.time.rate = 0;
    ui.show();
    if (linked) ui.goPlace(linked);
  };

  if (skipIntro) {
    if (v) {
      const [x, z, range, heading, pitch] = v.split(',').map(Number);
      app.controller.setView({ x, z, range, heading: heading * DEG, pitch: pitch * DEG }, true);
    } else {
      app.controller.setView(end, true);
    }
    if (hour) app.time.setHour(parseFloat(hour)); else app.time.setHour(7.6);
    app.start();
    loader.classList.add('done');
    setTimeout(() => loader.remove(), 1800);
    finish();
    return;
  }

  // start pre-dawn, high over the Singapore Strait looking north at the city
  const now = sgNow();
  void now;
  app.time.setHour(6.55);
  app.controller.setView({ x: tx + 2600, z: tz + 9000, range: 15000, heading: -12 * DEG, pitch: -11 * DEG }, true);
  app.controller.view.y = 0;
  app.start();
  document.body.append(titles, skip);
  const big = titles.querySelector('.big') as HTMLElement;
  const sub = titles.querySelector('.sub') as HTMLElement;
  loader.classList.add('done');
  setTimeout(() => loader.remove(), 1800);
  setTimeout(() => big.classList.add('on'), 600);
  setTimeout(() => sub.classList.add('on'), 2600);
  setTimeout(() => { big.classList.remove('on'); sub.classList.remove('on'); }, 7400);
  // the sun rises during the descent
  app.time.rate = 0.75 / 16;
  setTimeout(() => {
    app.controller.flyTo(end, { duration: 15, done: () => { app.time.rate = 0; setTimeout(finish, 400); } });
  }, 900);
  const userSkip = () => {
    if (finished) return;
    app.controller.flight = null;
    app.controller.setView(end, true);
    app.time.setHour(7.6);
    finish();
  };
  skip.addEventListener('click', userSkip);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === ' ') userSkip(); }, { once: true });
  ui.onFirstInteraction = () => { if (!finished) userSkip(); };
}

boot();
