import * as THREE from 'three';
import type { App } from '../App';
import { PLACES, Place } from '../data/places';
import { DATA_BASE, fetchGz } from '../data/assets';
import { llToWorld, worldToLl, formatLatLon, E0, N0 } from '../core/geo';
import { ephemeris, sgDate } from '../core/astro';
import { BUILDING_CLASSES } from '../data/schema.gen';
import type { DetailTile } from '../streaming/TileManager';

const DEG = Math.PI / 180;

const ICONS = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  tour: '<svg viewBox="0 0 24 24"><path d="M5 19c3-1 4-4 7-5s5-3 6-8"/><circle cx="18" cy="6" r="1.6"/><circle cx="5" cy="19" r="1.6"/></svg>',
  street: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><path d="M12 8v6l-3 6M12 14l3 6M8 11h8"/></svg>',
  labels: '<svg viewBox="0 0 24 24"><path d="M4 18l4.5-12L13 18M5.7 14h5.6M15 18v-6.5a2.5 2.5 0 015 0V18M15 14.5h5"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 014.8 1c0 1.8-2.4 2.2-2.4 3.8M12 17.2v.1"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 6v12l10-6z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 6v12M16 6v12"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

interface Region { name: string; area: string; rings: number[][][]; bbox: number[] }

function pointInRings(x: number, y: number, rings: number[][][]) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

type SearchEntry = [string, string, number, number, number, number];

export class UI {
  root = document.body;
  private ident!: HTMLElement;
  private where!: HTMLElement;
  private readout!: HTMLElement;
  private needle!: HTMLElement;
  private card!: HTMLElement;
  private panel!: HTMLElement;
  private input!: HTMLInputElement;
  private results!: HTMLElement;
  private help!: HTMLElement;
  private timeLabel!: HTMLElement;
  private timeHandle!: HTMLElement;
  private timeCanvas!: HTMLCanvasElement;
  private playBtn!: HTMLButtonElement;
  private liveBtn!: HTMLButtonElement;
  private streetExit!: HTMLElement;
  private labelsLayer!: HTMLElement;
  private groups: HTMLElement[] = [];
  private subzones: Region[] = [];
  private areas: { name: string; x: number; y: number; area: number }[] = [];
  private places: { name: string; type: string; x: number; y: number; imp: number }[] = [];
  private search: SearchEntry[] | null = null;
  private lastWhere = 0;
  private labelPool: HTMLElement[] = [];
  labelsOn = true;
  private cardTimer = 0;
  private touring = false;
  private tourIndex = 0;
  private tourTimer: number | null = null;
  private down = { x: 0, y: 0, t: 0 };
  private activeIdx = 0;
  private gradientDay = '';
  onFirstInteraction: () => void = () => {};

  constructor(private app: App) {}

