import * as THREE from 'three';
import { COMMON, CURVATURE } from '../shaders/common';
import { ATMO_PARAMS, ATMO_RUNTIME } from '../shaders/atmosphere';
import { TERRAIN_SAMPLE } from '../shaders/terrain';
import { SHADOWS, LIGHTING } from '../shaders/lighting';
import { GROUND_FS } from '../shaders/ground';
import { U } from '../core/uniforms';

const GRID = 32;            // quads per node side
const ROOT = 262144;        // root node size (m) == far field square
const LEVELS = 12;          // root .. 64 m leaves
const MAX_NODES = 900;

const VS = /* glsl */ `
in vec4 aNode;               // x, z, size, lod
uniform vec2 uMorph[${LEVELS}];
out vec3 vWorld;
out float vDist;
${COMMON}
${TERRAIN_SAMPLE}
${CURVATURE}
void main() {
  vec2 g = position.xz;
  float size = aNode.z;
  int lod = int(aNode.w + 0.5);
  vec2 wp = aNode.xy + g / ${GRID}.0 * size;
  float h = terrainHeight(wp);
  float dist = distance(cameraPosition, vec3(wp.x, h, wp.y));
  vec2 m = uMorph[lod];
  float k = saturate((dist - m.x) / max(m.y - m.x, 1.0));
  vec2 fr = fract(g * 0.5) * 2.0;
  g -= fr * k;
  wp = aNode.xy + g / ${GRID}.0 * size;
  h = terrainHeight(wp);
  vec3 world = vec3(wp.x, h, wp.y);
  vWorld = world;
  vDist = distance(cameraPosition, world);
  gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(world), 1.0);
}
`;

const FS = /* glsl */ `
in vec3 vWorld;
in float vDist;
out vec4 fragColor;
${COMMON}
${ATMO_PARAMS}
${ATMO_RUNTIME}
${TERRAIN_SAMPLE}
${SHADOWS}
${LIGHTING}
${GROUND_FS}
void main() {
  vec3 wp = vWorld;
  vec3 V = normalize(cameraPosition - wp);
  // normal from the height field (texel-scale finite differences)
  float edge = max(abs(wp.x), abs(wp.z)) / uDomainHalf;
  float e = edge < 1.0 ? 2.0 * uDomainHalf / 2048.0 : 2.0 * uFarHalf / 2048.0;
  float hx = terrainHeight(wp.xz + vec2(e, 0.0)) - terrainHeight(wp.xz - vec2(e, 0.0));
  float hz = terrainHeight(wp.xz + vec2(0.0, e)) - terrainHeight(wp.xz - vec2(0.0, e));
  vec3 N = normalize(vec3(-hx, 2.0 * e, -hz));
  GroundSample gs = sampleGround(wp, vDist, N);
  N = gs.normal;
  float sh = sunShadow(wp, N, vDist);
  vec3 col = shadeSurface(gs.albedo, N, V, gs.rough, 0.03, sh * gs.canopyShadow, gs.ao, wp);
  col += gs.emissive;
  col = applyAerial(col, wp);
  fragColor = vec4(col, 1.0);
}
`;

interface Node { x: number; z: number; size: number; lod: number }

/** CDLOD terrain: one instanced draw, geomorphed between levels. */
export class Terrain {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private nodeAttr: THREE.InstancedBufferAttribute;
  private ranges: number[] = [];
  private geom: THREE.InstancedBufferGeometry;
  private frustum = new THREE.Frustum();
  private box = new THREE.Box3();
  private nodes: Node[] = [];
  private projView = new THREE.Matrix4();

  constructor(leafRange = 180) {
    // grid geometry in node-local units [0, GRID]
    const verts: number[] = [];
    for (let z = 0; z <= GRID; z++) for (let x = 0; x <= GRID; x++) verts.push(x, 0, z);
    const idx: number[] = [];
    const W = GRID + 1;
    for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
      const a = z * W + x, b = a + 1, c = a + W, d = c + 1;
      // alternate diagonals for nicer morphing
      if ((x + z) % 2 === 0) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    this.nodeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 4), 4);
    this.nodeAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aNode', this.nodeAttr);
    g.instanceCount = 0;
    this.geom = g;
    // LOD ranges: level 0 = leaves
    for (let i = 0; i < LEVELS; i++) this.ranges.push(leafRange * Math.pow(2, i));
    const morph: THREE.Vector2[] = [];
    for (let i = 0; i < LEVELS; i++) {
      const end = this.ranges[i];
      const start = i === 0 ? end * 0.6 : this.ranges[i - 1] + (end - this.ranges[i - 1]) * 0.55;
      morph.push(new THREE.Vector2(start, end * 0.98));
    }
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: { ...U, uMorph: { value: morph } },
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  private select(x: number, z: number, size: number, level: number, cam: THREE.Vector3): boolean {
    // level: 0 = leaves ... LEVELS-1 = root
    this.box.min.set(x, -40, z);
    this.box.max.set(x + size, 700, z + size);
    const r = this.ranges[level];
    if (this.box.distanceToPoint(cam) > r) return false;
    if (!this.frustum.intersectsBox(this.box)) return true; // in range but invisible: handled
    if (level === 0) {
      this.push(x, z, size, 0);
      return true;
    }
    this.box.min.set(x, -40, z);
    this.box.max.set(x + size, 700, z + size);
    if (this.box.distanceToPoint(cam) > this.ranges[level - 1]) {
      this.push(x, z, size, level);
      return true;
    }
    const h = size / 2;
    const kids: [number, number][] = [[x, z], [x + h, z], [x, z + h], [x + h, z + h]];
    for (const [cx, cz] of kids) {
      if (!this.select(cx, cz, h, level - 1, cam)) {
        // child out of its range: draw it at this level
        this.box.min.set(cx, -40, cz);
        this.box.max.set(cx + h, 700, cz + h);
        if (this.frustum.intersectsBox(this.box)) this.push(cx, cz, h, level);
      }
    }
    return true;
  }

  private push(x: number, z: number, size: number, lod: number) {
    if (this.nodes.length < MAX_NODES) this.nodes.push({ x, z, size, lod });
  }

  update(camera: THREE.PerspectiveCamera) {
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView, THREE.WebGLCoordinateSystem, camera.reversedDepth);
    this.nodes.length = 0;
    const half = ROOT / 2;
    this.select(-half, -half, ROOT, LEVELS - 1, camera.position);
    const a = this.nodeAttr.array as Float32Array;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      a[i * 4] = n.x; a[i * 4 + 1] = n.z; a[i * 4 + 2] = n.size; a[i * 4 + 3] = n.lod;
    }
    this.nodeAttr.needsUpdate = true;
    this.nodeAttr.addUpdateRange(0, this.nodes.length * 4);
    this.geom.instanceCount = this.nodes.length;
  }

  get nodeCount() { return this.nodes.length; }
}
