import { App } from './App';

const DEG = Math.PI / 180;
const canvas = document.getElementById('world') as HTMLCanvasElement;
const app = new App(canvas);
(window as any).app = app;

const params = new URLSearchParams(location.search);
await app.load((f, label) => { (window as any).__progress = [f, label]; });
const hour = params.get('hour');
if (hour) app.time.setHour(parseFloat(hour));
const v = params.get('view');
if (v) {
  const [x, z, range, heading, pitch] = v.split(',').map(Number);
  app.controller.setView({ x, z, range, heading: heading * DEG, pitch: pitch * DEG }, true);
} else {
  app.controller.setView({ x: 3000, z: 5500, range: 6000, heading: -20 * DEG, pitch: -28 * DEG }, true);
}
const frames = params.get('frames');
if (frames) {
  // deterministic capture mode for automated screenshots
  await app.settle(90000);
  for (let i = 0; i < Number(frames); i++) app.frame();
  (window as any).__stats = app.tiles.stats;
  (window as any).__ready = true;
} else {
  app.start();
  (window as any).__ready = true;
}