  async init() {
    this.build();
    try {
      const res = await fetch(DATA_BASE + 'labels.json');
      const L = await res.json();
      this.subzones = L.subzones.map((s: { name: string; area_name: string; rings: number[][][] }) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const r of s.rings) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        return { name: s.name, area: s.area_name, rings: s.rings, bbox: [x0, y0, x1, y1] };
      });
      this.areas = L.planningAreas.map((a: { name: string; x: number; y: number; area: number }) => ({ name: a.name, x: a.x, y: a.y, area: a.area }));
      this.places = L.places;
    } catch { /* labels are optional */ }
  }

  private build() {
    // identity
    this.ident = el('div', { id: 'ident', class: 'ui hidden' });
    this.ident.innerHTML = '<div class="word">Singapore</div><div class="where"><span class="dot"></span><span class="txt"></span></div>';
    this.where = this.ident.querySelector('.txt') as HTMLElement;
    // instruments
    const inst = el('div', { id: 'instruments', class: 'ui hidden glass' });
    const compass = el('button', { id: 'compass', 'aria-label': 'Face north' }, '<span class="needle"></span>');
    compass.addEventListener('click', () => { this.app.controller.goal.heading = 0; });
    this.needle = compass.querySelector('.needle') as HTMLElement;
    this.readout = el('div', { id: 'readout' });
    inst.append(compass, this.readout);
    // time bar
    const tb = el('div', { id: 'timebar', class: 'ui hidden glass' });
    this.playBtn = el('button', { class: 'iconbtn', 'aria-label': 'Play the day', 'data-tip': 'Play the day' }, ICONS.play);
    this.playBtn.addEventListener('click', () => this.togglePlay());
    const track = el('div', { id: 'time-track', role: 'slider', 'aria-label': 'Time of day', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '24' });
    this.timeCanvas = el('canvas', { width: '480', height: '6' });
    this.timeHandle = el('div', { id: 'time-handle' });
    track.append(this.timeCanvas, this.timeHandle);
    const setFromEvent = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      this.app.time.setHour(f * 24);
      this.app.time.rate = 0;
      this.syncTimeButtons();
    };
    track.addEventListener('pointerdown', (e) => { track.setPointerCapture(e.pointerId); setFromEvent(e); });
    track.addEventListener('pointermove', (e) => { if (track.hasPointerCapture(e.pointerId)) setFromEvent(e); });
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        this.app.time.setHour(this.app.time.hour + (e.key === 'ArrowLeft' ? -0.25 : 0.25));
        e.preventDefault();
      }
    });
    this.timeLabel = el('div', { id: 'time-label' });
    this.liveBtn = el('button', { id: 'time-live', 'aria-pressed': 'false', 'data-tip': 'Follow Singapore time' }, 'Live');
    this.liveBtn.addEventListener('click', () => {
      this.app.time.live = !this.app.time.live;
      this.app.time.rate = 0;
      this.syncTimeButtons();
    });
    tb.append(this.playBtn, track, this.timeLabel, this.liveBtn);
    // actions
    const act = el('div', { id: 'actions', class: 'ui hidden glass' });
    const mk = (icon: string, tip: string, fn: () => void, key: string) => {
      const b = el('button', { class: 'iconbtn', 'aria-label': tip, 'data-tip': `${tip}  ${key}` }, icon);
      b.addEventListener('click', fn);
      act.append(b);
      return b;
    };
    mk(ICONS.search, 'Explore places', () => this.togglePanel(), '/');
    mk(ICONS.tour, 'Cinematic tour', () => this.toggleTour(), 'T');
    mk(ICONS.street, 'Street view', () => this.enterStreet(), 'V');
    const lb = mk(ICONS.labels, 'Labels', () => { this.labelsOn = !this.labelsOn; lb.setAttribute('aria-pressed', String(this.labelsOn)); }, 'L');
    lb.setAttribute('aria-pressed', 'true');
    mk(ICONS.help, 'Controls & sources', () => this.help.classList.toggle('hidden'), '?');
    // card
    this.card = el('div', { id: 'card', class: 'ui glass hidden', role: 'status' });
    // panel (search + places)
    this.panel = el('div', { id: 'panel', class: 'ui glass hidden' });
    const s = el('div', { id: 'search' }, ICONS.search);
    this.input = el('input', { id: 'search-input', type: 'search', placeholder: 'Search places, buildings, streets', autocomplete: 'off', spellcheck: 'false' });
    s.append(this.input, el('kbd', {}, 'esc'));
    this.results = el('div', { id: 'results' });
    this.panel.append(s, this.results);
    this.input.addEventListener('input', () => this.runSearch());
    this.input.addEventListener('keydown', (e) => this.searchKeys(e));
    // help
    this.help = el('div', { id: 'help', class: 'ui glass hidden', role: 'dialog', 'aria-label': 'Controls' });
    const hm = this.app.manifest.heightModel;
    this.help.innerHTML = `<h3>Moving around</h3><dl>
      <dt>Drag</dt><dd>Move across the city</dd>
      <dt>Right-drag / Shift-drag</dt><dd>Turn and tilt</dd>
      <dt>Scroll / pinch</dt><dd>Zoom toward the pointer</dd>
      <dt>W A S D · Q E · R F</dt><dd>Fly, rotate, tilt (Shift to go faster)</dd>
      <dt>Double-click</dt><dd>Drop into street view; Esc to rise again</dd>
      <dt>Click a building</dt><dd>See its name, height and where the data comes from</dd>
      <dt>/  ·  T  ·  L</dt><dd>Search · cinematic tour · labels</dd></dl>
      <div class="src">Reconstructed from open data: ${this.app.manifest.attribution.join(' · ')}.
      Heights missing from OpenStreetMap (about 70% of footprints) are estimated by a model trained on ${hm.n_train.toLocaleString()} buildings with known heights
      (spatial cross-validated median error ${(hm.median_rel * 100).toFixed(1)}%, MAE ${hm.mae.toFixed(1)} m).</div>`;
    this.help.addEventListener('click', () => this.help.classList.add('hidden'));
    // street exit hint
    this.streetExit = el('div', { id: 'street-exit', class: 'ui glass hidden' }, '<span>Street view · W A S D to walk · drag to look</span>');
    const ex = el('button', {}, 'Rise up');
    ex.addEventListener('click', () => this.exitStreet());
    this.streetExit.append(ex);
    // labels
    this.labelsLayer = el('div', { id: 'labels' });
    this.groups = [this.ident, inst, tb, act];
    document.body.append(this.labelsLayer, this.ident, inst, tb, act, this.card, this.panel, this.help, this.streetExit);
    this.bindGlobal();
  }

  show() {
    for (const g of this.groups) g.classList.remove('hidden');
  }

  private bindGlobal() {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t && t.tagName === 'INPUT') return;
      if (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); this.togglePanel(true); }
      else if (e.key === 'Escape') {
        if (!this.panel.classList.contains('hidden')) this.togglePanel(false);
        else if (!this.help.classList.contains('hidden')) this.help.classList.add('hidden');
        else if (this.app.controller.mode === 'walk') this.exitStreet();
        else this.hideCard();
      }
      else if (e.key === '?') this.help.classList.toggle('hidden');
      else if (e.key === 't' || e.key === 'T') this.toggleTour();
      else if (e.key === 'l' || e.key === 'L') this.labelsOn = !this.labelsOn;
      else if (e.key === 'v' || e.key === 'V') { if (this.app.controller.mode === 'walk') this.exitStreet(); else this.enterStreet(); }
    });
    const c = this.app.canvas;
    c.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY, t: performance.now() }; this.stopTour(); this.onFirstInteraction(); });
    c.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5 && performance.now() - this.down.t < 400 && e.button === 0) this.pick(e.clientX, e.clientY);
    });
    c.addEventListener('dblclick', (e) => {
      if (this.app.controller.mode === 'walk') return;
      const p = this.app.controller.groundPoint(e.clientX, e.clientY, this.app.controller.view.y, new THREE.Vector3());
      this.enterStreet(p.x, p.z);
    });
    this.app.controller.onUserInput = () => { this.stopTour(); };
  }

  // ------------------------------------------------------------------ per frame
  update() {
    const cam = this.app.camera;
    const ctl = this.app.controller;
    const p = cam.position;
    const [lon, lat] = worldToLl(p.x, p.z);
    const alt = ctl.altitude();
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const heading = Math.atan2(dir.x, -dir.z);
    this.needle.style.transform = `rotate(${-heading}rad)`;
    const E = Math.round(p.x + E0), N = Math.round(-p.z + N0);
    this.readout.innerHTML = `${formatLatLon(lon, lat)}<br><b>${alt < 1000 ? Math.round(alt) + ' m' : (alt / 1000).toFixed(alt < 10000 ? 2 : 1) + ' km'}</b> above ground · SVY21 ${E.toLocaleString('en-SG')} E ${N.toLocaleString('en-SG')} N`;
    // time
    const t = this.app.time;
    this.timeLabel.textContent = t.label();
    this.timeHandle.style.left = `${(t.hour / 24) * 100}%`;
    const dayKey = `${t.year}-${t.month}-${t.day}`;
    if (dayKey !== this.gradientDay) { this.gradientDay = dayKey; this.paintDay(); }
    // where am I (throttled)
    const now = performance.now();
    if (now - this.lastWhere > 350) {
      this.lastWhere = now;
      const tx = ctl.mode === 'walk' ? p.x : ctl.view.x, tz = ctl.mode === 'walk' ? p.z : ctl.view.z;
      this.where.textContent = this.locate(tx, -tz);
    }
    this.updateLabels();
  }

  locate(x: number, y: number) {
    for (const s of this.subzones) {
      const b = s.bbox;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInRings(x, y, s.rings)) return s.name === s.area ? s.name : `${s.name} · ${s.area}`;
    }
    const [lon, lat] = worldToLl(x, -y);
    if (lat > 1.44) return 'Johor Strait · Johor Bahru';
    if (lat < 1.2) return 'Singapore Strait';
    void lon;
    return 'Singapore';
  }

  private paintDay() {
    const t = this.app.time;
    const ctx = this.timeCanvas.getContext('2d')!;
    const w = this.timeCanvas.width;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 48; i++) {
      const h = (i / 48) * 24;
      const el = ephemeris(sgDate(t.year, t.month, t.day, h)).sunEl;
      let c: string;
      if (el < -10) c = '#141b2c';
      else if (el < -2) c = '#3b3550';
      else if (el < 4) c = '#d88b5f';
      else if (el < 12) c = '#e8c48c';
      else c = '#9ec3e0';
      grad.addColorStop(i / 48, c);
    }
    ctx.clearRect(0, 0, w, 6);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, 6);
  }

  private syncTimeButtons() {
    const t = this.app.time;
    this.liveBtn.setAttribute('aria-pressed', String(t.live));
    this.playBtn.innerHTML = t.rate !== 0 ? ICONS.pause : ICONS.play;
    this.playBtn.setAttribute('aria-label', t.rate !== 0 ? 'Pause' : 'Play the day');
  }

  private togglePlay() {
    const t = this.app.time;
    t.live = false;
    t.rate = t.rate === 0 ? 0.4 : 0;
    this.syncTimeButtons();
  }

  // ------------------------------------------------------------------ labels
  private label(i: number) {
    let n = this.labelPool[i];
    if (!n) { n = el('div', { class: 'lbl' }); this.labelsLayer.append(n); this.labelPool.push(n); }
    return n;
  }

  private updateLabels() {
    const cam = this.app.camera;
    const alt = this.app.controller.altitude();
    const W = window.innerWidth, H = window.innerHeight;
    let used = 0;
    const boxes: number[][] = [];
    const v = new THREE.Vector3();
    const place = (x: number, y: number, text: string, cls: string, minAlt: number, maxAlt: number, lift: number, maxDist: number) => {
      if (alt < minAlt || alt > maxAlt) return;
      const wx = x, wz = -y;
      const gy = this.app.controller.heightAt(wx, wz) + lift;
      v.set(wx, gy, wz);
      const d = v.distanceTo(cam.position);
      if (d > maxDist) return;
      v.project(cam);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return;
      const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
      const wEst = text.length * (cls === 'district' ? 11 : 8) + 20;
      for (const b of boxes) if (Math.abs(b[0] - sx) < (b[2] + wEst) / 2 && Math.abs(b[1] - sy) < 22) return;
      boxes.push([sx, sy, wEst]);
      const n = this.label(used++);
      if (n.textContent !== text) n.textContent = text;
      n.className = `lbl ${cls}`;
      const fade = Math.min(1, (maxDist - d) / (maxDist * 0.3)) * Math.min(1, (alt - minAlt) / Math.max(minAlt * 0.5, 50)) * Math.min(1, (maxAlt - alt) / (maxAlt * 0.25));
      n.style.opacity = String(Math.max(0, Math.min(1, fade)));
      n.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%)`;
    };
    if (this.labelsOn && this.app.controller.mode !== 'walk') {
      // curated landmarks first (most important), then districts and neighbourhoods
      for (const p of PLACES) {
        const [x, z] = llToWorld(p.lon, p.lat);
        place(x, -z, p.name, 'poi', 250, 9000, 30, 9000);
      }
      for (const a of this.areas) place(a.x, a.y, a.name, 'district', 2500, 60000, 0, 60000);
      for (const p of this.places) if (p.imp >= 5 || alt < 2500) place(p.x, p.y, p.name, '', 600, 6000, 0, 7000);
    }
    for (let i = used; i < this.labelPool.length; i++) this.labelPool[i].style.opacity = '0';
  }

  // ------------------------------------------------------------------ cards
  showPlace(p: Place, hold = 9000) {
    this.card.innerHTML = '';
    const close = el('button', { class: 'iconbtn close', 'aria-label': 'Close' }, ICONS.close);
    close.addEventListener('click', () => this.hideCard());
    this.card.append(el('div', { class: 'kind' }, p.kind), el('h2', {}, p.name), el('p', {}, p.text), close);
    this.card.classList.remove('hidden');
    window.clearTimeout(this.cardTimer);
    if (hold > 0) this.cardTimer = window.setTimeout(() => this.hideCard(), hold);
  }

  hideCard() { this.card.classList.add('hidden'); }

  private showBuilding(tile: DetailTile, idx: number) {
    const b = tile.info[idx];
    if (!b) return;
    const cls = BUILDING_CLASSES[b.cls] ?? 'building';
    const kindName: Record<string, string> = {
      hdb: 'HDB public housing', condo: 'Residential', house: 'Landed house', terrace: 'Terrace house', office: 'Office',
      retail: 'Retail', industrial: 'Industrial', warehouse: 'Warehouse', civic: 'Civic', religious: 'Place of worship',
      hospital: 'Hospital', hotel: 'Hotel', parking: 'Car park', shophouse: 'Shophouse', school: 'School', transport: 'Transport',
      sports: 'Sports', generic: 'Building', roof: 'Shelter', construction: 'Under construction', tank: 'Storage tank', greenhouse: 'Greenhouse',
    };
    const src = b.flags & 2 ? 'HDB property records' : b.flags & 128 ? `Estimated (model, ±${this.app.manifest.heightModel.mae.toFixed(0)} m typical)` : 'OpenStreetMap survey';
    const [lon, lat] = worldToLl(b.cx, -b.cy);
    this.card.innerHTML = '';
    const close = el('button', { class: 'iconbtn close', 'aria-label': 'Close' }, ICONS.close);
    close.addEventListener('click', () => this.hideCard());
    const dl = el('dl', { class: 'facts' });
    const row = (k: string, v: string) => { dl.append(el('dt', {}, k), el('dd', {}, v)); };
    row('Height', `${b.h.toFixed(b.h < 20 ? 1 : 0)} m${b.minh > 0 ? ` (from ${b.minh.toFixed(0)} m)` : ''}`);
    if (b.levels) row('Storeys', String(b.levels));
    row('Height source', src);
    row('Location', formatLatLon(lon, lat));
    const title = b.name || (b.addr ? b.addr : kindName[cls] || 'Building');
    this.card.append(el('div', { class: 'kind' }, kindName[cls] || 'Building'), el('h2', {}, escapeHtml(title)));
    if (b.name && b.addr) this.card.append(el('p', {}, escapeHtml(b.addr)));
    this.card.append(dl, close);
    this.card.classList.remove('hidden');
    window.clearTimeout(this.cardTimer);
  }

  private pick(cx: number, cy: number) {
    const meshes: THREE.Object3D[] = [];
    for (const t of this.app.tiles.detail.values()) if (t.buildings) meshes.push(t.buildings);
    if (!meshes.length) return;
    const r = this.app.canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.app.camera);
    const hits = ray.intersectObjects(meshes, false);
    if (!hits.length || hits[0].face == null) { this.hideCard(); return; }
    const h = hits[0];
    const tile = h.object.userData.tile as DetailTile;
    if (!tile || !tile.bid) return;
    this.showBuilding(tile, tile.bid[h.face!.a]);
  }

  // ------------------------------------------------------------------ panel / search
  togglePanel(force?: boolean) {
    const open = force ?? this.panel.classList.contains('hidden');
    this.panel.classList.toggle('hidden', !open);
    if (open) {
      this.input.value = '';
      this.renderPlaces();
      setTimeout(() => this.input.focus(), 30);
      if (!this.search) fetchGz('search.bin').then((b) => { this.search = JSON.parse(new TextDecoder().decode(b)); }).catch(() => {});
    } else {
      this.input.blur();
    }
  }

  private renderPlaces() {
    this.results.innerHTML = '';
    this.results.append(el('div', { class: 'sect' }, 'Places to begin'));
    PLACES.forEach((p) => {
      const b = el('button', {}, `<span class="n">${p.name}</span><span class="t">${p.kind}</span>`);
      b.addEventListener('click', () => { this.togglePanel(false); this.goPlace(p); });
      this.results.append(b);
    });
    this.activeIdx = -1;
  }

  private runSearch() {
    const q = this.input.value.trim().toLowerCase();
    if (!q) { this.renderPlaces(); return; }
    const scored: { s: number; e: SearchEntry | Place; place?: Place }[] = [];
    const score = (name: string, imp: number) => {
      const n = name.toLowerCase();
      if (n === q) return 1000 + imp;
      if (n.startsWith(q)) return 600 + imp * 5 - n.length * 0.5;
      const wi = n.indexOf(' ' + q);
      if (wi >= 0) return 400 + imp * 5 - n.length * 0.5;
      if (n.includes(q)) return 200 + imp * 5 - n.length * 0.5;
      return -1;
    };
    for (const p of PLACES) { const s = score(p.name, 9); if (s >= 0) scored.push({ s: s + 50, e: p, place: p }); }
    for (const e of this.search || []) { const s = score(e[0], e[4]); if (s >= 0) scored.push({ s, e }); }
    scored.sort((a, b) => b.s - a.s);
    this.results.innerHTML = '';
    const seen = new Set<string>();
    let n = 0;
    for (const r of scored) {
      const key = r.place ? 'p:' + r.place.id : `${(r.e as SearchEntry)[0]}|${(r.e as SearchEntry)[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = r.place ? r.place.name : (r.e as SearchEntry)[0];
      const type = r.place ? r.place.kind : prettyType((r.e as SearchEntry)[1]);
      const b = el('button', {}, `<span class="n">${escapeHtml(name)}</span><span class="t">${escapeHtml(type)}</span>`);
      b.addEventListener('click', () => { this.togglePanel(false); if (r.place) this.goPlace(r.place); else this.goEntry(r.e as SearchEntry); });
      this.results.append(b);
      if (++n >= 14) break;
    }
    if (!n) this.results.append(el('div', { class: 'empty' }, this.search ? 'No match on the island. Try a street, an MRT station or a neighbourhood.' : 'Loading the index…'));
    this.activeIdx = -1;
  }

  private searchKeys(e: KeyboardEvent) {
    const items = [...this.results.querySelectorAll('button')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.activeIdx = Math.max(0, Math.min(items.length - 1, this.activeIdx + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((b, i) => b.classList.toggle('active', i === this.activeIdx));
      items[this.activeIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      (items[Math.max(0, this.activeIdx)] as HTMLButtonElement | undefined)?.click();
    } else if (e.key === 'Escape') {
      this.togglePanel(false);
    }
  }

  goPlace(p: Place, hold = 9000) {
    const [x, z] = llToWorld(p.lon, p.lat);
    if (this.app.controller.mode === 'walk') this.app.controller.exitWalk(false);
    this.app.controller.flyTo({ x, z, y: this.app.controller.heightAt(x, z), range: p.range, heading: p.heading * DEG, pitch: p.pitch * DEG }, {
      done: () => this.showPlace(p, hold),
    });
    this.hideCard();
  }

  private goEntry(e: SearchEntry) {
    const [name, type, x, y, , h] = e;
    const range: Record<string, number> = { district: 4500, neighbourhood: 1600, suburb: 2500, place: 3000, island: 3500, road: 900, building: Math.max(350, h * 3.2), station_mrt: 600, station_lrt: 600, park: 1200, water: 1800, airport: 5000 };
    const wx = x, wz = -y;
    this.app.controller.flyTo({ x: wx, z: wz, y: this.app.controller.heightAt(wx, wz), range: range[type] ?? 700, heading: this.app.controller.view.heading, pitch: -28 * DEG }, {
      done: () => this.showPlace({ id: 'q', name, kind: prettyType(type), lon: 0, lat: 0, range: 0, heading: 0, pitch: 0, text: this.locate(x, y) }, 7000),
    });
  }

  // ------------------------------------------------------------------ street view
  enterStreet(x?: number, z?: number) {
    const c = this.app.controller;
    if (c.mode === 'walk') return;
    const tx = x ?? c.view.x, tz = z ?? c.view.z;
    const yaw = c.view.heading;
    this.stopTour();
    c.flyTo({ x: tx, z: tz, y: c.heightAt(tx, tz), range: 40, heading: yaw, pitch: -6 * DEG }, {
      duration: 2.2,
      done: () => { c.enterWalk(tx - Math.sin(yaw) * 30, tz + Math.cos(yaw) * 30, yaw); this.streetExit.classList.remove('hidden'); },
    });
  }

  exitStreet() {
    this.app.controller.exitWalk();
    this.streetExit.classList.add('hidden');
  }

  // ------------------------------------------------------------------ tour
  toggleTour() { if (this.touring) this.stopTour(); else this.startTour(); }

  startTour() {
    this.touring = true;
    this.tourIndex = 0;
    this.nextStop();
  }

  private nextStop() {
    if (!this.touring) return;
    const p = PLACES[this.tourIndex % PLACES.length];
    this.tourIndex++;
    // ease the clock toward the stop's suggested time
    if (p.hour !== undefined) this.easeTime(p.hour);
    this.goPlace(p, 8000);
    const wait = () => {
      if (!this.touring) return;
      if (this.app.controller.flight) { this.tourTimer = window.setTimeout(wait, 300); return; }
      // slow orbit while holding
      const start = performance.now();
      const orbit = () => {
        if (!this.touring) return;
        const el = performance.now() - start;
        this.app.controller.goal.heading += 0.0009;
        if (el < 8500) requestAnimationFrame(orbit); else this.nextStop();
      };
      requestAnimationFrame(orbit);
    };
    this.tourTimer = window.setTimeout(wait, 600);
  }

  stopTour() {
    if (!this.touring) return;
    this.touring = false;
    if (this.tourTimer) window.clearTimeout(this.tourTimer);
  }

  easeTime(target: number, seconds = 4) {
    const t = this.app.time;
    t.live = false;
    t.rate = 0;
    const from = t.hour;
    let delta = target - from;
    if (delta > 12) delta -= 24;
    if (delta < -12) delta += 24;
    const t0 = performance.now();
    const step = () => {
      const a = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      const e = a * a * (3 - 2 * a);
      t.hour = (from + delta * e + 24) % 24;
      if (a < 1) requestAnimationFrame(step);
      this.syncTimeButtons();
    };
    requestAnimationFrame(step);
  }
}

function prettyType(t: string) {
  const m: Record<string, string> = {
    district: 'Planning area', neighbourhood: 'Neighbourhood', suburb: 'Neighbourhood', place: 'Place', island: 'Island',
    station_mrt: 'MRT station', station_lrt: 'LRT station', attraction: 'Attraction', museum: 'Museum', viewpoint: 'Viewpoint',
    park: 'Park', mall: 'Mall', hawker: 'Hawker centre', religious: 'Place of worship', hotel: 'Hotel', school: 'University',
    hospital: 'Hospital', landmark: 'Landmark', water: 'Reservoir', peak: 'Hill', lighthouse: 'Lighthouse', airport: 'Airport',
    beach: 'Beach', road: 'Street', building: 'Building', stadium: 'Stadium', bridge: 'Bridge',
  };
  return m[t] ?? t;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
