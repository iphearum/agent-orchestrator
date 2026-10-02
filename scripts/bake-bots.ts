// Bakes the Meshy GLB bots in backend/src/bots/ into rig-ready assets for the robot runtime (media/bots/):
//   <bot>.bin      geometry (quantised), skin joints/weights for the procedural robot's rig, indices
//   <bot>-*.webp   textures resized to TEXTURE_PX
// The runtime rebuilds the same pivot rig as the procedural robot (upper body, neck, arms, legs) and skins the mesh to
// it, so every state and act in poseAt/playOver plays on the bot unchanged.
//
//   bun scripts/bake-bots.ts [jocy|ally|vally|meshy|buddy|jarvis]
// Adding a bot (measuring joints, writing its CONFIG, registering it, verifying): see .claude/skills/glb-bot/SKILL.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve("backend/src/bots");
const OUT = resolve("media/bots");
const WORK = resolve(".ui-check/bake");
/** Same standing height as the procedural robot, so hero framing, walk distances and bob amplitudes carry over. */
const HEIGHT = 8.7;
const TEXTURE_PX = 1024;

/** Bone order shared with the runtime (webview-ui/src/robot-bots.ts). Side −1 is −X (the viewer's right). */
export const BONES = ["root", "upper", "head", "antenna", "arm-1", "forearm-1", "arm+1", "forearm+1", "thigh-1", "shin-1", "foot-1", "thigh+1", "shin+1", "foot+1"] as const;
type Bone = (typeof BONES)[number];
type V3 = [number, number, number];

/** Joint pivots in baked units (+X is the viewer's left, +Z toward the viewer, floor at y = 0). */
type Rig = {
  hip: V3; neck: V3; antenna: V3; antennaBall: { at: V3; radius: number };
  shoulder: [V3, V3]; elbow: [V3, V3]; wrist: [V3, V3];
  hipJoint: [V3, V3]; knee: [V3, V3]; ankle: [V3, V3];
};
/** Visor rectangle on the head's front (centre, width, height, squircle exponent) and the face layout on it. */
type FaceSpec = {
  centre: [number, number]; width: number; height: number; squircle: number; inset: number;
  /**
   * Trace the visor from a sculpted recess instead: the rectangle becomes the recess's bounds and `outline` its edge
   * (canvas fractions: 0..1 across from the viewer's left, 0..1 down), which the runtime fills as the glass.
   */
  recess?: boolean;
  outline?: number[];
  /**
   * The rim's inner lip as a closed 3D path (x, y, z triples, baked units), just outside the outline at the lip's
   * height. The runtime runs a smooth bezel tube along it to hide the decimated lip's jagged edge.
   */
  rim?: number[];
};
type BotConfig = {
  rig: Rig;
  face: FaceSpec;
  /** Hard part label for a vertex (`lum` is its base-colour luminance, 0..1); joint blending is applied afterwards. */
  classify(p: V3, rig: Rig, lum: number): Bone;
  /** Target triangle count after simplification (undefined keeps the mesh as is). */
  triangles?: number;
  /** Blend half-width (units) across each joint. */
  band: number;
  /**
   * Smooth-skinning width (units): after the hard labels and joint bands, weights diffuse over the mesh surface
   * between parts that share a joint, so a label boundary away from a pivot bends gradually instead of tearing.
   * 0 or unset keeps the hard labels.
   */
  smooth?: number;
  /** Minimum pivot distance for surface weight diffusion (default 0.9); lower this when the torso shell is nearby. */
  smoothingReach?: number;
  /**
   * Triangles (by centroid and part) whose dark texels are paint from a part that used to rest against them, e.g.
   * the hands' black baked onto the thighs. They show once the part moves away, so they are repainted shell-white.
   */
  scrub?(centroid: V3, part: Bone): boolean;
  /**
   * Also drop triangles between linked parts unless their vertices share a bone through the joint blend. For meshes
   * where a limb is sculpted welded to the body away from its pivot (Vally's arms on the torso), those welds would
   * otherwise stretch into sheets when the limb swings.
   */
  strictSeams?: boolean;
  /** Sideways reach of the neck blend (default 1.2): widen it when the helmet's underside rests on the shoulders. */
  neckReach?: number;
  /**
   * Shoulder blend axis for side +1 (x is mirrored for side −1); defaults to shoulder → elbow. Set it when the arm
   * leaves the torso in another direction than it hangs (Meshy: sideways), or the torso side below the shoulder
   * blends onto the arm and peels off when it lifts.
   */
  shoulderAxis?: V3;
  /** Lateral reach of the shoulder joint band (default 0.6). */
  shoulderReach?: number;
  /** With strictSeams: still drop bridges (triangles between unlinked parts) instead of reassigning them. */
  dropBridges?: boolean;
  /**
   * Turn the model about Y (degrees, Babylon's RotationY: x' = x cos + z sin) before normalising, for a model whose
   * body faces away from +Z. Measure with `grid.ts --yaw=<same>`.
   */
  yaw?: number;
  /**
   * Self-lit paint for a model without an emissive map: how strongly (0..1) a base-colour texel glows. The bake
   * writes `<bot>-emissive.webp` from it (Jarvis's cyan eye slits and arc reactor).
   */
  glow?(r: number, g: number, b: number): number;
  /**
   * The body's vertical axis [x, z] in the measured frame. The bake centres on the bounding box, so a bot with one
   * arm flung out (Jarvis) stands off the origin and turns orbit around empty space; the finished mesh, rig and face
   * are shifted so this axis is x = z = 0. Pivots, classify and face stay in measured (grid) units.
   */
  origin?: [number, number];
};

/** Each bone's parent in the runtime's hierarchy (buildBot). */
const PARENT: Partial<Record<Bone, Bone>> = {
  upper: "root", head: "upper", antenna: "head", "arm-1": "upper", "arm+1": "upper", "forearm-1": "arm-1", "forearm+1": "arm+1",
  "thigh-1": "root", "thigh+1": "root", "shin-1": "thigh-1", "shin+1": "thigh+1", "foot-1": "shin-1", "foot+1": "shin+1",
};
const sideOf = (x: number) => (x >= 0 ? "+1" : "-1") as "+1" | "-1";
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const along = (p: V3, from: V3, to: V3) => dot(sub(p, from), norm(sub(to, from)));

/**
 * Find the visor recess around `face.centre`: rasterise a front depth map, keep the local relief (depth minus its
 * neighbourhood mean), flood-fill the flat region from the centre, grow it into the groove under the rim, then walk
 * rays out from its centroid to get the outline.
 */
function recessFace(pos: Float64Array, indices: ArrayLike<number>, face: FaceSpec): FaceSpec {
  const R = 0.02, [fx, fy] = face.centre;
  const X0 = fx - face.width, Y0 = fy - face.height, NX = Math.ceil(face.width * 2 / R), NY = Math.ceil(face.height * 2 / R);
  const Z = new Float32Array(NX * NY).fill(-Infinity);
  for (let t = 0; t < indices.length; t += 3) {
    const v = [0, 1, 2].map(k => [pos[3 * indices[t + k]], pos[3 * indices[t + k] + 1], pos[3 * indices[t + k] + 2]]);
    if (v.some(p => p[2] < 0)) continue;
    const [a, b, c] = v;
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-12) continue;
    const gx0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - X0) / R)), gx1 = Math.min(NX - 1, Math.ceil((Math.max(a[0], b[0], c[0]) - X0) / R));
    const gy0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - Y0) / R)), gy1 = Math.min(NY - 1, Math.ceil((Math.max(a[1], b[1], c[1]) - Y0) / R));
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const x = X0 + gx * R, y = Y0 + gy * R;
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
      if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
      Z[gy * NX + gx] = Math.max(Z[gy * NX + gx], l1 * a[2] + l2 * b[2] + (1 - l1 - l2) * c[2]);
    }
  }
  const K = 8;
  const relief = (gx: number, gy: number) => {
    const z = Z[gy * NX + gx];
    if (z === -Infinity) return Infinity;
    let sum = 0, n = 0;
    for (let dy = -K; dy <= K; dy += 2) for (let dx = -K; dx <= K; dx += 2) {
      const q = Z[(gy + dy) * NX + gx + dx];
      if (gx + dx >= 0 && gx + dx < NX && gy + dy >= 0 && gy + dy < NY && q > -Infinity) { sum += q; n++; }
    }
    return z - sum / n;
  };
  let mask = new Uint8Array(NX * NY);
  const start = Math.round((fy - Y0) / R) * NX + Math.round((fx - X0) / R);
  for (const stack = [start]; stack.length;) {
    const i = stack.pop()!;
    if (mask[i]) continue;
    const gx = i % NX, gy = (i - gx) / NX;
    if (gx < 1 || gy < 1 || gx >= NX - 1 || gy >= NY - 1 || Math.abs(relief(gx, gy)) > 0.012) continue;
    mask[i] = 1;
    stack.push(i + 1, i - 1, i + NX, i - NX);
  }
  // The flat fill stops where the rim's slope starts pulling the relief down; grow into the groove.
  for (let step = 0; step < 1; step++) {
    const grown = mask.slice();
    for (let i = NX; i < NX * NY - NX; i++) if (!mask[i] && (mask[i + 1] || mask[i - 1] || mask[i + NX] || mask[i - NX])) grown[i] = 1;
    mask = grown;
  }
  let cx = 0, cy = 0, n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { cx += X0 + (i % NX) * R; cy += Y0 + Math.floor(i / NX) * R; n++; }
  cx /= n; cy /= n;
  const RAYS = 180;
  const radii = Array.from({ length: RAYS }, (_, k) => {
    const a = (k / RAYS) * Math.PI * 2;
    let r = 0;
    while (true) {
      const gx = Math.round((cx + Math.cos(a) * (r + R / 2) - X0) / R), gy = Math.round((cy + Math.sin(a) * (r + R / 2) - Y0) / R);
      if (gx < 0 || gy < 0 || gx >= NX || gy >= NY || !mask[gy * NX + gx]) break;
      r += R / 2;
    }
    return r + R / 2;
  });
  // Relief noise on the decimated rim stops the fill early in places: dents point inward, so a rolling max fills
  // them before a moving average smooths the curve.
  const around = (f: (k: number) => number, w: number, pick: (v: number[]) => number) =>
    Array.from({ length: RAYS }, (_, k) => pick(Array.from({ length: 2 * w + 1 }, (_, d) => f((k + d - w + RAYS) % RAYS))));
  const filled = around(k => radii[k], 4, v => Math.max(...v));
  const smooth = around(k => filled[k], 4, v => v.reduce((s, x) => s + x, 0) / v.length);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const points = smooth.map((r, k) => {
    const a = (k / RAYS) * Math.PI * 2, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    return [x, y];
  });
  const centre: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2], width = x1 - x0, height = y1 - y0;
  const outline = points.flatMap(([x, y]) => [+(0.5 - (x - centre[0]) / width).toFixed(4), +(0.5 - (y - centre[1]) / height).toFixed(4)]);
  console.log(`  visor recess: centre ${centre.map(v => v.toFixed(2))}, ${width.toFixed(2)} × ${height.toFixed(2)}`);
  // Lip path: 0.05 past the glass edge, at the highest surface from just inside it to 0.16 past it (the lip's top,
  // which overhangs the glass at the bottom), smoothed.
  const depthAt = (x: number, y: number) => {
    const gx = Math.round((x - X0) / R), gy = Math.round((y - Y0) / R);
    return gx < 0 || gy < 0 || gx >= NX || gy >= NY ? -Infinity : Z[gy * NX + gx];
  };
  const lip = smooth.map((r, k) => {
    const a = (k / RAYS) * Math.PI * 2;
    let top = -Infinity;
    for (let d = -0.04; d <= 0.16; d += R / 2) top = Math.max(top, depthAt(cx + Math.cos(a) * (r + d), cy + Math.sin(a) * (r + d)));
    return top;
  });
  // Rolling max first: the decimated lip has spikes, and the bezel must clear every one or they poke through it.
  const lipTop = around(k => lip[k], 5, v => Math.max(...v));
  const lipZ = around(k => lipTop[k], 5, v => v.filter(Number.isFinite).reduce((s, x) => s + x, 0) / Math.max(1, v.filter(Number.isFinite).length));
  const rim = smooth.flatMap((r, k) => {
    const a = (k / RAYS) * Math.PI * 2;
    // Centred just outside the glass so a thick bezel covers the groove and the lip (the painting's white rim).
    return [cx + Math.cos(a) * (r + 0.05), cy + Math.sin(a) * (r + 0.05), lipZ[k] + 0.03].map(v => +v.toFixed(4));
  });
  return { ...face, centre, width, height, outline, rim };
}

