import * as THREE from 'three';
import { ephemeris, sgDate, sgNow } from './astro';
import { U } from './uniforms';

/** Drives sun, moon, night factor and atmosphere state from a Singapore local date/time. */
export class TimeOfDay {
  year: number; month: number; day: number;
  hour: number;
  rate = 0;                    // hours per real second (0 = frozen)
  live = false;                // follow the real clock in Singapore
  sunEl = 0;
  private lastKey = '';
  onChange: () => void = () => {};

  constructor() {
    const n = sgNow();
    this.year = n.y; this.month = n.m; this.day = n.d; this.hour = n.hour;
  }

  setHour(h: number) {
    this.live = false;
    this.hour = ((h % 24) + 24) % 24;
  }

  update(dt: number) {
    if (this.live) {
      const n = sgNow();
      this.year = n.y; this.month = n.m; this.day = n.d; this.hour = n.hour;
    } else if (this.rate !== 0) {
      this.hour = (this.hour + this.rate * dt + 24) % 24;
    }
    const key = `${this.year}-${this.month}-${this.day}-${this.hour.toFixed(4)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const e = ephemeris(sgDate(this.year, this.month, this.day, this.hour));
    this.sunEl = e.sunEl;
    const sd = new THREE.Vector3(...e.sun).normalize();
    U.uSunDir.value.copy(sd);
    U.uMoonDir.value.set(...e.moon).normalize();
    U.uMoonPhase.value = e.moonIllum;
    // moonlight: ~1/400,000 of sunlight at full moon, times phase; we exaggerate slightly
    // (as the eye does at night) so moonlit scenes read.
    const moonUp = Math.max(0, Math.min(1, (e.moonEl + 2) / 12));
    const m = 0.0011 * e.moonIllum * moonUp * U.uSunIntensity.value;
    U.uMoonLight.value.set(m * 0.78, m * 0.86, m * 1.0);
    // night factor drives artificial lights (on at civil dusk, off at dawn)
    const night = 1 - smooth(-7, 1.5, e.sunEl);
    U.uNight.value = night;
    // haze: humid mornings, clearer late afternoons; a touch more haze at night (city glow)
    const h = this.hour;
    const morning = Math.exp(-sq((h - 7.5) / 2.2));
    U.uHaze.value = 1.6 + 1.6 * morning + 0.6 * night;
    this.onChange();
  }

  /** Human readable "18:42". */
  label() {
    const hh = Math.floor(this.hour);
    const mm = Math.floor((this.hour - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function sq(x: number) { return x * x; }