/**
 * Diffuse skin weights over the surface (Laplacian smoothing on the position-welded vertex graph). A vertex only
 * takes weight from its own part and the parts it shares a joint with, so unrelated parts that touch (a hand on a
 * thigh) never blend. Iterations scale with (width / mean edge)², so the blend width is in units whatever the
 * mesh density. Weight only crosses between two parts near their shared joint (within `limit` of its pivot): where
 * parts merely touch elsewhere (Vally's arms pressed to its torso) the boundary stays hard for strictSeams, or the
 * contact would stretch like rubber. The result keeps the three strongest bones per vertex (a shoulder top needs
 * torso, arm and head).
 */
function smoothWeights(count: number, pos: Float64Array, indices: ArrayLike<number>, joints: Uint8Array, weights: Uint8Array, label: Uint8Array, linkList: Array<{ pair: [number, number]; pivot: V3; limit: number }>, width: number) {
  const links = linkList.map(l => l.pair);
  const B = BONES.length;
  // Graph nodes: vertices welded by position and part (UV seams must share weights, or they would crack open; a
  // seam can also split labels when classify uses texture brightness, and those copies must keep their own part).
  const nodeOf = new Int32Array(count);
  const at = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos[3 * i] * 1e4)},${Math.round(pos[3 * i + 1] * 1e4)},${Math.round(pos[3 * i + 2] * 1e4)}|${label[i]}`;
    let n = at.get(key);
    if (n === undefined) { n = at.size; at.set(key, n); }
    nodeOf[i] = n;
  }
  const N = at.size;
  const allowed = Array.from({ length: B }, (_, b) => {
    const set = new Uint8Array(B); set[b] = 1;
    for (const [p, c] of links) { if (p === b) set[c] = 1; if (c === b) set[p] = 1; }
    return set;
  });
  const nodeLabel = new Uint8Array(N);
  let w = new Float32Array(N * B);
  const seen = new Uint8Array(N);
  for (let i = 0; i < count; i++) {
    const n = nodeOf[i];
    if (seen[n]) continue;
    seen[n] = 1;
    nodeLabel[n] = label[i];
    w[n * B + joints[4 * i]] += weights[4 * i] / 255;
    w[n * B + joints[4 * i + 1]] += weights[4 * i + 1] / 255;
  }
  // Adjacency (CSR) and mean edge length.
  const pairs = new Set<number>();
  let edgeSum = 0, edges = 0;
  for (let t = 0; t < indices.length; t += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
    const i = indices[t + a], j = indices[t + b], p = nodeOf[i], q = nodeOf[j];
    if (p === q) continue;
    if (label[i] !== label[j]) {
      const link = linkList.find(l => (l.pair[0] === label[i] && l.pair[1] === label[j]) || (l.pair[0] === label[j] && l.pair[1] === label[i]));
      const mid: V3 = [(pos[3 * i] + pos[3 * j]) / 2, (pos[3 * i + 1] + pos[3 * j + 1]) / 2, (pos[3 * i + 2] + pos[3 * j + 2]) / 2];
      if (!link || len(sub(mid, link.pivot)) > link.limit) continue;
    }
    const key = p < q ? p * N + q : q * N + p;
    if (pairs.has(key)) continue;
    pairs.add(key);
    edgeSum += Math.hypot(pos[3 * i] - pos[3 * j], pos[3 * i + 1] - pos[3 * j + 1], pos[3 * i + 2] - pos[3 * j + 2]);
    edges++;
  }
  const degree = new Int32Array(N + 1);
  for (const key of pairs) { degree[Math.floor(key / N)]++; degree[key % N]++; }
  const start = new Int32Array(N + 1);
  for (let n = 0; n < N; n++) start[n + 1] = start[n] + degree[n];
  const fill = start.slice(0, N);
  const adj = new Int32Array(start[N]);
  for (const key of pairs) { const p = Math.floor(key / N), q = key % N; adj[fill[p]++] = q; adj[fill[q]++] = p; }
  const iterations = Math.min(400, Math.ceil((width / (edgeSum / edges)) ** 2));
  let next = new Float32Array(N * B);
  for (let it = 0; it < iterations; it++) {
    for (let n = 0; n < N; n++) {
      const ok = allowed[nodeLabel[n]];
      let total = 0;
      for (let b = 0; b < B; b++) {
        if (!ok[b]) { next[n * B + b] = 0; continue; }
        let v = w[n * B + b];
        for (let k = start[n]; k < start[n + 1]; k++) v += w[adj[k] * B + b];
        v /= start[n + 1] - start[n] + 1;
        next[n * B + b] = v;
        total += v;
      }
      for (let b = 0; b < B; b++) next[n * B + b] /= total || 1;
    }
    [w, next] = [next, w];
  }
  const outJoints = new Uint8Array(count * 4), outWeights = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const n = nodeOf[i];
    const top = Array.from({ length: B }, (_, b) => b).sort((a, b) => w[n * B + b] - w[n * B + a]).slice(0, 3).filter((b, k) => k === 0 || w[n * B + b] > 0.004);
    const sum = top.reduce((s, b) => s + w[n * B + b], 0) || 1;
    const q = top.map(b => Math.round(w[n * B + b] / sum * 255));
    q[0] = 255 - q.slice(1).reduce((s, v) => s + v, 0);
    top.forEach((b, k) => { outJoints[4 * i + k] = b; outWeights[4 * i + k] = q[k]; });
  }
  console.log(`  smoothed weights: ${iterations} iterations over ${N} welded vertices (width ${width})`);
  return { skinJoints: outJoints, skinWeights: outWeights };
}

/** A face spec moved by −(ox, oz) with its bot (`origin`): the centre and the rim path; the outline is relative. */
function shiftFace(face: FaceSpec, ox: number, oz: number): FaceSpec {
  if (!ox && !oz) return face;
  return { ...face, centre: [face.centre[0] - ox, face.centre[1]], rim: face.rim?.map((v, k) => v - (k % 3 === 0 ? ox : k % 3 === 2 ? oz : 0)) };
}

/** Distance from p to segment a→b. */
function segmentDistance(p: V3, a: V3, b: V3) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
}
/** The part whose capsule (polyline + radius) is nearest relative to its radius. */
function nearestPart(p: V3, parts: Array<[Bone, V3[], number]>): Bone {
  let best: Bone = "upper", score = Infinity;
  for (const [bone, line, radius] of parts) {
    let d = Infinity;
    for (let k = 0; k + 1 < line.length; k++) d = Math.min(d, segmentDistance(p, line[k], line[k + 1]));
    if (d / radius < score) { score = d / radius; best = bone; }
  }
  return best;
}

const CONFIG: Record<string, BotConfig> = {
  // Upright toy robot (measured on .ui-check/grid-jocy.png): big round head on a dark neck ring, short arms with a
  // dark elbow joint and black hands, stubby legs in big boots.
  jocy: {
    rig: {
      hip: [0, 1.66, 0.15], neck: [0, 4.0, 0.1], antenna: [0, 7.12, -1.05], antennaBall: { at: [0, 8.56, -1.05], radius: 0.17 },
      shoulder: [[-1.12, 3.36, 0.1], [1.12, 3.36, 0.1]], elbow: [[-1.42, 2.94, 0.1], [1.42, 2.94, 0.1]], wrist: [[-1.5, 1.8, 0.05], [1.5, 1.8, 0.05]],
      hipJoint: [[-0.6, 1.62, 0.15], [0.6, 1.62, 0.15]], knee: [[-0.58, 1.0, 0.15], [0.58, 1.0, 0.15]], ankle: [[-0.58, 0.42, 0.2], [0.58, 0.42, 0.2]],
    },
    face: { centre: [0, 5.47], width: 2.74, height: 1.3, squircle: 3.2, inset: 0 },
    band: 0.14,
    smooth: 0.45,
    strictSeams: true,
    scrub: ([x, y], part) => (part.startsWith("thigh") || part === "upper") && Math.abs(x) > 0.85 && y > 1.05 && y < 2.0,
    classify([x, y, z], rig, lum) {
      if (y > 7.0 && Math.hypot(x, z + 1.05) < 0.34) return "antenna";
      if (y > 4.02) return "head";
      const s = sideOf(x);
      // Arms hang beside the torso; the black fingertips curl in against the white thighs (the knee ring is below 1.1).
      const hand = lum < 0.25 && Math.abs(x) > 0.92 && y > 1.1 && y < 1.95;
      // The shoulder pads start at |x| ≈ 1.0; below them the forearm's inner face is at ≈ 1.12, clear of the torso.
      // Low down the hand rests against the thigh: only points near the wrist are hand (the thigh's outer face and its
      // dark knee ring at |x| 0.8–1.2 were labelled forearm and rode along with a raised hand as a white flap).
      const nearWrist = Math.hypot(Math.abs(x) - rig.wrist[1][0], y - rig.wrist[1][1], z - rig.wrist[1][2]) < 0.8 && Math.abs(x) > 1.05;
      const armZone = (Math.abs(x) > 1.02 && y > 3.0 && y < 3.8) || (Math.abs(x) > 1.12 && y > 1.45 && y < 3.8);
      if ((hand || armZone || (y <= 1.45 && y > 0.85 && Math.abs(x) > 1.12)) && (y > 1.45 || nearWrist)) {
        const i = s === "+1" ? 1 : 0;
        return along([x, y, z], rig.elbow[i], rig.wrist[i]) > 0 ? `forearm${s}` : `arm${s}`;
      }
      // Below the knees the boots meet in the middle, so split by side alone; above, the belly hangs between the hips.
      if (y < rig.knee[0][1]) return y > rig.ankle[0][1] ? `shin${s}` : `foot${s}`;
      if (y < 1.6 && Math.abs(x) > 0.1) return `thigh${s}`;
      return "upper";
    },
  },
  // Mid-leap sci-fi robot (measured on .ui-check/grid-ally.png): head offset to the viewer's left, right arm (−X)
  // raised in a wave, left arm (+X) trailing down and back, left knee drawn up, right leg trailing behind.
  ally: {
    rig: {
      hip: [0.35, 2.75, -0.5], neck: [0.55, 5.2, -0.4], antenna: [2.15, 7.75, -1.85], antennaBall: { at: [2.15, 8.53, -1.85], radius: 0.14 },
      shoulder: [[-0.77, 4.9, -0.4], [2.1, 4.62, -0.9]], elbow: [[-1.47, 5.39, 0.5], [2.73, 3.44, -1.5]], wrist: [[-2.66, 6.58, 1.6], [3.22, 2.18, -1.6]],
      // Both lower legs kick back (soles face −Z): the right knee comes forward, the left one hangs lower.
      hipJoint: [[-0.56, 2.85, -0.4], [1.15, 2.6, -0.6]], knee: [[-0.9, 2.3, 0.35], [1.05, 1.55, -0.6]], ankle: [[-1.1, 1.35, -1.0], [0.75, 0.9, -1.4]],
    },
    // Wide enough to cover both painted ring eyes (the visor is turned, so the left eye sits near its edge).
    face: { centre: [0.6, 6.75], width: 3.1, height: 1.8, squircle: 3, inset: 0 },
    band: 0.16,
    smooth: 0.45,
    strictSeams: true,
    triangles: 70000,
    classify(p, rig) {
      const [x, y, z] = p;
      if (y > 7.7 && Math.hypot(x - 2.15, z + 1.85) < 0.32) return "antenna";
      // Helmet: an ellipsoid around the head (ears included).
      if (((x - 0.95) / 2.0) ** 2 + ((y - 6.82) / 1.62) ** 2 + ((z + 0.3) / 2.12) ** 2 < 1.12 && y > 5.25) return "head";
      const hand = (w: V3, e: V3): V3 => [w[0] + (w[0] - e[0]) * 0.9, w[1] + (w[1] - e[1]) * 0.9, w[2] + (w[2] - e[2]) * 0.9];
      return nearestPart(p, [
        // The pelvis ends at y ≈ 2.2; anything lower is a leg or a hand.
        ...(y > 2.2 ? [["upper", [rig.hip, rig.neck], 1.25] as [Bone, V3[], number]] : []),
        ["arm-1", [rig.shoulder[0], rig.elbow[0]], 0.42], ["forearm-1", [rig.elbow[0], rig.wrist[0], hand(rig.wrist[0], rig.elbow[0])], 0.6],
        ["arm+1", [rig.shoulder[1], rig.elbow[1]], 0.42], ["forearm+1", [rig.elbow[1], rig.wrist[1], hand(rig.wrist[1], rig.elbow[1])], 0.6],
        ["thigh-1", [rig.hipJoint[0], rig.knee[0]], 0.6], ["shin-1", [rig.knee[0], rig.ankle[0]], 0.6], ["foot-1", [rig.ankle[0], [-1.2, 0.85, -1.7]], 0.6],
        ["thigh+1", [rig.hipJoint[1], rig.knee[1]], 0.6], ["shin+1", [rig.knee[1], rig.ankle[1]], 0.6], ["foot+1", [rig.ankle[1], [0.65, 0.35, -1.9]], 0.6],
      ]);
    },
  },
  // Pearl-white waving bot (measured on .ui-check/glb-bot/grid-vally-*.png). The torso is one egg-shaped shell with
  // no legs; the arms are sculpted into a wave pose and use nearest-capsule labels like ally.
  vally: {
    // Arm depths read from the baked vertices: the lowered hand reaches forward (z ≈ 1.7) and the waving elbow sits
    // behind the shoulder (z ≈ −0.6) before the forearm comes up and forward.
    rig: {
      hip: [0, 1.55, 0.05], neck: [0, 3.82, 0.05], antenna: [-0.40, 7.28, -0.43], antennaBall: { at: [-0.63, 8.35, -0.56], radius: 0.38 },
      shoulder: [[-1.15, 3.0, 0.1], [1.15, 3.0, -0.25]], elbow: [[-1.85, 2.1, 0.55], [1.85, 2.05, -0.55]], wrist: [[-2.35, 1.1, 1.15], [2.35, 2.95, 0.45]],
      // No legs: park the unused leg pivots below the floor so no torso vertex blends onto a thigh.
      hipJoint: [[-0.55, -4, 0.05], [0.55, -4, 0.05]], knee: [[-0.55, -5, 0.05], [0.55, -5, 0.05]], ankle: [[-0.55, -6, 0.05], [0.55, -6, 0.05]],
    },
    // Inner edge of the sculpted visor rim (front grid).
    face: { centre: [0.03, 5.43], width: 3.26, height: 2.26, squircle: 2.5, inset: 0, recess: true },
    band: 0.15,
    smooth: 0.45,
    smoothingReach: 0.7,
    shoulderReach: 0.38,
    triangles: 120000,
    strictSeams: true,
    classify(p, rig) {
      const [x, y, z] = p;
      if (y > 7.65 && Math.hypot(x + 0.40, z + 0.43) < 0.68) return "antenna";
      // Everything above the neck collar is helmet (shell, ear pods, lower rim) except the waving hand's fingers.
      // An ellipsoid here left the lower −X shell and ear bottom on the torso, and strictSeams then cracked them off.
      if (y > 3.85 && !(x > 1.7 && z > 0.2 && y < 4.6)) return "head";
      const arms: Array<[Bone, V3[], number]> = [
        ["arm-1", [rig.shoulder[0], rig.elbow[0]], 0.6], ["forearm-1", [rig.elbow[0], rig.wrist[0], [-2.7, 0.2, 1.75]], 0.72],
        ["arm+1", [rig.shoulder[1], rig.elbow[1]], 0.6], ["forearm+1", [rig.elbow[1], rig.wrist[1], [2.55, 4.0, 0.95]], 0.72],
      ];
      const armDistances = arms.map(([, line]) => Math.min(...line.slice(0, -1).map((a, i) => segmentDistance(p, a, line[i + 1]))));
      // The egg-shaped torso shell (measured per height) stays on the body where an arm rests against it, unless
      // the point is within the limb's own thickness.
      const shell = (x / 1.8) ** 2 + ((y - 1.75) / (y < 1.75 ? 1.8 : 2.1)) ** 2 + ((z + 0.47) / 1.55) ** 2;
      if (shell < 1.25 && Math.min(...armDistances) > 0.72) return "upper";
      const armScore = Math.min(...armDistances.map((d, i) => d / arms[i][2]));
      const best = armScore < 0.75 ? nearestPart(p, arms) : nearestPart(p, [["upper", [rig.hip, rig.neck], 1.3], ...arms]);
      if (best === "upper") return best;
      // Split upper arm from forearm by the plane through the elbow that bisects the joint, so the label boundary
      // always lies inside the elbow blend (capsule radii alone put it mid upper-arm, and strictSeams cracked it).
      const i = best.endsWith("+1") ? 1 : 0, s = best.endsWith("+1") ? "+1" : "-1";
      const toWrist = norm(sub(rig.wrist[i], rig.elbow[i])), toShoulder = norm(sub(rig.shoulder[i], rig.elbow[i]));
      return dot(sub(p, rig.elbow[i]), sub(toWrist, toShoulder)) > 0 ? `forearm${s}` : `arm${s}`;
    },
  },
  // Upright articulated blue-and-white robot (measured on .ui-check/glb-bot/grid-meshy-*.png and arm slices of the
  // baked mesh). Each arm is a dark hose arcing out from the torso top to a blue elbow ring (y 4.4), then a straight
  // forearm down to a blue cuff (y 3.25..3.8) with an open claw hanging below it, beside (not touching) the thighs.
  meshy: {
    rig: {
      // Antenna (vertex slices): base disc y 7.95..8.10, a short stalk, ball y 8.15..8.72 centred at z −0.45.
      hip: [0, 3.15, 0], neck: [0, 5.72, 0], antenna: [0, 8.1, -0.45], antennaBall: { at: [0, 8.46, -0.45], radius: 0.26 },
      shoulder: [[-1.0, 5.45, -0.15], [1.0, 5.45, -0.15]], elbow: [[-1.66, 4.4, -0.17], [1.66, 4.4, -0.17]], wrist: [[-1.78, 3.25, 0], [1.78, 3.25, 0]],
      hipJoint: [[-0.55, 3.12, 0], [0.55, 3.12, 0]], knee: [[-0.57, 1.94, 0], [0.57, 1.94, 0]], ankle: [[-0.57, 0.66, 0], [0.57, 0.66, 0]],
    },
    face: { centre: [0, 6.98], width: 1.68, height: 1.22, squircle: 4, inset: 0 },
    band: 0.15,
    smooth: 0.45,
    triangles: 75000,
    strictSeams: true,
    shoulderAxis: [1, -0.25, 0],
    dropBridges: true,
    // The claws' dark paint is baked onto the thighs' outer faces beside them.
    scrub: ([x, y], part) => part.startsWith("thigh") && Math.abs(x) > 0.8 && y > 2.0 && y < 3.2,
    classify([x, y, z], rig) {
      if (y > 8.1 && Math.hypot(x, z + 0.45) < 0.4) return "antenna";
      if (y > 5.72) return "head";
      const s = sideOf(x), i = s === "+1" ? 1 : 0, ax = Math.abs(x);
      // Arm capsules along the measured path (mirrored). Below the cuff the thigh's outer shell reaches |x| ≈ 1.2
      // and the claw starts at ≈ 1.4, so the gate sits in that gap.
      if (y > 2.1 && (ax > (y < 3.6 ? 1.3 : 1.05) || (ax > 0.85 && y > 4.0))) {
        const m = (p: V3): V3 => [s === "+1" ? p[0] : -p[0], p[1], p[2]];
        return nearestPart([x, y, z], [
          [`arm${s}`, [rig.shoulder[i], m([1.4, 5.05, -0.17]), rig.elbow[i]], 0.3],
          [`forearm${s}`, [rig.elbow[i], m([1.78, 3.6, -0.05]), rig.wrist[i], m([1.75, 2.3, 0.05])], 0.45],
        ]);
      }
      if (y < 0.62 && ax > 0.15) return `foot${s}`;
      if (y < rig.knee[0][1] && ax > 0.15) return `shin${s}`;
      if (y < 3.16 && ax > 0.18) return `thigh${s}`;
      return "upper";
    },
  },
  // Upright teal-accented robot with a box visor, articulated arms, dark fingers and long booted legs.
  buddy: {
    rig: {
      hip: [0, 3.05, 0], neck: [0, 5.45, 0], antenna: [0, 8.02, 0], antennaBall: { at: [0, 8.5, 0], radius: 0.17 },
      shoulder: [[-1.12, 4.86, 0], [1.12, 4.86, 0]], elbow: [[-1.55, 4.02, 0.02], [1.55, 4.02, 0.02]], wrist: [[-1.96, 2.82, 0.15], [1.96, 2.82, 0.15]],
      hipJoint: [[-0.62, 2.82, 0], [0.62, 2.82, 0]], knee: [[-0.64, 2.1, 0], [0.64, 2.1, 0]], ankle: [[-0.64, 0.67, 0], [0.64, 0.67, 0]],
    },
    face: { centre: [0, 6.66], width: 2.28, height: 1.35, squircle: 3.2, inset: 0 },
    band: 0.14,
    smooth: 0.45,
    shoulderReach: 0.8,
    shoulderAxis: [1, -0.25, 0],
    triangles: 80000,
    strictSeams: true,
    classify(p, rig, lum) {
      const [x, y, z] = p;
      if (y > 8.03 && Math.hypot(x, z) < 0.3) return "antenna";
      if (y > 5.42) return "head";

      const side = sideOf(x), i = side === "+1" ? 1 : 0, ax = Math.abs(x);
      if (ax > 0.8 && y > 2.2 && y < 5.2) {
        const s = side;
        const handEnd: V3 = [rig.wrist[i][0] * 1.08, 1.75, 0.35];
        const nearest = nearestPart(p, [
          ["upper", [rig.hip, rig.neck], 1.25],
          [`arm${s}`, [rig.shoulder[i], rig.elbow[i]], 0.58],
          [`forearm${s}`, [rig.elbow[i], rig.wrist[i], handEnd], 0.62],
        ]);
        if (nearest !== "upper") {
          const toWrist = norm(sub(rig.wrist[i], rig.elbow[i]));
          const toShoulder = norm(sub(rig.shoulder[i], rig.elbow[i]));
          return dot(sub(p, rig.elbow[i]), sub(toWrist, toShoulder)) > 0 ? `forearm${s}` : `arm${s}`;
        }
      }
      if (ax > 1.35 && y > 1.3 && y <= 2.5 && lum < 0.42) return `forearm${side}`;

      // Keep the lower torso on upper; the two thigh shells separate clearly below its hem.
      if (y < 0.42 && ax > 0.18) return `foot${side}`;
      if (y < rig.knee[0][1] && ax > 0.36) return `shin${side}`;
      if (y < rig.hipJoint[0][1] && ax > 0.46) return `thigh${side}`;
      return "upper";
    },
  },
  // Chibi armoured hero (measured on .ui-check/glb-bot/grid-jarvis-*.png at yaw 50 and vertex slices). The source is
  // turned ~50° toward −X; once squared up, the body's centre line is x ≈ −1.0 because the +X arm points out sideways
  // and forward (finger gun), while the −X arm hangs bent with a fist by the hip. Wide stance, the +X leg set back.
  // No antenna: its pivot sits inside the helmet and the glow cap is skipped (radius 0).
  jarvis: {
    yaw: 50,
    // Stand on the hip axis so turns spin the body in place (the bounding box is centred 1.05 off it).
    origin: [-1.05, -0.2],
    rig: {
      hip: [-1.05, 2.95, -0.2], neck: [-0.92, 5.72, -0.3], antenna: [-0.92, 8.2, -0.21], antennaBall: { at: [-0.92, 8.2, -0.21], radius: 0 },
      shoulder: [[-2.17, 5.4, -0.55], [0.25, 5.42, -0.82]], elbow: [[-2.8, 4.78, -0.6], [1.3, 5.12, -0.5]], wrist: [[-2.95, 3.8, -0.05], [2.12, 5.03, 0.45]],
      hipJoint: [[-1.6, 2.8, -0.15], [-0.5, 2.8, -0.3]], knee: [[-2.03, 2.05, -0.3], [0.05, 2.05, -0.55]], ankle: [[-2.45, 0.75, -0.5], [0.5, 0.75, -0.75]],
    },
    // Iron-Man faceplate: no glass. The screen is the band across the painted cyan eye slits low on the mask (the
    // helmet is pitched down and turned ~22° toward the pointing hand); BOT_FACES draws slit eyes on them.
    face: { centre: [-0.62, 6.17], width: 1.75, height: 0.72, squircle: 3, inset: 0 },
    glow: (r, g, b) => (g > 150 && b > 160 ? Math.max(0, Math.min(1, (b - r - 15) / 40)) : 0),
    band: 0.15,
    smooth: 0.6,
    triangles: 75000,
    strictSeams: true,
    // Both arms leave the torso sideways; along shoulder → elbow the torso side under the −X pad peeled off in flaps.
    shoulderAxis: [1, -0.25, 0],
    shoulderReach: 0.45,
    classify(p, rig) {
      const [x, y, z] = p;
      // The shoulder pads end below y 6.0 and the helmet's lower shell starts above 6.1; in the middle the helmet sits
      // on the collar from y ≈ 5.82.
      if (y > 6.05 || (y > 5.82 && x > -1.85 && x < 0)) return "head";
      const arm = (i: 0 | 1): Bone => {
        const s = i ? "+1" : "-1";
        const toWrist = norm(sub(rig.wrist[i], rig.elbow[i])), toShoulder = norm(sub(rig.shoulder[i], rig.elbow[i]));
        return dot(sub(p, rig.elbow[i]), sub(toWrist, toShoulder)) > 0 ? `forearm${s}` : `arm${s}`;
      };
      // Torso sides: x ≈ −2.15 and 0.0 (the chest is centred on x ≈ −1.0). The shoulder pads reach in over the
      // collar to x ≈ −1.8 and 0.0; split across the pad, its inner half stayed on the torso and tore as the arm lifted.
      if (y > 3.0 && (x < -2.3 || (y > 5.0 && x < -2.05) || (y > 5.4 && x < -1.8))) {
        // The −X forearm is a big gauntlet (rim up to y ≈ 5.1, tilted) that the thin grey upper arm plunges into:
        // its inner wall lies on the upper-arm side of the elbow's bisector plane, so split by capsule instead.
        // Also the gauntlet's inner back rim, which sits against the shoulder's underside: on the forearm, its weight
        // leaked into the shoulder back and tore it when the forearm rose.
        if (y > 5.12 || x > -2.3 || (x > -2.5 && y > 4.8 && z < -0.7)) return "arm-1";
        return nearestPart(p, [["arm-1", [rig.shoulder[0], rig.elbow[0]], 0.3], ["forearm-1", [[-2.95, 4.8, -0.7], rig.wrist[0], [-2.97, 3.4, 0.05]], 0.6]]);
      }
      if (y > 4.4 && (x > 0.3 || (y > 4.9 && x > 0.08) || (y > 5.4 && x > -0.05))) return arm(1);
      const s = sideOf(x + 1.05);
      if (y < 0.65) return `foot${s}`;
      if (y < rig.knee[0][1]) return `shin${s}`;
      // The crotch opens at y ≈ 2.55; above it the pelvis plate stays on the torso between the hip joints.
      if (y < 2.55 || (y < 2.85 && Math.abs(x + 1.05) > 0.45)) return `thigh${s}`;
      return "upper";
    },
  },
};

// ---------- GLB decoding ----------

type Accessor = { bufferView: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string };
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const READ: Record<number, [number, (d: DataView, o: number) => number, number]> = {
  5120: [1, (d, o) => d.getInt8(o), 127], 5121: [1, (d, o) => d.getUint8(o), 255],
  5122: [2, (d, o) => d.getInt16(o, true), 32767], 5123: [2, (d, o) => d.getUint16(o, true), 65535],
  5125: [4, (d, o) => d.getUint32(o, true), 4294967295], 5126: [4, (d, o) => d.getFloat32(o, true), 1],
};

function readGlb(file: string) {
  const buf = readFileSync(file);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString("utf8"));
  const binStart = 20 + jsonLength + 8;
  const bin = new DataView(buf.buffer, buf.byteOffset + binStart, view.getUint32(20 + jsonLength, true));
  const accessor = (index: number) => {
    const a: Accessor = json.accessors[index];
    const bv = json.bufferViews[a.bufferView];
    const n = COMPONENTS[a.type];
    const [size, get, max] = READ[a.componentType];
    const stride = bv.byteStride ?? size * n;
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = new Float64Array(a.count * n);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) {
      const v = get(bin, base + i * stride + c * size);
      out[i * n + c] = a.normalized ? Math.max(v / max, -1) : v;
    }
    return out;
  };
  const image = (index: number) => {
    const bv = json.bufferViews[json.images[index].bufferView];
    return new Uint8Array(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength);
  };
  return { json, accessor, image };
}

/** World-space origin of every node (full TRS / matrix chain), for a rigged file's joint positions. */
function nodeWorldPositions(json: any): V3[] {
  const parents = new Map<number, number>();
  json.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parents.set(c, i)));
  const local = (n: any): number[] => {
    if (n.matrix) return n.matrix;
    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
    return [
      (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
      tx, ty, tz, 1,
    ];
  };
  // Column-major product a × b.
  const mul = (a: number[], b: number[]) => Array.from({ length: 16 }, (_, k) => { const c = Math.floor(k / 4), r = k % 4; return [0, 1, 2, 3].reduce((sum, i) => sum + a[i * 4 + r] * b[c * 4 + i], 0); });
  const world = (i: number): number[] => { const p = parents.get(i); return p === undefined ? local(json.nodes[i]) : mul(world(p), local(json.nodes[i])); };
  return json.nodes.map((_: any, i: number) => { const m = world(i); return [m[12], m[13], m[14]] as V3; });
}

/** World matrix (column-major 4×4 as TRS only; Meshy exports carry translation + uniform scale). */
function nodeTransform(json: any, meshNode: number) {
  const parents = new Map<number, number>();
  json.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parents.set(c, i)));
  const chain: any[] = [];
  for (let i: number | undefined = meshNode; i !== undefined; i = parents.get(i)) chain.unshift(json.nodes[i]);
  return (p: V3): V3 => {
    let q: V3 = [...p];
    for (const n of chain.slice().reverse()) {
      if (n.rotation && (n.rotation[0] || n.rotation[1] || n.rotation[2])) throw new Error("node rotation not supported");
      const s = n.scale ?? [1, 1, 1];
      const t = n.translation ?? [0, 0, 0];
      q = [q[0] * s[0] + t[0], q[1] * s[1] + t[1], q[2] * s[2] + t[2]];
    }
    return q;
  };
}

// ---------- bake ----------

function smoothstep(u: number) { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); }

async function bake(name: string) {
  const config = CONFIG[name];
  // A corrected rig (scripts/export-rigged.ts, edited in Blender) takes precedence over the original model.
  const riggedFile = join(SRC, `${name}-rigged.glb`);
  const { json, accessor, image } = readGlb(existsSync(riggedFile) ? riggedFile : join(SRC, `${name}.glb`));
  const meshNode = json.nodes.findIndex((n: any) => n.mesh !== undefined);
  const primitive = json.meshes[json.nodes[meshNode].mesh].primitives[0];
  const material = json.materials[primitive.material ?? 0];
  const transform = nodeTransform(json, meshNode);
  const rawPos = accessor(primitive.attributes.POSITION);
  const rawNrm = accessor(primitive.attributes.NORMAL);
  // Untextured GLBs may omit UVs entirely. A zero UV is harmless when no material texture is sampled;
  // the runtime face patch uses its own planar coordinates.
  const rawUv = primitive.attributes.TEXCOORD_0 === undefined
    ? new Float64Array((rawPos.length / 3) * 2)
    : accessor(primitive.attributes.TEXCOORD_0);
  let indices = Array.from(accessor(primitive.indices));
  let count = rawPos.length / 3;
  // A skin whose joints are named after BONES (scripts/export-rigged.ts) is used as-is: its weights replace the
  // labels, joint bands and smoothing, and its joint positions replace the configured pivots.
  const skin = json.skins?.[json.nodes[meshNode].skin ?? 0];
  const skinNames: string[] = skin?.joints.map((j: number) => json.nodes[j].name) ?? [];
  const rigged = Boolean(skin && primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined && skinNames.every(n => (BONES as readonly string[]).includes(n)));
  if (rigged) console.log(`  rigged input: ${skinNames.length} named bones, weights and pivots from the file`);

  // glTF is right-handed; Babylon's loader mirrors X. Do the same (and flip the winding) so the bot faces +Z.
  const yc = Math.cos((config.yaw ?? 0) * Math.PI / 180), ys = Math.sin((config.yaw ?? 0) * Math.PI / 180);
  const turn = (x: number, y: number, z: number): V3 => [x * yc + z * ys, y, -x * ys + z * yc];
  let pos = new Float64Array(count * 3);
  let nrm = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const p = transform([rawPos[3 * i], rawPos[3 * i + 1], rawPos[3 * i + 2]]);
    pos.set(turn(-p[0], p[1], p[2]), 3 * i);
    const n = norm(turn(-rawNrm[3 * i], rawNrm[3 * i + 1], rawNrm[3 * i + 2]));
    nrm.set(n, 3 * i);
  }
  for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
  // Normalise: floor at 0, centred in X/Z, HEIGHT tall.
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], pos[3 * i + c]); max[c] = Math.max(max[c], pos[3 * i + c]); }
  const scale = HEIGHT / (max[1] - min[1]);
  for (let i = 0; i < count; i++) {
    pos[3 * i] = (pos[3 * i] - (min[0] + max[0]) / 2) * scale;
    pos[3 * i + 1] = (pos[3 * i + 1] - min[1]) * scale;
    pos[3 * i + 2] = (pos[3 * i + 2] - (min[2] + max[2]) / 2) * scale;
  }
  const normalise = (raw: V3): V3 => { const p = turn(-raw[0], raw[1], raw[2]); return [(p[0] - (min[0] + max[0]) / 2) * scale, (p[1] - min[1]) * scale, (p[2] - (min[2] + max[2]) / 2) * scale]; };
  // KHR_texture_transform (offset + scale, shared by every texture of the baked material).
  const tt = material.pbrMetallicRoughness?.baseColorTexture?.extensions?.KHR_texture_transform ?? {};
  const [ou, ov] = tt.offset ?? [0, 0];
  const [su, sv] = tt.scale ?? [1, 1];
  let uv = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) { uv[2 * i] = ou + su * rawUv[2 * i]; uv[2 * i + 1] = ov + sv * rawUv[2 * i + 1]; }

  // A rigged file is already at the baked density, merged, and carries per-vertex skinning, so it is kept as is.
  if (!rigged) {
    ({ count, pos, nrm, uv, indices } = weld(count, pos, nrm, uv, indices, Boolean(primitive.attributes.TEXCOORD_0)));
    if (config.triangles && indices.length / 3 > config.triangles) ({ count, pos, nrm, uv, indices } = await simplify(count, pos, nrm, uv, indices, config.triangles));
  }

  // Hard labels, then smooth blends across each joint between parent and child parts.
  const boneIndex = (b: Bone) => BONES.indexOf(b);
  let rig = config.rig;
  let fileSkin: { joints: Uint8Array; weights: Uint8Array } | undefined;
  if (rigged) {
    const world = nodeWorldPositions(json);
    const at = (bone: string, fallback: V3): V3 => { const k = skinNames.indexOf(bone); return k < 0 ? fallback : normalise(world[skin.joints[k]]); };
    const sides = (key: "shoulder" | "elbow" | "hipJoint" | "knee" | "ankle", part: string): [V3, V3] => [at(`${part}-1`, rig[key][0]), at(`${part}+1`, rig[key][1])];
    rig = {
      ...rig, hip: at("upper", rig.hip), neck: at("head", rig.neck), antenna: at("antenna", rig.antenna),
      shoulder: sides("shoulder", "arm"), elbow: sides("elbow", "forearm"), hipJoint: sides("hipJoint", "thigh"), knee: sides("knee", "shin"), ankle: sides("ankle", "foot"),
    };
    // Three strongest influences per vertex, as BONES indices.
    const rawJoints = accessor(primitive.attributes.JOINTS_0), rawWeights = accessor(primitive.attributes.WEIGHTS_0);
    const out = { joints: new Uint8Array(count * 4), weights: new Uint8Array(count * 4) };
    for (let i = 0; i < count; i++) {
      const top = [0, 1, 2, 3].map(c => ({ bone: boneIndex(skinNames[rawJoints[4 * i + c]] as Bone), w: rawWeights[4 * i + c] })).sort((a, b) => b.w - a.w).slice(0, 3).filter((e, k) => k === 0 || e.w > 0.004);
      const sum = top.reduce((s, e) => s + e.w, 0) || 1;
      const q = top.map(e => Math.round(e.w / sum * 255));
      q[0] = 255 - q.slice(1).reduce((s, v) => s + v, 0);
      top.forEach((e, k) => { out.joints[4 * i + k] = e.bone; out.weights[4 * i + k] = q[k]; });
    }
    fileSkin = out;
  }
  let lum = await sampleLuminance(json, image, material, uv, count);
  let label = new Uint8Array(count);
  for (let i = 0; i < count; i++) label[i] = fileSkin ? fileSkin.joints[4 * i] : boneIndex(config.classify([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], rig, lum[i]));
  type Joint = { parent: Bone; child: Bone; pivot: V3; axis: V3; reach: number };
  const joints: Joint[] = [
    { parent: "upper", child: "head", pivot: rig.neck, axis: [0, 1, 0], reach: config.neckReach ?? 1.2 },
    { parent: "head", child: "antenna", pivot: rig.antenna, axis: [0, 1, 0], reach: 0.5 },
  ];
  for (const [i, s] of [[0, "-1"], [1, "+1"]] as const) {
    const shoulderAxis: V3 | undefined = config.shoulderAxis && [config.shoulderAxis[0] * (i ? 1 : -1), config.shoulderAxis[1], config.shoulderAxis[2]];
    joints.push({ parent: "upper", child: `arm${s}`, pivot: rig.shoulder[i], axis: norm(shoulderAxis ?? sub(rig.elbow[i], rig.shoulder[i])), reach: config.shoulderReach ?? 0.6 });
    // strictSeams splits arm from forearm on the elbow's bisector plane (see vally's classify); blend across that
    // plane too, or a sharply folded elbow leaves the label boundary outside the band.
    const forearmAxis = norm(sub(rig.wrist[i], rig.elbow[i]));
    const elbowAxis = config.strictSeams ? norm(sub(forearmAxis, norm(sub(rig.shoulder[i], rig.elbow[i])))) : forearmAxis;
    joints.push({ parent: `arm${s}`, child: `forearm${s}`, pivot: rig.elbow[i], axis: elbowAxis, reach: 0.6 });
    joints.push({ parent: "upper", child: `thigh${s}`, pivot: rig.hipJoint[i], axis: norm(sub(rig.knee[i], rig.hipJoint[i])), reach: 0.6 });
    joints.push({ parent: `thigh${s}`, child: `shin${s}`, pivot: rig.knee[i], axis: norm(sub(rig.ankle[i], rig.knee[i])), reach: 0.7 });
    joints.push({ parent: `shin${s}`, child: `foot${s}`, pivot: rig.ankle[i], axis: [0, -1, 0], reach: 0.8 });
  }
  let skinJoints = new Uint8Array(count * 4);
  let skinWeights = new Uint8Array(count * 4);
  if (fileSkin) ({ joints: skinJoints, weights: skinWeights } = fileSkin);
  else for (let i = 0; i < count; i++) {
    const p: V3 = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
    let a = label[i], b = label[i], wb = 0;
    for (const j of joints) {
      const pi = boneIndex(j.parent), ci = boneIndex(j.child);
      if (label[i] !== pi && label[i] !== ci) continue;
      const d = sub(p, j.pivot);
      const s = dot(d, j.axis);
      const lateral = len(sub(d, j.axis.map(v => v * s) as V3));
      if (Math.abs(s) > config.band || lateral > j.reach) continue;
      a = pi; b = ci; wb = smoothstep((s + config.band) / (2 * config.band));
      break;
    }
    const w = Math.round(wb * 255);
    skinJoints.set([a, b, 0, 0], 4 * i);
    skinWeights.set([255 - w, w, 0, 0], 4 * i);
  }

  // Where two parts that share a joint may blend: near its pivot (elsewhere they merely touch; see strictSeams).
  if (config.smooth && !rigged) ({ skinJoints, skinWeights } = smoothWeights(count, pos, indices, skinJoints, skinWeights, label, joints.map(j => ({ pair: [boneIndex(j.parent), boneIndex(j.child)], pivot: j.pivot, limit: Math.max(config.smoothingReach ?? 0.9, j.reach * 1.5) })), config.smooth));

  // Triangles spanning parts that no joint connects tear apart when either part moves; report them.
  const linked = new Set(joints.flatMap(j => [`${j.parent}|${j.child}`, `${j.child}|${j.parent}`]));
  const torn = new Map<string, { n: number; at: V3 }>();
  for (let t = 0; t < indices.length; t += 3) {
    const ls = [label[indices[t]], label[indices[t + 1]], label[indices[t + 2]]];
    for (const [a, b] of [[0, 1], [1, 2], [0, 2]]) {
      if (ls[a] === ls[b] || linked.has(`${BONES[ls[a]]}|${BONES[ls[b]]}`)) continue;
      const key = [BONES[ls[a]], BONES[ls[b]]].sort().join(" × ");
      const e = torn.get(key) ?? { n: 0, at: [pos[3 * indices[t]], pos[3 * indices[t] + 1], pos[3 * indices[t] + 2]] };
      e.n++;
      torn.set(key, e);
    }
  }
  if (torn.size) console.log("  bridges dropped:", [...torn].map(([k, e]) => `${k} ${e.n} @ ${e.at.map(v => v.toFixed(2)).join(",")}`).join("; "));
  // Meshy welds touching parts (hands to thighs, boot to boot) with thin bridges; they'd stretch into streaks. A
  // rigged file's weights are authoritative, so it keeps every triangle.
  if (!rigged) indices = indices.filter((_, k, all) => {
    const t = k - (k % 3);
    const ls = [label[all[t]], label[all[t + 1]], label[all[t + 2]]];
    if ([[0, 1], [1, 2], [0, 2]].every(([a, b]) => ls[a] === ls[b] || linked.has(`${BONES[ls[a]]}|${BONES[ls[b]]}`))) return true;
    // strictSeams reassigns bridges below (welded contact, like Vally's hand on its body) unless `dropBridges`: on
    // Meshy they span gaps (claw tips to the thighs) and would ride along with the limb as slivers.
    return Boolean(config.strictSeams && !config.dropBridges);
  });
  if (config.strictSeams && !rigged) {
    // A weld triangle (parts that touch away from their joint) goes wholly to its most-parent part,
    // with the other vertices duplicated onto that bone: the surface stays closed at rest and the triangle moves
    // rigidly instead of stretching into a sheet when the limb swings. A cross-part edge is a joint seam only if
    // the parts share a joint and the edge lies near its pivot (the same rule smoothWeights uses to blend).
    const seams = joints.map(j => ({ a: boneIndex(j.parent), b: boneIndex(j.child), pivot: j.pivot, limit: Math.max(config.smoothingReach ?? 0.9, j.reach * 1.5) }));
    const shares = (i: number, j: number) => {
      const mid: V3 = [(pos[3 * i] + pos[3 * j]) / 2, (pos[3 * i + 1] + pos[3 * j + 1]) / 2, (pos[3 * i + 2] + pos[3 * j + 2]) / 2];
      return seams.some(s => ((s.a === label[i] && s.b === label[j]) || (s.b === label[i] && s.a === label[j])) && len(sub(mid, s.pivot)) <= s.limit);
    };
    const P = Array.from(pos), N = Array.from(nrm), U = Array.from(uv), J = Array.from(skinJoints), Wt = Array.from(skinWeights), L = Array.from(label);
    const copies = new Map<string, number>(), lumExtra: number[] = [];
    let welds = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const v = [indices[t], indices[t + 1], indices[t + 2]];
      if ([[0, 1], [1, 2], [0, 2]].every(([a, b]) => L[v[a]] === L[v[b]] || shares(v[a], v[b]))) continue;
      welds++;
      // The most-parent part (lowest BONES index: the torso over an arm, the arm over its forearm): where a limb is
      // sculpted fused to the body, the body keeps the contact surface and stays whole when the limb pulls away.
      const ls = v.map(i => L[i]);
      // An ancestor of the other corners' parts if there is one (the torso over an arm: the body keeps the contact
      // surface); between unrelated parts (a hand resting on a thigh) the majority, so neither drags a scrap of the
      // other along. The lowest index was wrong there: forearm sorts before thigh and carried thigh pieces.
      const ancestors = (b: number) => { const out = [b]; for (let p = PARENT[BONES[b]]; p; p = PARENT[p]) out.push(BONES.indexOf(p)); return out; };
      const owner = ls.find(l => ls.every(o => ancestors(o).includes(l))) ?? ls.find((l, c) => ls.indexOf(l) !== c) ?? Math.min(...ls);
      for (let c = 0; c < 3; c++) {
        const i = v[c];
        if (L[i] === owner && !Wt[4 * i + 1]) continue;
        const key = `${i}|${owner}`;
        let j = copies.get(key);
        if (j === undefined) {
          j = L.length;
          copies.set(key, j);
          P.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]); N.push(N[3 * i], N[3 * i + 1], N[3 * i + 2]); U.push(U[2 * i], U[2 * i + 1]);
          J.push(owner, owner, 0, 0); Wt.push(255, 0, 0, 0); L.push(owner); lumExtra.push(lum[i]);
        }
        indices[t + c] = j;
      }
    }
    count = L.length;
    pos = Float64Array.from(P); nrm = Float64Array.from(N); uv = Float64Array.from(U);
    skinJoints = Uint8Array.from(J); skinWeights = Uint8Array.from(Wt); label = Uint8Array.from(L);
    lum = Float64Array.from([...lum, ...lumExtra]) as typeof lum;
    if (welds) console.log(`  welds reassigned: ${welds}`);
  }

  // Close the holes the dropped bridges leave (and the patches where a fused hand used to be) with flat caps.
  ({ count, pos, nrm, uv, skinJoints, skinWeights, indices } = capHoles({ count, pos, nrm, uv, skinJoints, skinWeights, indices }, lum, label));

  // Shifted copy for packing only: scrub and the visor trace below still read measured coordinates.
  const [ox, oz] = config.origin ?? [0, 0];
  const packed = Float64Array.from(pos, (v, k) => v - (k % 3 === 0 ? ox : k % 3 === 2 ? oz : 0));
  const move = (p: V3): V3 => [p[0] - ox, p[1], p[2] - oz];
  const pair = (ps: [V3, V3]): [V3, V3] => [move(ps[0]), move(ps[1])];
  const packedRig: Rig = {
    hip: move(rig.hip), neck: move(rig.neck), antenna: move(rig.antenna), antennaBall: { ...rig.antennaBall, at: move(rig.antennaBall.at) },
    shoulder: pair(rig.shoulder), elbow: pair(rig.elbow), wrist: pair(rig.wrist), hipJoint: pair(rig.hipJoint), knee: pair(rig.knee), ankle: pair(rig.ankle),
  };

  // Quantise and pack.
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) { bmin[c] = Math.min(bmin[c], packed[3 * i + c]); bmax[c] = Math.max(bmax[c], packed[3 * i + c]); }
  const umin = [Infinity, Infinity], umax = [-Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let c = 0; c < 2; c++) { umin[c] = Math.min(umin[c], uv[2 * i + c]); umax[c] = Math.max(umax[c], uv[2 * i + c]); }
  const qPos = new Uint16Array(count * 3);
  for (let i = 0; i < count * 3; i++) qPos[i] = Math.round((packed[i] - bmin[i % 3]) / (bmax[i % 3] - bmin[i % 3] || 1) * 65535);
  const qNrm = new Int8Array(count * 4);
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) qNrm[4 * i + c] = Math.round(nrm[3 * i + c] * 127);
  const qUv = new Uint16Array(count * 2);
  for (let i = 0; i < count * 2; i++) qUv[i] = Math.round((uv[i] - umin[i % 2]) / (umax[i % 2] - umin[i % 2] || 1) * 65535);

  // Textures: base colour, metallic-roughness, normal and emissive when present.
  const pbr = material.pbrMetallicRoughness ?? {};
  const slots: Array<[string, any]> = [["color", pbr.baseColorTexture], ["mr", pbr.metallicRoughnessTexture], ["normal", material.normalTexture], ["emissive", material.emissiveTexture]];
  const textures: Record<string, string> = {};
  mkdirSync(OUT, { recursive: true });
  const sharp = (await import("sharp")).default;
  for (const [slot, ref] of slots) {
    if (!ref) continue;
    const tex = json.textures[ref.index];
    let input = sharp(Buffer.from(image(tex.extensions?.EXT_texture_webp?.source ?? tex.source)));
    if (slot === "color" && config.scrub && !rigged) input = await scrubTexture(input, config, label, pos, uv, indices);
    await input.resize(TEXTURE_PX, TEXTURE_PX).webp({ quality: 88 }).toFile(join(OUT, `${name}-${slot}.webp`));
    textures[slot] = `${name}-${slot}.webp`;
  }
  if (config.glow && !textures.emissive && textures.color) {
    const { data, info } = await sharp(join(OUT, `${name}-color.webp`)).raw().toBuffer({ resolveWithObject: true });
    const lit = Buffer.alloc(info.width * info.height * 3);
    for (let i = 0, o = 0; i < lit.length; i += 3, o += info.channels) {
      const k = config.glow(data[o], data[o + 1], data[o + 2]);
      for (let c = 0; c < 3; c++) lit[i + c] = Math.round(data[o + c] * k);
    }
    await sharp(lit, { raw: { width: info.width, height: info.height, channels: 3 } }).webp({ quality: 88 }).toFile(join(OUT, `${name}-emissive.webp`));
    textures.emissive = `${name}-emissive.webp`;
  }

  // Version 2: one interleaved 20-byte vertex stream (position u16×3, normal i8×4, uv u16×2, joints u8×3,
  // weights u8×3) and the index list, both meshopt-compressed after a cache/fetch reorder.
  const { MeshoptEncoder } = await import("meshoptimizer");
  await MeshoptEncoder.ready;
  const [order, unique] = MeshoptEncoder.reorderMesh(Uint32Array.from(indices), true, false);
  const STRIDE = 20;
  const vertexData = new Uint8Array(unique * STRIDE);
  const vertexView = new DataView(vertexData.buffer);
  for (let i = 0; i < count; i++) {
    const o = order[i];
    if (o === 0xffffffff || o >= unique) continue;
    const at = o * STRIDE;
    for (let c = 0; c < 3; c++) vertexView.setUint16(at + 2 * c, qPos[3 * i + c], true);
    for (let c = 0; c < 4; c++) vertexView.setInt8(at + 6 + c, qNrm[4 * i + c]);
    for (let c = 0; c < 2; c++) vertexView.setUint16(at + 10 + 2 * c, qUv[2 * i + c], true);
    for (let c = 0; c < 3; c++) { vertexData[at + 14 + c] = skinJoints[4 * i + c]; vertexData[at + 17 + c] = skinWeights[4 * i + c]; }
  }
  const reordered = Uint32Array.from(indices, i => order[i]);
  const encodedVertices = MeshoptEncoder.encodeVertexBuffer(vertexData, unique, STRIDE);
  const encodedIndices = MeshoptEncoder.encodeIndexBuffer(new Uint8Array(reordered.buffer), reordered.length, 4);

  const header = {
    name, version: 2, height: HEIGHT, bones: BONES, vertexCount: unique, indexCount: indices.length, index32: unique > 65535,
    stride: STRIDE, vertexBytes: encodedVertices.length, indexBytes: encodedIndices.length,
    position: { min: bmin, max: bmax }, uv: { min: umin, max: umax },
    rig: packedRig, face: shiftFace(config.face.recess ? recessFace(pos, indices, config.face) : config.face, ox, oz), textures,
    emissive: material.emissiveFactor ?? (textures.emissive ? [1, 1, 1] : null),
  };
  const parts = [encodedVertices, encodedIndices];
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const pad4 = (n: number) => (n + 3) & ~3;
  const offsets: number[] = [];
  let at = pad4(4 + headerBytes.length);
  for (const part of parts) { offsets.push(at); at = pad4(at + part.length); }
  const outBuf = new Uint8Array(at);
  new DataView(outBuf.buffer).setUint32(0, headerBytes.length, true);
  outBuf.set(headerBytes, 4);
  parts.forEach((part, i) => outBuf.set(part, offsets[i]));
  writeFileSync(join(OUT, `${name}.bin`), outBuf);
  const counts = new Map<number, number>();
  for (let i = 0; i < count; i++) counts.set(label[i], (counts.get(label[i]) ?? 0) + 1);
  console.log(`${name}: ${count} vertices, ${indices.length / 3} triangles, bin ${(outBuf.length / 1e6).toFixed(2)} MB`);
  console.log("  parts:", [...counts].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${BONES[b]} ${n}`).join(", "));
}

/** Base-colour luminance (0..1) at each vertex's UV, for telling black hands from white shell. */
async function sampleLuminance(json: any, image: (i: number) => Uint8Array, material: any, uv: Float64Array, count: number) {
  const out = new Float32Array(count).fill(1);
  const ref = material.pbrMetallicRoughness?.baseColorTexture;
  if (!ref) return out;
  const tex = json.textures[ref.index];
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(Buffer.from(image(tex.extensions?.EXT_texture_webp?.source ?? tex.source))).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const wrap = (v: number) => v - Math.floor(v);
  for (let i = 0; i < count; i++) {
    const x = Math.min(info.width - 1, Math.floor(wrap(uv[2 * i]) * info.width));
    const y = Math.min(info.height - 1, Math.floor(wrap(uv[2 * i + 1]) * info.height));
    const k = (y * info.width + x) * 3;
    out[i] = (0.3 * data[k] + 0.59 * data[k + 1] + 0.11 * data[k + 2]) / 255;
  }
  return out;
}

/** Decimate to about `triangles` (UV seams and normals kept), then drop unused vertices. */
/**
 * Merge vertices that share a position (and UV, when textured) and whose normals are within ~25°, averaging their
 * normals. Exporters often split vertices on tiny normal differences (Vally: 124k vertices on 60k positions); merged,
 * the mesh is smaller, shades smoothly, and simplifies better (split vertices are locked seams to the simplifier).
 * Real hard edges and UV seams stay split.
 */
function weld(count: number, pos: Float64Array, nrm: Float64Array, uv: Float64Array, indices: number[], textured: boolean) {
  const buckets = new Map<string, number[]>();
  const remap = new Int32Array(count);
  const keep: number[] = [];
  const sum: number[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos[3 * i] * 1e4)},${Math.round(pos[3 * i + 1] * 1e4)},${Math.round(pos[3 * i + 2] * 1e4)}` +
      (textured ? `|${Math.round(uv[2 * i] * 1e5)},${Math.round(uv[2 * i + 1] * 1e5)}` : "");
    const list = buckets.get(key) ?? [];
    let j = list.find(k => nrm[3 * i] * nrm[3 * keep[k]] + nrm[3 * i + 1] * nrm[3 * keep[k] + 1] + nrm[3 * i + 2] * nrm[3 * keep[k] + 2] > 0.9);
    if (j === undefined) {
      j = keep.length;
      keep.push(i);
      sum.push(0, 0, 0);
      list.push(j);
      buckets.set(key, list);
    }
    remap[i] = j;
    for (let c = 0; c < 3; c++) sum[3 * j + c] += nrm[3 * i + c];
  }
  const n = keep.length;
  const p = new Float64Array(n * 3), q = new Float64Array(n * 3), u = new Float64Array(n * 2);
  keep.forEach((i, j) => {
    p.set(pos.subarray(3 * i, 3 * i + 3), 3 * j);
    u.set(uv.subarray(2 * i, 2 * i + 2), 2 * j);
    const l = Math.hypot(sum[3 * j], sum[3 * j + 1], sum[3 * j + 2]) || 1;
    q.set([sum[3 * j] / l, sum[3 * j + 1] / l, sum[3 * j + 2] / l], 3 * j);
  });
  // Drop triangles that collapsed onto a welded vertex.
  const out: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a !== b && b !== c && a !== c) out.push(a, b, c);
  }
  console.log(`  welded ${count} → ${n} vertices`);
  return { count: n, pos: p, nrm: q, uv: u, indices: out };
}

async function simplify(count: number, pos: Float64Array, nrm: Float64Array, uv: Float64Array, indices: number[], triangles: number) {
  const { MeshoptSimplifier } = await import("meshoptimizer");
  await MeshoptSimplifier.ready;
  const [kept, error] = MeshoptSimplifier.simplifyWithAttributes(Uint32Array.from(indices), Float32Array.from(pos), 3, Float32Array.from(nrm), 3, [0.4, 0.4, 0.4], null, triangles * 3, 0.02);
  const remap = new Int32Array(count).fill(-1);
  let n = 0;
  for (const i of kept) if (remap[i] < 0) remap[i] = n++;
  const p = new Float64Array(n * 3), q = new Float64Array(n * 3), u = new Float64Array(n * 2);
  for (let i = 0; i < count; i++) {
    const j = remap[i];
    if (j < 0) continue;
    p.set(pos.subarray(3 * i, 3 * i + 3), 3 * j); q.set(nrm.subarray(3 * i, 3 * i + 3), 3 * j); u.set(uv.subarray(2 * i, 2 * i + 2), 2 * j);
  }
  console.log(`  simplified ${indices.length / 3} → ${kept.length / 3} triangles (error ${error.toFixed(4)})`);
  return { count: n, pos: p, nrm: q, uv: u, indices: Array.from(kept, i => remap[i]) };
}

type MeshArrays = { count: number; pos: Float64Array; nrm: Float64Array; uv: Float64Array; skinJoints: Uint8Array; skinWeights: Uint8Array; indices: number[] };

/**
 * Cap every open boundary loop (the mesh is closed until bridges are dropped). Vertices are welded by position to
 * see the topology through UV seams; each loop gets a fan around its centroid on duplicated vertices that keep the
 * loop's skinning and share one UV (a loop vertex of median brightness), so the cap is a flat patch of nearby colour.
 */
function capHoles(m: MeshArrays, lum: Float32Array, label: Uint8Array): MeshArrays {
  const key = (i: number) => `${Math.round(m.pos[3 * i] * 2000)},${Math.round(m.pos[3 * i + 1] * 2000)},${Math.round(m.pos[3 * i + 2] * 2000)}`;
  const canon = new Int32Array(m.count);
  const seen = new Map<string, number>();
  for (let i = 0; i < m.count; i++) { const k = key(i); if (!seen.has(k)) seen.set(k, i); canon[i] = seen.get(k)!; }
  const edgeUse = new Map<string, number>();
  const directed = new Map<string, [number, number]>();
  for (let t = 0; t < m.indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = canon[m.indices[t + e]], b = canon[m.indices[t + (e + 1) % 3]];
    if (a === b) continue;
    const u = a < b ? `${a}|${b}` : `${b}|${a}`;
    edgeUse.set(u, (edgeUse.get(u) ?? 0) + 1);
    directed.set(u, [a, b]);
  }
  const next = new Map<number, number[]>();
  for (const [u, n] of edgeUse) if (n === 1) { const [a, b] = directed.get(u)!; next.set(a, [...(next.get(a) ?? []), b]); }
  const pos = Array.from(m.pos), nrm = Array.from(m.nrm), uv = Array.from(m.uv), joints = Array.from(m.skinJoints), weights = Array.from(m.skinWeights);
  const indices = m.indices.slice();
  let count = m.count, loops = 0;
  const add = (from: number, p: number[], n: number[], u: number[]) => {
    pos.push(...p); nrm.push(...n); uv.push(...u);
    joints.push(...m.skinJoints.subarray(4 * from, 4 * from + 4)); weights.push(...m.skinWeights.subarray(4 * from, 4 * from + 4));
    return count++;
  };
  while (next.size) {
    const start = next.keys().next().value!;
    const loop = [start];
    for (let v = start; ;) {
      const outs = next.get(v)!;
      const w = outs.shift()!;
      if (!outs.length) next.delete(v);
      if (w === start || loop.length > 400) break;
      if (!next.has(w)) break;
      loop.push(w);
      v = w;
    }
    if (loop.length < 3 || loop.length > 400) continue;
    // A loop bounded by two parts is the gap between them: cap each part's side on its own, or the cap would
    // stretch between the parts as they move apart.
    const first = loop.findIndex((v, k) => label[v] !== label[loop[(k + loop.length - 1) % loop.length]]);
    const runs: number[][] = [];
    if (first < 0) runs.push(loop);
    else for (let k = 0; k < loop.length; k++) {
      const v = loop[(first + k) % loop.length];
      if (!runs.length || label[v] !== label[runs[runs.length - 1][0]]) runs.push([]);
      runs[runs.length - 1].push(v);
    }
    for (const run of runs) if (run.length >= 3) { loops++; capFan(run); }
  }
  function capFan(loop: number[]) {
    const sorted = loop.slice().sort((a, b) => lum[a] - lum[b]);
    const pick = sorted[Math.floor(sorted.length / 2)];
    const capUv = [m.uv[2 * pick], m.uv[2 * pick + 1]];
    const centre = [0, 1, 2].map(c => loop.reduce((s, i) => s + m.pos[3 * i + c], 0) / loop.length);
    const normal = [0, 1, 2].map(c => loop.reduce((s, i) => s + m.nrm[3 * i + c], 0));
    const nl = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    const mid = add(pick, centre, normal.map(v => v / nl), capUv);
    const ring = loop.map(i => add(i, [m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]], [m.nrm[3 * i], m.nrm[3 * i + 1], m.nrm[3 * i + 2]], capUv));
    // Boundary edges run a→b with the existing triangle on their left; the cap winds the other way.
    for (let k = 0; k < ring.length; k++) indices.push(ring[(k + 1) % ring.length], ring[k], mid);
  }
  console.log(`  capped ${loops} holes`);
  return { count, pos: Float64Array.from(pos), nrm: Float64Array.from(nrm), uv: Float64Array.from(uv), skinJoints: Uint8Array.from(joints), skinWeights: Uint8Array.from(weights), indices };
}

/** Repaint dark texels inside `config.scrub` triangles with the triangle's own light shell colour (see BotConfig.scrub). */
async function scrubTexture(input: any, config: BotConfig, label: Uint8Array, pos: Float64Array, uv: Float64Array, indices: number[]) {
  const sharp = (await import("sharp")).default;
  const { data, info } = await input.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const lumAt = (k: number) => (0.3 * data[k] + 0.59 * data[k + 1] + 0.11 * data[k + 2]) / 255;
  let painted = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [i0, i1, i2] = [indices[t], indices[t + 1], indices[t + 2]];
    // Cap vertices (appended after the labelled ones) are flat-coloured already.
    if (Math.max(i0, i1, i2) >= label.length || label[i0] !== label[i1] || label[i1] !== label[i2]) continue;
    const centroid: V3 = [0, 1, 2].map(c => (pos[3 * i0 + c] + pos[3 * i1 + c] + pos[3 * i2 + c]) / 3) as V3;
    if (!config.scrub!(centroid, BONES[label[i0]])) continue;
    const p = [i0, i1, i2].map(i => [uv[2 * i] * W, uv[2 * i + 1] * H]);
    const minX = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0])) - 1), maxX = Math.min(W - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0])) + 1);
    const minY = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1])) - 1), maxY = Math.min(H - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1])) + 1);
    const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
    if (!area) continue;
    // Texels inside the triangle (with a one-texel margin so the UV seam edge is covered too).
    const texels: number[] = [];
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w1 = ((px - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (py - p[0][1])) / area;
      const w2 = ((p[1][0] - p[0][0]) * (py - p[0][1]) - (px - p[0][0]) * (p[1][1] - p[0][1])) / area;
      const margin = 1.5 / Math.sqrt(Math.abs(area));
      if (w1 >= -margin && w2 >= -margin && w1 + w2 <= 1 + margin) texels.push((y * W + x) * 3);
    }
    const light = texels.filter(k => lumAt(k) > 0.55);
    const fill = light.length ? [0, 1, 2].map(c => light.reduce((sum, k) => sum + data[k + c], 0) / light.length) : [226, 228, 232];
    for (const k of texels) if (lumAt(k) < 0.4) { data[k] = fill[0]; data[k + 1] = fill[1]; data[k + 2] = fill[2]; painted++; }
  }
  console.log(`  scrubbed ${painted} texels of hidden paint`);
  return sharp(data, { raw: { width: W, height: H, channels: 3 } });
}

const only = process.argv[2];
for (const name of Object.keys(CONFIG)) if (!only || only === name) await bake(name);
