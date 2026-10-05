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
export const BONES = ["root", "upper", "head", "antenna", "arm-1", "forearm-1", "arm+1", "forearm+1", "thigh-1", "shin-1", "foot-1", "thigh+1", "shin+1", "foot+1", "hand-1", "hand+1",
  "index-1", "index+1", "middle-1", "middle+1", "thumb-1", "thumb+1", "ring-1", "ring+1"] as const;
type Bone = (typeof BONES)[number];
type V3 = [number, number, number];

/** Joint pivots in baked units (+X is the viewer's left, +Z toward the viewer, floor at y = 0). */
type Rig = {
  hip: V3; neck: V3; antenna: V3; antennaBall: { at: V3; radius: number };
  shoulder: [V3, V3]; elbow: [V3, V3]; wrist: [V3, V3];
  hipJoint: [V3, V3]; knee: [V3, V3]; ankle: [V3, V3];
  /** Fingers with their own bones (handTransplant): knuckle pivot, curl axis (right-hand rule, toward the palm), tip. */
  fingers?: Array<{ name: Finger; pivot: [V3, V3]; curl: [V3, V3]; tip: [V3, V3] }>;
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
  /** Simplifier error bound (default 0.02); a dense sculpt (Ironman, 875k triangles) needs more to reach `triangles`. */
  simplifyError?: number;
  /**
   * Weld vertices whose normals agree to this dot product (default 0.9, ~25°). Ironman's 8-bit quantized normals keep
   * a third of its vertices split at 0.9, and split vertices are locked seams to the simplifier: −1 welds by position.
   */
  weldDot?: number;
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
   * Parts whose glow paint is switched off and repainted in `ink` (sRGB): Jarvis's painted eye slits sit deep under
   * the brow and showed as a glowing grin once the head was levelled; the live face draws the eyes instead.
   */
  glowOff?: { parts: Bone[]; ink: [number, number, number] };
  /**
   * The body's vertical axis [x, z] in the measured frame. The bake centres on the bounding box, so a bot with one
   * arm flung out (Jarvis) stands off the origin and turns orbit around empty space; the finished mesh, rig and face
   * are shifted so this axis is x = z = 0. Pivots, classify and face stay in measured (grid) units.
   */
  origin?: [number, number];
  /**
   * Re-sculpt the head's rest pose (radians, like the runtime's head rotation: negative pitch lifts the chin, negative
   * yaw turns toward −X) about `pivot` (default the neck). Applied to the final skin: each vertex turns by its head
   * weight, so the neck blend bends smoothly. For a sculpt whose head looks down or aside (Jarvis), so the bot rests
   * looking ahead instead of counter-rotating at runtime. The face spec stays in the sculpt's coordinates and moves
   * with the head.
   */
  headPose?: { pitch: number; yaw: number; pivot?: V3 };
  /**
   * Make the bot symmetric: side `from` (−1 or +1) is kept and mirrored across x = `plane` (measured units) onto the
   * other side, skin, labels and pivots included, so both arms and legs share one sculpt, one rig and one range of
   * motion. It runs last, after `headPose`, so a turned head is levelled first and mirrored with the body (no seam
   * between a mirrored collar and an unmirrored helmet). For a sculpt with one limb in an action pose (Jarvis).
   */
  mirror?: { from: -1 | 1; plane: number };
  /**
   * Cut the sculpted hands off at the wrist plane (clipping the triangles that cross it, so the cuff ends in a clean
   * planar rim that capHoles closes flat), for `handTransplant` to replace a fused fist (Jarvis).
   */
  dropHands?: boolean | Array<-1 | 1>;
  /**
   * Give both hands side `from`'s sculpted hand (Jarvis: its open pointing hand, not the fused fist): cut out past
   * that wrist, mirrored and placed on the other wrist (rolled about the forearm by `roll` rad), where `mirror` then
   * copies it back. Its extended fingers get their own bones: the mesh pieces farther than `radius` from `palm` (the
   * repulsor's centre), matched to the nearest of `tips` (all measured units, on side `from`). Use with `dropHands`
   * and `mirror` (from the other side).
   */
  /**
   * Paint for an untextured model (Ironman): named swatches and a rule picking one for a surface point from its
   * position and the triangle's normal (measured units; `part` is not known per point and is always "upper"). The bake writes a small palette texture and splits vertices at colour
   * edges; `glow` then lights the glowing swatches.
   * `project` paints from a reference image of the model instead wherever that image sees the surface (see Projection);
   * the region swatches then only cover what it doesn't see.
   */
  paint?: { swatches: Record<string, Swatch>; region(c: V3, n: V3, part: Bone): string; project?: Projection };
  /** Rig the model's own open hand on side `side` (see rigFingers); `tips` and `palm` in measured units. */
    fingers?: { side: -1 | 1; palm: V3; radius: number; tips: Partial<Record<Finger, V3>> };
  /**
   * On one side, cut the sculpted fist out from under the gauntlet's cover instead of at the wrist plane: the arm's
   * triangles are split at the cover's level rim (y) and at its outer side plate (x), and the pieces below the rim and
   * inside the plate go. The cover keeps its original shape over the transplanted hand (Jarvis's fist arm, whose
   * shell flares down past the wrist with a plate along the fist's outer side). Measured units.
   */
  cover?: { side: -1 | 1; y: number; x: number };
  /**
   * `cut` moves the source hand's cut plane that far past its wrist (leaving that gauntlet's rim shards behind), and
   * `sink` pushes the placed hand that far back up the target forearm, so its wrist tucks under the cover's rim.
   */
  handTransplant?: {
    from: -1 | 1; roll: number; cut?: number; sink?: number; preserveFacing?: boolean;
    /**
     * Take the hand from another model instead of side `from` of this one (Jarvis: ironman.glb's open four-digit
     * hand; it has no texture). Measured in that model's grid.ts frame: the hand is the part in front of the plane
     * dot(p, keep.axis) = keep.at; `wrist` → `toward` is the hand's own axis (palm base → fingers), laid along the
     * target forearm; it is decimated to `triangles` and painted (see pickPaint) with the repulsor glowing within
     * `repulsor` of the palm. `from` still names the side the hand is mirrored from.
     */
    donor?: { file: string; keep: { axis: V3; at: number }; wrist: V3; toward: V3; triangles: number; repulsor: number }; fingers: { palm: V3; radius: number; tips: Partial<Record<Finger, V3>> } };
};

/** Each bone's parent in the runtime's hierarchy (buildBot). */
const PARENT: Partial<Record<Bone, Bone>> = {
  upper: "root", head: "upper", antenna: "head", "arm-1": "upper", "arm+1": "upper", "forearm-1": "arm-1", "forearm+1": "arm+1",
  "thigh-1": "root", "thigh+1": "root", "shin-1": "thigh-1", "shin+1": "thigh+1", "foot-1": "shin-1", "foot+1": "shin+1",
  "hand-1": "forearm-1", "hand+1": "forearm+1",
  "index-1": "hand-1", "index+1": "hand+1", "middle-1": "hand-1", "middle+1": "hand+1", "thumb-1": "hand-1", "thumb+1": "hand+1",
  "ring-1": "hand-1", "ring+1": "hand+1",
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
    // The +X arm points out level (finger gun) and the +X leg stands back: rebuild that side as a mirror of the −X side
    // (fist by the hip, planted leg) so both sides share one sculpt, rig and range of motion.
    mirror: { from: -1, plane: -1.05 },
    // The −X fist is one fused piece; the +X hand is the sculpt's open, pointing hand (index out, middle forward, thumb
    // forward low, ring and pinky curled, repulsor in the palm). Both wrists get that hand, with its index, middle and
    // thumb on their own bones (pieces measured from the +X hand's vertices; palm = the repulsor's centre).
    dropHands: true,
    // The −X gauntlet's cover flares down to a level rim (y ≈ 3.8) with a plate down the fist's outer side
    // (x < −3.27, to y ≈ 3.3): keep it over the new hand and cut only the fist from under it.
    cover: { side: -1, y: 3.78, x: -3.27 },
    // Both hands come from ironman.glb's open +X hand (palm forward with a repulsor, thumb and three fingers spread;
    // measured in its grid.ts frame): no texture, so painted crimson with a cyan repulsor from Jarvis's own texels.
    handTransplant: {
      from: 1, roll: 1.57, sink: 0.25,
      donor: { file: "backend/src/bots/ironman.glb", keep: { axis: [0, 0, 1], at: 2.62 }, wrist: [1.08, 4.55, 2.85], toward: [1.08, 5.9, 3.1], triangles: 9000, repulsor: 0.24 },
      fingers: {
        palm: [1.08, 5.08, 2.92], radius: 0.75,
        tips: { index: [0.56, 6.33, 3.35], middle: [1.72, 6.12, 3.33], ring: [2.16, 5.23, 3.33], thumb: [-0.06, 5.02, 3.16] },
      },
    },
    // The sculpt looks down at its pointing hand (visor ~23° down, ~22° toward +X): rest it looking ahead. The pivot
    // sits behind the neck, under the helmet's back rim, so the back doesn't sink into the shoulders as the chin lifts.
    headPose: { pitch: -0.36, yaw: -0.36, pivot: [-0.92, 5.8, -0.8] },
    rig: {
      hip: [-1.05, 2.95, -0.2], neck: [-0.92, 5.72, -0.3], antenna: [-0.92, 8.2, -0.21], antennaBall: { at: [-0.92, 8.2, -0.21], radius: 0 },
      shoulder: [[-2.17, 5.4, -0.55], [0.25, 5.42, -0.82]], elbow: [[-2.8, 4.78, -0.6], [1.3, 5.12, -0.5]], wrist: [[-2.95, 3.8, -0.05], [2.12, 5.03, 0.45]],
      hipJoint: [[-1.6, 2.8, -0.15], [-0.5, 2.8, -0.3]], knee: [[-2.03, 2.05, -0.3], [0.05, 2.05, -0.55]], ankle: [[-2.45, 0.75, -0.5], [0.5, 0.75, -0.75]],
    },
    // Iron-Man faceplate: no glass. The screen is the band across the painted cyan eye slits low on the mask (the
    // helmet is pitched down and turned ~22° toward the pointing hand); BOT_FACES draws slit eyes on them.
    // Taller than the slit band: the live eyes sit higher, just under the red forehead panel (y ≈ 6.57).
    face: { centre: [-0.62, 6.3], width: 1.75, height: 0.9, squircle: 3, inset: 0 },
    glow: (r, g, b) => (g > 150 && b > 160 ? Math.max(0, Math.min(1, (b - r - 15) / 40)) : 0),
    // The painted slits become dark eye slots under the brow (as on the reference sketch); the live eyes glow in them.
    glowOff: { parts: ["head"], ink: [24, 27, 32] },
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
  // Chibi Iron Man in a flying lunge (ironman.glb; untextured, measured on grid.ts views and vertex plots): the +X
  // arm thrusts straight forward into an open repulsor hand (thumb and three fingers spread), the −X arm is drawn back
  // with a fist behind the body, the +X leg plants forward and the −X leg kicks back across behind it (the pelvis is
  // twisted). No antenna. Painted after the reference: red armour, gold faceplate and thigh plates, cyan repulsor.
  ironman: {
    // Keep the open repulsor hand on +X, replace only the -X fist with its mirrored copy, and leave the asymmetrical
    // flying pose untouched. Both hands use the same measured knuckle landmarks for independent finger animation.
    dropHands: [-1],
    handTransplant: {
      from: 1, roll: 0, sink: 0.12, preserveFacing: true,
      fingers: {
        palm: [1.08, 5.08, 2.92], radius: 0.75,
        tips: { index: [0.56, 6.33, 3.35], middle: [1.72, 6.12, 3.33], ring: [2.16, 5.23, 3.16], thumb: [-0.06, 5.02, 3.16] },
      },
    },
    rig: {
      hip: [0.2, 3.35, -0.45], neck: [0.2, 6.05, -0.15], antenna: [0.25, 8.0, -0.1], antennaBall: { at: [0.25, 8.0, -0.1], radius: 0 },
      shoulder: [[-0.85, 5.25, -0.5], [0.95, 5.35, 0.05]],
      elbow: [[-1.1, 4.45, -1.15], [1.05, 5.15, 1.35]],
      wrist: [[-1.75, 4.2, -1.55], [1.08, 5.1, 2.72]],
      hipJoint: [[-0.4, 3.0, -0.7], [0.7, 3.0, -0.3]],
      knee: [[0.15, 2.4, -1.5], [1.35, 2.35, -0.5]],
      ankle: [[0.9, 2.25, -2.6], [1.95, 1.3, -0.55]],
    },
    face: { centre: [0.1, 6.68], width: 1.7, height: 0.7, squircle: 3, inset: 0 },
    band: 0.16,
    smooth: 0.6,
    // Both arms leave the torso sideways and the pads wrap over the shoulders.
    shoulderAxis: [1, -0.25, 0],
    shoulderReach: 0.5,
    neckReach: 1.4,
    triangles: 75000,
    simplifyError: 0.05,
    weldDot: -1,
    strictSeams: true,
    classify(p, rig) {
      const [, y, z] = p;
      // The open hand's fingers rise past the collar in front of the face; everything else above it is helmet, and
      // the faceplate's chin reaches lower at the front.
      if ((y > 6.1 || (y > 5.92 && z > 0.45)) && z < 2.3) return "head";
      // The shoulder pads stay on the body (armour over the joint) and the arm turns under them; on the arm, their
      // back edges peeled into fins as the arm swung.
      for (const sh of rig.shoulder) if (y > sh[1] + 0.25 && len(sub(p, sh)) < 0.95) return "upper";
      return nearestPart(p, [
        ["upper", [[0.2, 3.5, -0.45], [0.2, 5.5, -0.3]], 0.92],
        ["arm-1", [rig.shoulder[0], rig.elbow[0]], 0.58],
        ["forearm-1", [rig.elbow[0], rig.wrist[0], [-2.55, 4.1, -1.62]], 0.55],
        ["arm+1", [rig.shoulder[1], rig.elbow[1]], 0.58],
        ["forearm+1", [rig.elbow[1], rig.wrist[1]], 0.6],
        // The open hand: fingertips reach 1.42 from the palm.
        ["forearm+1", [[1.08, 5.08, 2.92], [1.08, 5.08, 2.92]], 1.5],
        ["thigh-1", [rig.hipJoint[0], rig.knee[0]], 0.72], ["shin-1", [rig.knee[0], rig.ankle[0]], 0.62], ["foot-1", [rig.ankle[0], [1.25, 2.3, -3.4]], 0.66],
        ["thigh+1", [rig.hipJoint[1], rig.knee[1]], 0.72], ["shin+1", [rig.knee[1], rig.ankle[1]], 0.62], ["foot+1", [rig.ankle[1], [2.3, 0.4, -0.3]], 0.66],
      ]);
    },
    fingers: {
      side: 1, palm: [1.08, 5.08, 2.92], radius: 0.75,
      tips: { index: [0.56, 6.33, 3.35], middle: [1.72, 6.12, 3.33], ring: [2.16, 5.23, 3.33], thumb: [-0.06, 5.02, 3.16] },
    },
    paint: {
      // Colours from the reference art (target: chibi Iron Man, mid-flight): deep red shell, pale champagne gold
      // faceplate and thigh plates, steel-grey knee discs, cyan glow: the art's mid-tones (the bot is drawn without tone
      // mapping, see `project.exposure`), for the surfaces the art doesn't show.
      swatches: {
        red: { rgb: [188, 36, 38], rough: 0.3, metal: 0.5 },
        gold: { rgb: [212, 192, 164], rough: 0.3, metal: 0.55 },
        steel: { rgb: [140, 140, 146], rough: 0.35, metal: 0.7 },
        glow: { rgb: [8, 205, 255], rough: 0.2, metal: 0 },
        core: { rgb: [230, 250, 255], rough: 0.2, metal: 0 },
      },
      region(c, n, part) {
        const [x, y, z] = c;
        // Measure the repulsor across its face plane, not through its raised cap depth, so the white core fills the
        // center cleanly and the cyan stays a rim around it.
        const palm = Math.hypot(x - 1.08, y - 5.08);
        if (palm < 0.24 && n[2] > 0.3) return palm < 0.13 ? "core" : "glow";
        if (["hand-1", "hand+1", "index-1", "index+1", "middle-1", "middle+1", "ring-1", "ring+1", "thumb-1", "thumb+1"].includes(part)) return "gold";
        // Chest arc reactor: the round recess on the twisted chest (facing −X+Z).
        const chest = len(sub(c, [-0.53, 5.05, 0.2]));
        if (chest < 0.2 && dot(n, norm([-0.5, 0, 0.85])) > 0.4) return chest < 0.085 ? "core" : "glow";
        // Knee discs: the sculpted round caps (rim included) on the inside of each knee, measured on the source mesh.
        for (const [at, axis] of [[[-0.12, 2.56, -1.27], [0.86, -0.31, 0.4]], [[0.63, 2.39, -0.5], [-0.82, -0.21, -0.53]]] as Array<[V3, V3]>) {
          const k = norm(axis), d = sub(c, at), t = dot(d, k);
          if (t > -0.3 && t < 0.12 && len(sub(d, [k[0] * t, k[1] * t, k[2] * t])) < 0.21) return "steel";
        }
        // The helmet shell/faceplate boundary comes from projected red and gold art seeds, then grows along the
        // relief-weighted mesh graph. This follows the sculpted brow and cheek seams instead of a rectangular mask.
        // Thigh plates: the front half of each thigh, within the thigh's radius of its axis.
        const plate = (a: V3, b: V3) => {
          const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(c, a), ab) / dot(ab, ab)));
          const q: V3 = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
          return t > 0.02 && t < 0.98 && len(sub(c, q)) < 0.9 && z - q[2] > -0.25;
        };
        if (plate([-0.4, 3.0, -0.7], [0.15, 2.4, -1.5]) || plate([0.7, 3.0, -0.3], [1.35, 2.35, -0.5])) return "gold";
        return "red";
      },
      // Paint from the art the model was generated from wherever it sees the surface (camera fit by project-fit.ts,
      // IoU 0.95); the regions above cover the back and the sides it sees edge-on, and the glow discs stay flat.
      project: {
        image: "ironman-ref.png",
        camera: {
          matrix: [-86.577634, -3.713372, -42.667456, 420.403167, 3.459924, -94.776643, -30.521969, 915.153399, 0.009008, -0.009064, -0.080626, 1.039429],
          eye: [-1.352, 5.71, 12.099],
        },
        minFacing: 0.5,
        keep: ["glow", "core"],
        // Block by block: the art votes each sculpted plate's colour (face, eye slits, reactor rings, knee discs, thigh
        // plates); edges follow the grooves, hidden sides take their plate's colour.
        blocks: {
          classify(r, g, b) {
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, sat = mx ? d / mx : 0, val = mx / 255;
            const hue = d === 0 ? 0 : mx === r ? (((g - b) / d + 6) % 6) * 60 : mx === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
            // Ignore deep shadows and near-white specular glints, but let the pale, low-saturation gold faceplate vote
            // gold; the old global highlight cut left only its darker centre seeded.
            if (val < 0.2) return undefined;
            // No glow from the art: its cyan bloom spills over the fingers. The palm and reactor are the measured glow
            // discs, and the live face draws the eyes.
            if (hue > 165 && hue < 210) return undefined;
            if (sat < 0.08 && val > 0.35 && val < 0.65) return "steel";
            if (hue >= 25 && hue < 62 && sat > 0.035 && val > 0.48) return "gold";
            if ((hue < 18 || hue > 335) && sat > 0.55) return "red";
            return undefined;
          },
          fallback: "red",
          spread: { gold: 0.85, steel: 0.45, glow: 0.15, core: 0.15 },
          seedThreshold: 0.65,
          smooth: 10,
        },
      },
    },
    glow: (r, g, b) => (g > 200 && b > 200 && (r < 200 || (r > 210 && g > 235)) ? 1 : 0),
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
  return nodeWorldMatrices(json).map(m => [m[12], m[13], m[14]] as V3);
}

/** World matrix (column-major 4×4, full TRS / matrix chain) of every node. */
function nodeWorldMatrices(json: any): number[][] {
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
  return json.nodes.map((_: any, i: number) => world(i));
}

/**
 * A donor model's mesh (BotConfig.handTransplant.donor), normalised exactly like the bake and grid.ts: the full node
 * matrix chain, X mirrored like Babylon's loader (winding flipped), HEIGHT tall, floor at 0, centred in X and Z.
 */
function loadDonor(file: string) {
  const { json, accessor } = readGlb(file);
  const meshNode = json.nodes.findIndex((n: any) => n.mesh !== undefined);
  const primitive = json.meshes[json.nodes[meshNode].mesh].primitives[0];
  const m = nodeWorldMatrices(json)[meshNode];
  const raw = accessor(primitive.attributes.POSITION), rawN = accessor(primitive.attributes.NORMAL);
  const count = raw.length / 3;
  const pos = new Float64Array(count * 3), nrm = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = [raw[3 * i], raw[3 * i + 1], raw[3 * i + 2]];
    pos.set([-(m[0] * x + m[4] * y + m[8] * z + m[12]), m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]], 3 * i);
    const [a, b, c] = [rawN[3 * i], rawN[3 * i + 1], rawN[3 * i + 2]];
    nrm.set(norm([-(m[0] * a + m[4] * b + m[8] * c), m[1] * a + m[5] * b + m[9] * c, m[2] * a + m[6] * b + m[10] * c]), 3 * i);
  }
  const indices = Array.from(accessor(primitive.indices));
  for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], pos[3 * i + c]); max[c] = Math.max(max[c], pos[3 * i + c]); }
  const scale = HEIGHT / (max[1] - min[1]);
  for (let i = 0; i < count; i++) {
    pos[3 * i] = (pos[3 * i] - (min[0] + max[0]) / 2) * scale;
    pos[3 * i + 1] = (pos[3 * i + 1] - min[1]) * scale;
    pos[3 * i + 2] = (pos[3 * i + 2] - (min[2] + max[2]) / 2) * scale;
  }
  return { count, pos, nrm, indices };
}

/** World matrix (column-major 4×4, including matrix nodes). */
function nodeTransform(json: any, meshNode: number) {
  const m = nodeWorldMatrices(json)[meshNode];
  return (p: V3): V3 => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
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
  const meshWorld = nodeWorldMatrices(json)[meshNode];
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
    const n0 = [rawNrm[3 * i], rawNrm[3 * i + 1], rawNrm[3 * i + 2]] as V3;
    // The source may use a node matrix (Ironman does); transform normals by the inverse transpose.
    const m = meshWorld;
    const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    const n = norm(turn(
      -((m[5] * m[10] - m[9] * m[6]) * n0[0] + (m[9] * m[2] - m[1] * m[10]) * n0[1] + (m[1] * m[6] - m[5] * m[2]) * n0[2]) / det,
      ((m[8] * m[6] - m[4] * m[10]) * n0[0] + (m[0] * m[10] - m[8] * m[2]) * n0[1] + (m[4] * m[2] - m[0] * m[6]) * n0[2]) / det,
      ((m[4] * m[9] - m[8] * m[5]) * n0[0] + (m[8] * m[1] - m[0] * m[9]) * n0[1] + (m[0] * m[5] - m[4] * m[1]) * n0[2]) / det,
    ));
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
    ({ count, pos, nrm, uv, indices } = weld(count, pos, nrm, uv, indices, Boolean(primitive.attributes.TEXCOORD_0), config.weldDot));
    if (config.triangles && indices.length / 3 > config.triangles) ({ count, pos, nrm, uv, indices } = await simplify(count, pos, nrm, uv, indices, config.triangles, config.simplifyError));
  }

  // Hard labels, then smooth blends across each joint between parent and child parts.
  const boneIndex = (b: Bone) => BONES.indexOf(b);
  let rig = config.rig;
  let fileSkin: { joints: Uint8Array; weights: Uint8Array } | undefined;
  if (rigged) {
    const world = nodeWorldPositions(json);
    const at = (bone: string, fallback: V3): V3 => { const k = skinNames.indexOf(bone); return k < 0 ? fallback : normalise(world[skin.joints[k]]); };
    const sides = (key: "shoulder" | "elbow" | "wrist" | "hipJoint" | "knee" | "ankle", part: string): [V3, V3] => [at(`${part}-1`, rig[key][0]), at(`${part}+1`, rig[key][1])];
    rig = {
      ...rig, hip: at("upper", rig.hip), neck: at("head", rig.neck), antenna: at("antenna", rig.antenna),
      shoulder: sides("shoulder", "arm"), elbow: sides("elbow", "forearm"), wrist: sides("wrist", "hand"), hipJoint: sides("hipJoint", "thigh"), knee: sides("knee", "shin"), ankle: sides("ankle", "foot"),
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
  let lum: Float32Array = await sampleLuminance(json, image, material, uv, count);
  let label = new Uint8Array(count);
  for (let i = 0; i < count; i++) label[i] = fileSkin ? fileSkin.joints[4 * i] : boneIndex(config.classify([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], rig, lum[i]));
  // The hand is the forearm past the wrist (across the plane through the wrist, normal to the forearm), so every bot
  // gets a wrist that flexes without per-bot classify rules.
  if (!fileSkin) for (let i = 0; i < count; i++) {
    const b = BONES[label[i]];
    if (!b.startsWith("forearm")) continue;
    const k = b.endsWith("-1") ? 0 : 1;
    if (dot(sub([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], rig.wrist[k]), norm(sub(rig.wrist[k], rig.elbow[k]))) > 0) label[i] = boneIndex(k ? "hand+1" : "hand-1");
  }
  // Debug: dump a donor model's vertices inside a box (DUMP_DONOR=file:x0,y0,z0,x1,y1,z1) for measuring a hand.
  if (process.env.DUMP_DONOR) {
    const [file, box] = process.env.DUMP_DONOR.split(":");
    const [x0, y0, z0, x1, y1, z1] = box.split(",").map(Number);
    const d = loadDonor(resolve(file));
    const keep = new Map<number, number>(), pts: number[] = [], tris: number[] = [];
    const inBox = (i: number) => d.pos[3 * i] >= x0 && d.pos[3 * i] <= x1 && d.pos[3 * i + 1] >= y0 && d.pos[3 * i + 1] <= y1 && d.pos[3 * i + 2] >= z0 && d.pos[3 * i + 2] <= z1;
    for (let i = 0; i < d.count; i++) if (inBox(i)) { keep.set(i, keep.size); pts.push(d.pos[3 * i], d.pos[3 * i + 1], d.pos[3 * i + 2], 0.5, 0.5); }
    for (let t = 0; t < d.indices.length; t += 3) if ([0, 1, 2].every(c => keep.has(d.indices[t + c]))) tris.push(...[0, 1, 2].map(c => keep.get(d.indices[t + c])!));
    writeFileSync(resolve(".ui-check/hand-dump.json"), JSON.stringify({ pts, tris }));
    console.log(`  dumped ${keep.size} donor vertices, ${tris.length / 3} triangles`);
    process.exit(0);
  }
  // Debug: dump one side's hand vertices (measured units) for measuring fingers.
  if (process.env.DUMP_HAND) {
    const want = boneIndex(process.env.DUMP_HAND as Bone);
    const pts: number[] = [];
    for (let i = 0; i < count; i++) if (label[i] === want) pts.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], uv[2 * i], uv[2 * i + 1]);
    const tris: number[] = [];
    const idx = new Map<number, number>();
    for (let i = 0, k = 0; i < count; i++) if (label[i] === want) idx.set(i, k++);
    for (let t = 0; t < indices.length; t += 3) if ([0, 1, 2].every(c => idx.has(indices[t + c]))) tris.push(...[0, 1, 2].map(c => idx.get(indices[t + c])!));
    writeFileSync(resolve(".ui-check/hand-dump.json"), JSON.stringify({ pts, tris }));
    console.log(`  dumped ${pts.length / 5} ${process.env.DUMP_HAND} vertices`);
    process.exit(0);
  }
  // Rims the wrist cuts open stay open: the double-sided shell shows its own inside there, where a flat cap read as a
  // pale plate at the wrist.
  const keepOpen = new Set<string>();
  const transplant = config.handTransplant && !rigged ? config.handTransplant : undefined;
  let sourceHand: SourceHand | undefined;
  if (transplant?.donor) {
    // Paint picked among the bot's own hand texels (side `from`), before that hand is cut away.
    const own = Array.from({ length: count }, (_, i) => i).filter(i => label[i] === boneIndex(transplant.from > 0 ? "hand+1" : "hand-1"));
    const paint = await pickPaint(json, image, material, uv, own, [156, 13, 68]);
    sourceHand = await donorHand(transplant.donor, transplant.fingers.palm, paint);
  } else if (transplant) sourceHand = extractHand({ pos, nrm, uv, indices, label, lum }, rig, transplant.from > 0 ? 1 : 0, transplant.cut);
  if (config.dropHands && !rigged) {
    const cover = config.cover;
    const sides = Array.isArray(config.dropHands) ? config.dropHands.map(side => side > 0 ? 1 : 0) : cover ? [cover.side > 0 ? 0 : 1] : [0, 1];
    ({ count, pos, nrm, uv, indices, label, lum } = cutHands({ count, pos, nrm, uv, indices, label, lum }, rig, sides, keepOpen));
    if (cover) ({ count, pos, nrm, uv, indices, label, lum } = cutUnderCover({ count, pos, nrm, uv, indices, label, lum }, cover, keepOpen));
  }
  if (transplant && sourceHand) {
    let fingers: Rig["fingers"];
    ({ count, pos, nrm, uv, indices, label, lum, fingers } = transplantHand({ pos, nrm, uv, indices, label, lum }, sourceHand, rig, transplant, keepOpen));
    rig = { ...rig, fingers };
  }
  if (config.fingers && !rigged) {
    const sourceFingers = rigFingers({ count, pos, indices, label }, config.fingers);
    const copiedFingers = transplant && rig.fingers;
    if (copiedFingers) {
      const targetSide = transplant.from > 0 ? 0 : 1;
      const copies = new Map(copiedFingers.map(f => [f.name, f]));
      const mergeSide = (source: [V3, V3], copy: [V3, V3]): [V3, V3] => {
        const pair: [V3, V3] = [source[0], source[1]];
        pair[targetSide] = copy[targetSide];
        return pair;
      };
      rig = { ...rig, fingers: sourceFingers.map(f => {
        const copy = copies.get(f.name);
        return copy ? { ...f, pivot: mergeSide(f.pivot, copy.pivot), curl: mergeSide(f.curl, copy.curl), tip: mergeSide(f.tip, copy.tip) } : f;
      }) };
    } else rig = { ...rig, fingers: sourceFingers };
  }
  type Joint = { parent: Bone; child: Bone; pivot: V3; axis: V3; reach: number };
  const limitOf = (j: Joint) => Math.max(config.smoothingReach ?? 0.9, j.reach * 1.5);
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
    joints.push({ parent: `forearm${s}`, child: `hand${s}`, pivot: rig.wrist[i], axis: forearmAxis, reach: 0.55 });
    for (const f of rig.fingers ?? []) joints.push({ parent: `hand${s}`, child: `${f.name}${s}`, pivot: f.pivot[i], axis: norm(sub(f.tip[i], f.pivot[i])), reach: 0.3 });
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
  if (config.smooth && !rigged) ({ skinJoints, skinWeights } = smoothWeights(count, pos, indices, skinJoints, skinWeights, label, joints.map(j => ({ pair: [boneIndex(j.parent), boneIndex(j.child)], pivot: j.pivot, limit: limitOf(j) })), config.smooth));

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
    const seams = joints.map(j => ({ a: boneIndex(j.parent), b: boneIndex(j.child), pivot: j.pivot, limit: limitOf(j) }));
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
    lum = Float32Array.from([...lum, ...lumExtra]);
    if (welds) console.log(`  welds reassigned: ${welds}`);
  }

  // Close the holes the dropped bridges leave (and the patches where a fused hand used to be) with flat caps.
  ({ count, pos, nrm, uv, skinJoints, skinWeights, indices } = capHoles({ count, pos, nrm, uv, skinJoints, skinWeights, indices }, lum, label, keepOpen));

  let face = config.face;
  if (config.headPose && !rigged) {
    const { pitch, yaw } = config.headPose, pv = config.headPose.pivot ?? rig.neck;
    // Babylon rotation (pitch about X, then yaw about Y), as the runtime turns the head node.
    const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
    const turnDir = ([x, y, z]: V3): V3 => { const y1 = y * cp - z * sp, z1 = y * sp + z * cp; return [x * cy + z1 * sy, y1, -x * sy + z1 * cy]; };
    const turnAt = (p: V3, w = 1): V3 => { const q = turnDir(sub(p, pv)); return [0, 1, 2].map(c => p[c] + w * (q[c] + pv[c] - p[c])) as V3; };
    const headBones = [BONES.indexOf("head"), BONES.indexOf("antenna")];
    // The visor centre on the surface (frontmost head vertices there), before the head moves.
    let fz = -Infinity;
    for (let i = 0; i < count; i++) if (skinJoints[4 * i] === headBones[0] && Math.hypot(pos[3 * i] - face.centre[0], pos[3 * i + 1] - face.centre[1]) < 0.12) fz = Math.max(fz, pos[3 * i + 2]);
    // Copies of one point (UV seams, strictSeams' weld duplicates on another bone) must move together or the
    // surface opens: each position moves by its copies' mean head weight. This only sets the bind pose; skinning is
    // unchanged.
    const headWeight = (i: number) => { let w = 0; for (let k = 0; k < 4; k++) if (headBones.includes(skinJoints[4 * i + k])) w += skinWeights[4 * i + k] / 255; return w; };
    const keyOf = (i: number) => `${Math.round(pos[3 * i] * 1e4)},${Math.round(pos[3 * i + 1] * 1e4)},${Math.round(pos[3 * i + 2] * 1e4)}`;
    const groups = new Map<string, [number, number]>();
    for (let i = 0; i < count; i++) { const g = groups.get(keyOf(i)) ?? [0, 0]; g[0] += headWeight(i); g[1]++; groups.set(keyOf(i), g); }
    const weightOf = Array.from({ length: count }, (_, i) => { const g = groups.get(keyOf(i))!; return g[0] / g[1]; });
    for (let i = 0; i < count; i++) {
      const w = weightOf[i];
      if (!w) continue;
      pos.set(turnAt([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], w), 3 * i);
      const n: V3 = [nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]], t = turnDir(n);
      nrm.set(norm([0, 1, 2].map(c => n[c] + w * (t[c] - n[c])) as V3), 3 * i);
    }
    rig = { ...rig, antenna: turnAt(rig.antenna), antennaBall: { ...rig.antennaBall, at: turnAt(rig.antennaBall.at) } };
    // The screen faces the camera more squarely now: its projected size grows as the tilt it loses.
    const c = turnAt([face.centre[0], face.centre[1], fz]);
    face = { ...face, centre: [c[0], c[1]], width: face.width * Math.cos(yaw) ** -1, height: face.height * Math.cos(pitch) ** -1 };
    console.log(`  head re-posed: pitch ${pitch}, yaw ${yaw}; face centre ${c.map(v => v.toFixed(2)).join(",")}`);
  }

  if (config.mirror && !rigged) {
    // After the head is levelled, so the head is mirrored too: no seam where a mirrored body meets a turned helmet.
    const { from, plane } = config.mirror;
    // The helmet's own centre line (above the collar) should sit on the plane, or the mirrored helmet is lopsided.
    let hx0 = Infinity, hx1 = -Infinity;
    for (let i = 0; i < count; i++) if (pos[3 * i + 1] > 6.4) { hx0 = Math.min(hx0, pos[3 * i]); hx1 = Math.max(hx1, pos[3 * i]); }
    console.log(`  helmet centre x ${((hx0 + hx1) / 2).toFixed(3)} (plane ${plane})`);
    const full = Uint8Array.from({ length: count }, (_, i) => (i < label.length ? label[i] : skinJoints[4 * i]));
    ({ count, pos, nrm, uv, indices, label, skinJoints, skinWeights } = symmetrize({ count, pos, nrm, uv, indices, label: full, skinJoints, skinWeights }, plane, from));
    const flip = ([x, y, z]: V3): V3 => [2 * plane - x, y, z];
    const both = (ps: [V3, V3]): [V3, V3] => (from < 0 ? [ps[0], flip(ps[0])] : [flip(ps[1]), ps[1]]);
    rig = { ...rig, shoulder: both(rig.shoulder), elbow: both(rig.elbow), wrist: both(rig.wrist), hipJoint: both(rig.hipJoint), knee: both(rig.knee), ankle: both(rig.ankle) };
    face = { ...face, centre: [plane, face.centre[1]] };
    // A curl axis is a rotation axis: under the reflection it keeps x and flips y and z, so the copy curls as a mirror.
    const axial = (ps: [V3, V3]): [V3, V3] => { const k = from < 0 ? 0 : 1, a = ps[k], m: V3 = [a[0], -a[1], -a[2]]; return k ? [m, a] : [a, m]; };
    if (rig.fingers) rig = { ...rig, fingers: rig.fingers.map(f => ({ ...f, pivot: both(f.pivot), tip: both(f.tip), curl: axial(f.curl) })) };
    console.log(`  mirrored: side ${from > 0 ? "+1" : "-1"} across x = ${plane}, head included (${count} vertices)`);
  }

  const projection = config.paint?.project && !rigged ? await loadProjection(config.paint.project) : undefined;
  if (config.paint && !rigged) {
    const full = Uint8Array.from({ length: count }, (_, i) => (i < label.length ? label[i] : skinJoints[4 * i]));
    ({ count, pos, nrm, uv, indices, skinJoints, skinWeights, label } = paintMesh({ count, pos, nrm, uv, indices, skinJoints, skinWeights, label: full }, config.paint, projection));
  }

  // Shifted copy for packing only: scrub and the visor trace below still read measured coordinates.
  const [ox, oz] = config.origin ?? [0, 0];
  const packed = Float64Array.from(pos, (v, k) => v - (k % 3 === 0 ? ox : k % 3 === 2 ? oz : 0));
  const move = (p: V3): V3 => [p[0] - ox, p[1], p[2] - oz];
  const pair = (ps: [V3, V3]): [V3, V3] => [move(ps[0]), move(ps[1])];
  const packedRig: Rig = {
    hip: move(rig.hip), neck: move(rig.neck), antenna: move(rig.antenna), antennaBall: { ...rig.antennaBall, at: move(rig.antennaBall.at) },
    shoulder: pair(rig.shoulder), elbow: pair(rig.elbow), wrist: pair(rig.wrist), hipJoint: pair(rig.hipJoint), knee: pair(rig.knee), ankle: pair(rig.ankle),
    ...(rig.fingers ? { fingers: rig.fingers.map(f => ({ ...f, pivot: pair(f.pivot), tip: pair(f.tip) })) } : {}),
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
  if (config.paint) Object.assign(textures, await writePalette(name, config.paint, projection));
  if (config.glow && !textures.emissive && textures.color) {
    const { data, info } = await sharp(join(OUT, `${name}-color.webp`)).raw().toBuffer({ resolveWithObject: true });
    // Texels of the parts whose glow is off: rasterise their triangles in UV space.
    const off = new Uint8Array(info.width * info.height);
    if (config.glowOff) {
      const parts = config.glowOff.parts.map(b => BONES.indexOf(b));
      for (let t = 0; t < indices.length; t += 3) {
        const v = [indices[t], indices[t + 1], indices[t + 2]];
        if (!v.every(i => i < label.length && parts.includes(label[i]))) continue;
        const p = v.map(i => [uv[2 * i] * info.width, uv[2 * i + 1] * info.height]);
        const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
        if (!area) continue;
        const margin = 1.5 / Math.sqrt(Math.abs(area));
        for (let y = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1])) - 1); y <= Math.min(info.height - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1])) + 1); y++)
          for (let x = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0])) - 1); x <= Math.min(info.width - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0])) + 1); x++) {
            const w1 = ((x + 0.5 - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (y + 0.5 - p[0][1])) / area;
            const w2 = ((p[1][0] - p[0][0]) * (y + 0.5 - p[0][1]) - (x + 0.5 - p[0][0]) * (p[1][1] - p[0][1])) / area;
            if (w1 >= -margin && w2 >= -margin && w1 + w2 <= 1 + margin) off[y * info.width + x] = 1;
          }
      }
    }
    const lit = Buffer.alloc(info.width * info.height * 3);
    let repainted = 0;
    for (let i = 0, o = 0, px = 0; i < lit.length; i += 3, o += info.channels, px++) {
      const k = config.glow(data[o], data[o + 1], data[o + 2]);
      if (off[px] && k > 0) {
        // Blend toward the ink by glow strength, so the paint's soft edge fades into the plate.
        for (let c = 0; c < 3; c++) data[o + c] = Math.round(data[o + c] + Math.min(1, k * 1.5) * (config.glowOff!.ink[c] - data[o + c]));
        repainted++;
        continue;
      }
      for (let c = 0; c < 3; c++) lit[i + c] = Math.round(data[o + c] * k);
    }
    if (repainted) {
      // To a buffer first: on Windows sharp still holds the file it just read.
      writeFileSync(join(OUT, `${name}-color.webp`), await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).webp({ quality: 88 }).toBuffer());
      console.log(`  glow off: ${repainted} texels repainted`);
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
    rig: packedRig, face: shiftFace(face.recess ? recessFace(pos, indices, face) : face, ox, oz), textures,
    emissive: material.emissiveFactor ?? (textures.emissive ? [1, 1, 1] : null),
    ...(config.paint?.project ? { art: { exposure: config.paint.project.exposure ?? 1 } } : {}),
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
  console.log("  parts:", [...counts].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${BONES[b] ?? "caps"} ${n}`).join(", "));
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
/**
 * Keep side `from` of the finished, skinned mesh and mirror it across x = `plane` onto the other side (see
 * BotConfig.mirror): positions, normals and the winding are reflected, UVs kept, and side bones (arm-1 ↔ arm+1 …)
 * swapped in both the labels and the skin. Vertices on the midline cut are snapped onto the plane and shared with
 * their copy, so the halves weld shut.
 */
function symmetrize(m: { count: number; pos: Float64Array; nrm: Float64Array; uv: Float64Array; indices: number[]; label: Uint8Array; skinJoints: Uint8Array; skinWeights: Uint8Array }, plane: number, from: -1 | 1) {
  const { pos, nrm, indices } = m;
  const swap = BONES.map(b => BONES.indexOf(b.replace(/([-+])1$/, (_, sign) => (sign === "-" ? "+1" : "-1")) as Bone));
  const source: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]];
    if (((pos[3 * v[0]] + pos[3 * v[1]] + pos[3 * v[2]]) / 3 - plane) * from > 0) source.push(...v);
  }
  // Edges by welded position (UV seams and weld copies split vertices, not the surface): a cut edge was shared before
  // and is open now.
  const key = new Map<string, number>();
  const at = Array.from({ length: m.count }, (_, i) => {
    const k = `${Math.round(pos[3 * i] * 1e4)},${Math.round(pos[3 * i + 1] * 1e4)},${Math.round(pos[3 * i + 2] * 1e4)}`;
    if (!key.has(k)) key.set(k, key.size);
    return key.get(k)!;
  });
  const edgeId = (a: number, b: number) => Math.min(at[a], at[b]) * key.size + Math.max(at[a], at[b]);
  const edges = (list: number[]) => {
    const out = new Map<number, number>();
    for (let t = 0; t < list.length; t += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) { const e = edgeId(list[t + a], list[t + b]); out.set(e, (out.get(e) ?? 0) + 1); }
    return out;
  };
  const before = edges(indices), after = edges(source);
  const onCut = new Set<number>();
  for (let t = 0; t < source.length; t += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
    const e = edgeId(source[t + a], source[t + b]);
    if (after.get(e) === 1 && (before.get(e) ?? 0) >= 2) { onCut.add(at[source[t + a]]); onCut.add(at[source[t + b]]); }
  }
  const snapped = new Set<number>();
  for (let i = 0; i < m.count; i++) {
    if (!onCut.has(at[i]) || Math.abs(pos[3 * i] - plane) > 0.25) continue;
    pos[3 * i] = plane;
    const ny = nrm[3 * i + 1], nz = nrm[3 * i + 2], l = Math.hypot(ny, nz);
    nrm.set(l > 1e-6 ? [0, ny / l, nz / l] : [0, 1, 0], 3 * i);
    snapped.add(i);
  }
  const P = Array.from(pos), N = Array.from(nrm), U = Array.from(m.uv), L = Array.from(m.label), J = Array.from(m.skinJoints), Wt = Array.from(m.skinWeights);
  const copy = new Map<number, number>();
  const mirrorOf = (i: number) => {
    if (snapped.has(i)) return i;
    let j = copy.get(i);
    if (j === undefined) {
      j = L.length;
      copy.set(i, j);
      P.push(2 * plane - pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]); N.push(-nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]);
      U.push(m.uv[2 * i], m.uv[2 * i + 1]); L.push(swap[m.label[i]]);
      for (let c = 0; c < 4; c++) { J.push(m.skinWeights[4 * i + c] ? swap[m.skinJoints[4 * i + c]] : m.skinJoints[4 * i + c]); Wt.push(m.skinWeights[4 * i + c]); }
    }
    return j;
  };
  // A reflection flips handedness: reverse the winding so the copy still faces out.
  const mirrored: number[] = [];
  for (let t = 0; t < source.length; t += 3) mirrored.push(mirrorOf(source[t]), mirrorOf(source[t + 2]), mirrorOf(source[t + 1]));
  // Compact: the dropped side's vertices go.
  const all = [...source, ...mirrored], remap = new Map<number, number>();
  for (const i of all) if (!remap.has(i)) remap.set(i, remap.size);
  const count = remap.size;
  const out = {
    count, pos: new Float64Array(count * 3), nrm: new Float64Array(count * 3), uv: new Float64Array(count * 2), label: new Uint8Array(count),
    skinJoints: new Uint8Array(count * 4), skinWeights: new Uint8Array(count * 4), indices: all.map(i => remap.get(i)!),
  };
  for (const [i, j] of remap) {
    for (let c = 0; c < 3; c++) { out.pos[3 * j + c] = P[3 * i + c]; out.nrm[3 * j + c] = N[3 * i + c]; }
    for (let c = 0; c < 4; c++) { out.skinJoints[4 * j + c] = J[4 * i + c]; out.skinWeights[4 * j + c] = Wt[4 * i + c]; }
    out.uv[2 * j] = U[2 * i]; out.uv[2 * j + 1] = U[2 * i + 1];
    out.label[j] = L[i];
  }
  return out;
}

/**
 * Cut each arm's hand off at its wrist plane (through `rig.wrist`, normal elbow → wrist; see BotConfig.dropHands).
 * Only triangles touching that side's forearm or hand are cut: those wholly past the plane go, those crossing it are
 * clipped, with new vertices on the plane (interpolated attributes, forearm label). The cuff then ends in a planar
 * rim instead of a sawtooth of whole triangles.
 */
function cutHands(m: { count: number; pos: Float64Array; nrm: Float64Array; uv: Float64Array; indices: number[]; label: Uint8Array; lum: Float32Array }, rig: Rig, sides: Array<0 | 1> = [0, 1], keepOpen?: Set<string>) {
  const P = Array.from(m.pos), N = Array.from(m.nrm), U = Array.from(m.uv), L = Array.from(m.label), Lum = Array.from(m.lum);
  const out: number[] = [];
  const split = new Map<string, number>();
  let cut = 0, clipped = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const v = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    const k = sides.find(k => v.some(i => [`forearm${k ? "+1" : "-1"}`, `hand${k ? "+1" : "-1"}`].includes(BONES[L[i]])));
    if (k === undefined) { out.push(...v); continue; }
    const axis = norm(sub(rig.wrist[k], rig.elbow[k]));
    const d = (i: number) => dot(sub([P[3 * i], P[3 * i + 1], P[3 * i + 2]], rig.wrist[k]), axis);
    const ds = v.map(d);
    if (ds.every(x => x <= 0)) { out.push(...v); continue; }
    if (ds.every(x => x > 0)) { cut++; continue; }
    clipped++;
    // The vertex where edge a→b meets the plane, shared by both triangles on that edge.
    const onPlane = (a: number, b: number) => {
      const id = a < b ? `${a}|${b}` : `${b}|${a}`;
      let j = split.get(id);
      if (j !== undefined) return j;
      const s = d(a) / (d(a) - d(b));
      j = L.length;
      split.set(id, j);
      for (let c = 0; c < 3; c++) { P.push(P[3 * a + c] + s * (P[3 * b + c] - P[3 * a + c])); N.push(N[3 * a + c] + s * (N[3 * b + c] - N[3 * a + c])); }
      const n = norm([N[3 * j], N[3 * j + 1], N[3 * j + 2]]);
      N.splice(3 * j, 3, ...n);
      keepOpen?.add(rimKey(P[3 * j], P[3 * j + 1], P[3 * j + 2]));
      for (let c = 0; c < 2; c++) U.push(U[2 * a + c] + s * (U[2 * b + c] - U[2 * a + c]));
      L.push(BONES.indexOf(k ? "forearm+1" : "forearm-1"));
      Lum.push(Lum[a] + s * (Lum[b] - Lum[a]));
      return j;
    };
    // Sutherland–Hodgman against the plane, keeping the elbow side, in the triangle's winding.
    const poly: number[] = [];
    for (let c = 0; c < 3; c++) {
      const a = v[c], b = v[(c + 1) % 3], da = ds[c], db = ds[(c + 1) % 3];
      if (da <= 0) poly.push(a);
      if ((da <= 0) !== (db <= 0)) poly.push(onPlane(a, b));
    }
    for (let c = 1; c + 1 < poly.length; c++) out.push(poly[0], poly[c], poly[c + 1]);
  }
  console.log(`  hands cut at the wrist: ${cut} triangles dropped, ${clipped} clipped`);
  return {
    count: L.length, pos: Float64Array.from(P), nrm: Float64Array.from(N), uv: Float64Array.from(U), indices: out,
    label: Uint8Array.from(L), lum: Float32Array.from(Lum),
  };
}

/**
 * Cut a fist out from under its gauntlet's cover (BotConfig.cover): the side's forearm and hand triangles are split
 * at y = cover.y and at x = cover.x (new vertices on the cuts, labelled forearm), and the pieces below the rim and
 * inside the outer plate are dropped.
 */
function cutUnderCover(m: { count: number; pos: Float64Array; nrm: Float64Array; uv: Float64Array; indices: number[]; label: Uint8Array; lum: Float32Array }, cover: NonNullable<BotConfig["cover"]>, keepOpen?: Set<string>) {
  const s = cover.side > 0 ? "+1" : "-1";
  const arm = [BONES.indexOf(`forearm${s}` as Bone), BONES.indexOf(`hand${s}` as Bone)];
  const P = Array.from(m.pos), N = Array.from(m.nrm), U = Array.from(m.uv), L = Array.from(m.label), Lum = Array.from(m.lum);
  const split = new Map<string, number>();
  // Point on edge a→b where coordinate `c` crosses `at` (shared by both triangles on that edge).
  const onCut = (a: number, b: number, c: number, at: number) => {
    const id = `${c}|${a < b ? `${a}|${b}` : `${b}|${a}`}`;
    let j = split.get(id);
    if (j !== undefined) return j;
    const t = (at - P[3 * a + c]) / (P[3 * b + c] - P[3 * a + c]);
    j = L.length;
    split.set(id, j);
    for (let k = 0; k < 3; k++) P.push(P[3 * a + k] + t * (P[3 * b + k] - P[3 * a + k]));
    N.push(...norm([0, 1, 2].map(k => N[3 * a + k] + t * (N[3 * b + k] - N[3 * a + k])) as V3));
    keepOpen?.add(rimKey(P[3 * j], P[3 * j + 1], P[3 * j + 2]));
    for (let k = 0; k < 2; k++) U.push(U[2 * a + k] + t * (U[2 * b + k] - U[2 * a + k]));
    L.push(arm[0]);
    Lum.push(Lum[a] + t * (Lum[b] - Lum[a]));
    return j;
  };
  // Split a polygon by coordinate c at `at` into the part below and the part above (Sutherland–Hodgman, both sides).
  const halves = (poly: number[], c: number, at: number) => {
    const lo: number[] = [], hi: number[] = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length], ab = P[3 * a + c] < at, bb = P[3 * b + c] < at;
      (ab ? lo : hi).push(a);
      if (ab !== bb) { const j = onCut(a, b, c, at); lo.push(j); hi.push(j); }
    }
    return [lo, hi];
  };
  const out: number[] = [];
  const fan = (poly: number[]) => { for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1]); };
  let dropped = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const v = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    if (!v.some(i => arm.includes(L[i]))) { out.push(...v); continue; }
    const [below, above] = halves(v, 1, cover.y);
    if (above.length >= 3) fan(above);
    if (below.length < 3) continue;
    // Below the rim, only the outer plate stays (x past cover.x, away from the body).
    const [lowX, highX] = halves(below, 0, cover.x);
    const plate = cover.side < 0 ? lowX : highX;
    if (plate.length >= 3) fan(plate);
    if ((cover.side < 0 ? highX : lowX).length >= 3) dropped++;
  }
  // What is left past the wrist is the cover: it belongs to the forearm, not the (new) hand.
  for (let i = 0; i < L.length; i++) if (L[i] === arm[1]) L[i] = arm[0];
  console.log(`  fist cut out from under the side ${s} cover: ${dropped} triangle pieces dropped`);
  return { count: L.length, pos: Float64Array.from(P), nrm: Float64Array.from(N), uv: Float64Array.from(U), indices: out, label: Uint8Array.from(L), lum: Float32Array.from(Lum) };
}

/** A paint swatch for an untextured model (BotConfig.paint): sRGB colour, roughness and metalness. */
type Swatch = { rgb: [number, number, number]; rough: number; metal: number };
const PALETTE_CELL = 16, PALETTE_COLS = 4;

/**
 * Paint from a reference image (BotConfig.paint.project): the art the model was generated from, with the camera that
 * lays the model over it (fit with .claude/skills/glb-bot/scripts/project-fit.ts; measured units). A surface point the
 * camera sees (in front, unoccluded, facing it by more than `minFacing`) takes the image's colour through a projected
 * UV; swatches named in `keep` (glow discs) stay flat. The texture is the image cropped to the character with its
 * background filled from the nearest character colour (so a slightly misplaced edge doesn't sample sky), and the palette
 * cells in a strip along the bottom.
 */
type Projection = {
  image: string; camera: { matrix: number[]; eye: V3 }; minFacing?: number; keep?: string[]; margin?: number;
  /**
   * The art is already lit and tone-mapped, so the runtime shows this bot without the scene's ACES tone mapping (which
   * crushes saturated reds to crimson) at this exposure, calibrated so the front renders at the art's colours.
   */
  exposure?: number;
  /**
   * Paint block by block instead of projecting the image: each triangle takes the swatch `classify` gives the art's
   * pixels where the camera sees it clearly (seeds), spread over the mesh by least cost, where crossing a sculpted groove
   * (relief: a point below its neighbourhood's mean) is expensive, so colours meet at the plates' seams. `spread` caps
   * how far (measured units) a small part's colour may travel from its seeds; beyond that `fallback` paints. Region
   * swatches in `keep` still win (measured glow discs). The texture is then just the palette.
   */
  blocks?: { classify(r: number, g: number, b: number): string | undefined; fallback: string; spread?: Record<string, number>; smooth?: number; seedThreshold?: number };
};
type LoadedProjection = Projection & { width: number; height: number; rgb: Buffer; fg: Uint8Array; crop: [number, number, number, number] };
/** Texture layout with a projection: the image above, a strip of palette cells below. */
const PROJECT_PX = 1024, STRIP = PALETTE_CELL, IMAGE_ROWS = PROJECT_PX - STRIP;

async function loadProjection(spec: Projection): Promise<LoadedProjection> {
  const sharp = (await import("sharp")).default;
  const { data: rgb, info } = await sharp(join(SRC, spec.image)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, margin = spec.margin ?? 24, fg = new Uint8Array(W * H);
  // Character vs background: the background is a smooth gradient, so each row's colour is read at the margins.
  for (let y = 0; y < H; y++) {
    const samples: number[][] = [];
    for (const x0 of [margin, W - margin - 12]) for (let x = x0; x < x0 + 12; x++) samples.push([...rgb.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)]);
    const bg = [0, 1, 2].map(c => samples.map(q => q[c]).sort((a, b) => a - b)[samples.length >> 1]);
    for (let x = margin; x < W - margin; x++) { const o = (y * W + x) * 3; if (Math.hypot(rgb[o] - bg[0], rgb[o + 1] - bg[1], rgb[o + 2] - bg[2]) > 48) fg[y * W + x] = 1; }
  }
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fg[y * W + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const pad = 8;
  return { ...spec, width: W, height: H, rgb, fg, crop: [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(W, x1 + pad + 1), Math.min(H, y1 + pad + 1)] };
}

/** Image pixel (u, v) and depth w (smaller is nearer) of a measured point under the projection's camera. */
function projectPoint(M: number[], p: V3): [number, number, number] {
  const w = M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11];
  return [(M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3]) / w, (M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7]) / w, w];
}

/**
 * Paint an untextured mesh (BotConfig.paint). Each corner takes the swatch `region` gives it (with the triangle's
 * normal); a triangle whose corners fall in two swatches is split where the boundary crosses its edges (found by
 * bisection), so colour edges follow the region rule rather than the mesh's triangles. Vertices are split per swatch
 * and each points its UV at the centre of its swatch's cell in a small palette texture (writePalette).
 */
function paintMesh(m: { count: number; pos: Float64Array; nrm: Float64Array; uv: Float64Array; indices: number[]; skinJoints: Uint8Array; skinWeights: Uint8Array; label: Uint8Array }, paint: NonNullable<BotConfig["paint"]>, proj?: LoadedProjection) {
  const names = Object.keys(paint.swatches);
  const cellUv = (k: number): [number, number] => {
    if (proj && !proj.blocks) return [(k + 0.5) * PALETTE_CELL / PROJECT_PX, (IMAGE_ROWS + STRIP / 2) / PROJECT_PX];
    const size = PALETTE_CELL * PALETTE_COLS;
    return [((k % PALETTE_COLS) + 0.5) * PALETTE_CELL / size, (Math.floor(k / PALETTE_COLS) + 0.5) * PALETTE_CELL / size];
  };
  // With a projection, swatch index `names.length` is "image": UVs projected into the reference instead of a cell.
  const IMAGE = names.length;
  let visible = (_p: V3, _n: V3) => false;
  if (proj) {
    // Depth buffer of the mesh as the camera sees it, at the image's resolution.
    const M = proj.camera.matrix, W = proj.width, H = proj.height, zb = new Float32Array(W * H).fill(Infinity);
    const px = Array.from({ length: m.count }, (_, i) => projectPoint(M, [m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]]));
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [px[m.indices[t]], px[m.indices[t + 1]], px[m.indices[t + 2]]];
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (Math.abs(area) < 1e-12) continue;
      const xa = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), xb = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const ya = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), yb = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        const w1 = ((x + 0.5 - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y + 0.5 - a[1])) / area, w2 = ((b[0] - a[0]) * (y + 0.5 - a[1]) - (x + 0.5 - a[0]) * (b[1] - a[1])) / area;
        if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
        const z = a[2] + w1 * (b[2] - a[2]) + w2 * (c[2] - a[2]);
        if (z < zb[y * W + x]) zb[y * W + x] = z;
      }
    }
    const minFacing = proj.minFacing ?? 0.25, [cx0, cy0, cx1, cy1] = proj.crop;
    visible = (p, n) => {
      if (dot(n, norm(sub(proj.camera.eye, p))) < minFacing) return false;
      const [u, v, w] = projectPoint(M, p);
      if (u < cx0 || v < cy0 || u >= cx1 || v >= cy1) return false;
      // Unoccluded: no nearer surface in the pixel or its neighbours (one pixel of slack for the rasterised edges).
      let near = Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = Math.round(u - 0.5) + dx, y = Math.round(v - 0.5) + dy;
        if (x >= 0 && y >= 0 && x < W && y < H) near = Math.min(near, zb[y * W + x]);
      }
      return w <= near + 0.006;
    };
  }
  const keep = new Set(proj?.keep ?? []);
  const swatchName = (k: number) => (k === IMAGE ? "image" : names[k]);
  const block = proj?.blocks ? artBlocks(m, proj, names) : undefined;
  const P = Array.from(m.pos), N = Array.from(m.nrm), J = Array.from(m.skinJoints), W = Array.from(m.skinWeights);
  const L = Array.from({ length: m.count }, (_, i) => (i < m.label.length ? m.label[i] : m.skinJoints[4 * i]));
  const at = (i: number): V3 => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
  const blockSwatches = block && block.map((painted, t) => {
    const v = [m.indices[3 * t], m.indices[3 * t + 1], m.indices[3 * t + 2]];
    const centre = [0, 1, 2].map(c => v.reduce((sum, i) => sum + P[3 * i + c], 0) / 3) as V3;
    const normal = norm([0, 1, 2].map(c => v.reduce((sum, i) => sum + N[3 * i + c], 0)) as V3);
    const part = BONES[L[v[0]]] ?? "upper";
    const region = names.indexOf(paint.region(centre, normal, part));
    return region >= 0 && (keep.has(names[region]) || names[region] === "gold") ? region : painted;
  });
  // Per triangle: relief-guided blocks paint the scanned plates; explicit glow, faceplate and thigh regions settle
  // ambiguous votes once per face so colour seams stay on shared mesh edges and don't open the surface.
  let tri = 0;
  const swatchAt = (p: V3, n: V3) => {
    const k = Math.max(0, names.indexOf(paint.region(p, n, "upper")));
    if (blockSwatches) return blockSwatches[tri];
    return proj && !keep.has(names[k]) && visible(p, n) ? IMAGE : k;
  };
  // A point on edge a→b where the swatch changes (shared by both triangles on that edge, for one normal bucket).
  const crossings = new Map<string, number>();
  const crossing = (a: number, b: number, ka: number, n: V3) => {
    const id = (a < b ? `${a}|${b}` : `${b}|${a}`) + (block ? `|${tri}` : "");
    let j = crossings.get(id);
    if (j !== undefined) return j;
    const A = at(a), B = at(b);
    let lo = 0, hi = 1;
    for (let s = 0; s < 14; s++) {
      const t = (lo + hi) / 2;
      if (swatchAt([0, 1, 2].map(c => A[c] + t * (B[c] - A[c])) as V3, n) === ka) lo = t; else hi = t;
    }
    const t = (lo + hi) / 2, near = t < 0.5 ? a : b;
    j = L.length;
    crossings.set(id, j);
    for (let c = 0; c < 3; c++) P.push(A[c] + t * (B[c] - A[c]));
    N.push(...norm([0, 1, 2].map(c => N[3 * a + c] + t * (N[3 * b + c] - N[3 * a + c])) as V3));
    J.push(...J.slice(4 * near, 4 * near + 4)); W.push(...W.slice(4 * near, 4 * near + 4)); L.push(L[near]);
    return j;
  };
  // Triangles as [vertex, swatch] corners; vertices are split per swatch at the end.
  const tris: Array<[number, number][]> = [];
  const used = new Map<string, number>();
  let split = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    tri = t / 3;
    const v = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    const n = norm([0, 1, 2].map(c => v.reduce((s, i) => s + N[3 * i + c], 0)) as V3);
    const ks = v.map(i => swatchAt(at(i), n));
    const distinct = [...new Set(ks)];
    const emit = (poly: number[], k: number) => { for (let c = 1; c + 1 < poly.length; c++) tris.push([[poly[0], k], [poly[c], k], [poly[c + 1], k]]); used.set(swatchName(k), (used.get(swatchName(k)) ?? 0) + 1); };
    if (distinct.length === 1) { emit(v, ks[0]); continue; }
    if (distinct.length > 2) {
      const c: V3 = [0, 1, 2].map(q => v.reduce((s, i) => s + P[3 * i + q], 0) / 3) as V3;
      emit(v, swatchAt(c, n));
      continue;
    }
    // Two swatches: walk the corners, cutting each mixed edge at its crossing (Sutherland–Hodgman on both sides).
    split++;
    const [kA, kB] = distinct, polyA: number[] = [], polyB: number[] = [];
    for (let c = 0; c < 3; c++) {
      const a = v[c], b = v[(c + 1) % 3];
      (ks[c] === kA ? polyA : polyB).push(a);
      if (ks[c] !== ks[(c + 1) % 3]) { const j = crossing(a, b, ks[c], n); polyA.push(j); polyB.push(j); }
    }
    emit(polyA, kA);
    emit(polyB, kB);
  }
  // Split vertices by swatch.
  const copy = new Map<string, number>();
  const U: number[] = new Array(L.length * 2).fill(0);
  const owner = new Int32Array(L.length).fill(-1);
  const indices: number[] = [];
  let copies = 0;
  for (const tri of tris) for (const [i, k] of tri) {
    if (owner[i] === -1 || owner[i] === k) { owner[i] = k; indices.push(i); continue; }
    const id = `${i}|${k}`;
    let j = copy.get(id);
    if (j === undefined) {
      j = L.length;
      copy.set(id, j);
      copies++;
      P.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]); N.push(N[3 * i], N[3 * i + 1], N[3 * i + 2]);
      J.push(...J.slice(4 * i, 4 * i + 4)); W.push(...W.slice(4 * i, 4 * i + 4)); L.push(L[i]); U.push(0, 0);
    }
    indices.push(j);
  }
  const count = L.length;
  const kOf = new Int32Array(count).fill(0);
  for (let i = 0; i < owner.length; i++) kOf[i] = Math.max(0, owner[i]);
  for (const [id, j] of copy) kOf[j] = Number(id.split("|")[1]);
  for (let i = 0; i < count; i++) {
    if (proj && kOf[i] === IMAGE) {
      // The projected pixel, mapped from the crop onto the texture's image rows.
      const [u, v] = projectPoint(proj.camera.matrix, [P[3 * i], P[3 * i + 1], P[3 * i + 2]]), [x0, y0, x1, y1] = proj.crop;
      U[2 * i] = Math.min(1, Math.max(0, (u - x0) / (x1 - x0)));
      U[2 * i + 1] = Math.min(1, Math.max(0, (v - y0) / (y1 - y0))) * IMAGE_ROWS / PROJECT_PX;
      continue;
    }
    const [u, w] = cellUv(kOf[i]); U[2 * i] = u; U[2 * i + 1] = w;
  }
  console.log(`  painted: ${[...used].map(([k, n]) => `${k} ${n}`).join(", ")} triangles; ${split} split at colour edges, ${copies} vertices duplicated`);
  return {
    count, pos: Float64Array.from(P), nrm: Float64Array.from(N), uv: Float64Array.from(U), indices,
    skinJoints: Uint8Array.from(J), skinWeights: Uint8Array.from(W), label: Uint8Array.from(L),
  };
}

/** The palette texture for paintMesh: base colour and metallic-roughness (glTF packing: G roughness, B metalness). */
async function writePalette(name: string, paint: NonNullable<BotConfig["paint"]>, proj?: LoadedProjection) {
  if (proj && !proj.blocks) return writeProjected(name, paint, proj);
  const sharp = (await import("sharp")).default;
  const size = PALETTE_CELL * PALETTE_COLS;
  const color = Buffer.alloc(size * size * 3), mr = Buffer.alloc(size * size * 3);
  Object.values(paint.swatches).forEach((s, k) => {
    const x0 = (k % PALETTE_COLS) * PALETTE_CELL, y0 = Math.floor(k / PALETTE_COLS) * PALETTE_CELL;
    for (let y = y0; y < y0 + PALETTE_CELL; y++) for (let x = x0; x < x0 + PALETTE_CELL; x++) {
      const o = (y * size + x) * 3;
      color.set(s.rgb, o);
      mr.set([255, Math.round(s.rough * 255), Math.round(s.metal * 255)], o);
    }
  });
  // Lossless: the cells are flat colour and the texture is tiny.
  await sharp(color, { raw: { width: size, height: size, channels: 3 } }).webp({ lossless: true }).toFile(join(OUT, `${name}-color.webp`));
  await sharp(mr, { raw: { width: size, height: size, channels: 3 } }).webp({ lossless: true }).toFile(join(OUT, `${name}-mr.webp`));
  return { color: `${name}-color.webp`, mr: `${name}-mr.webp` };
}

/**
 * Block colours for paint.project.blocks: per triangle, the swatch index. Seeds are triangles the camera sees facing
 * it whose projected centroid's 5×5 neighbourhood in the art is ≥ 80% one class; a multi-source least-cost fill over
 * triangle adjacency spreads them (edge cost: centroid distance × (1 + 60 g²), g = the edge's groove depth / 0.01, depth
 * from the relief within 0.1), capped per swatch by `spread`; the rest is `fallback`. Then `smooth` passes of
 * area-weighted majority across groove-free edges snap ragged fringes to the seams.
 */
function artBlocks(m: { count: number; pos: Float64Array; indices: number[] }, proj: LoadedProjection, names: string[]) {
  const spec = proj.blocks!, T = m.indices.length / 3, R = 0.1;
  const P = (i: number): V3 => [m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]];
  const keyOf = new Map<string, number>(), weld = new Int32Array(m.count);
  for (let i = 0; i < m.count; i++) { const k = P(i).map(v => Math.round(v * 2000)).join(","); if (!keyOf.has(k)) keyOf.set(k, i); weld[i] = keyOf.get(k)!; }
  const fn: V3[] = [], area: number[] = [], cen: V3[] = [];
  for (let t = 0; t < T; t++) {
    const [a, b, c] = [0, 1, 2].map(k => P(m.indices[3 * t + k]));
    const ab = sub(b, a), ac = sub(c, a), x: V3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    area.push(len(x) / 2); fn.push(norm(x)); cen.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
  }
  const edges = new Map<string, number[]>();
  for (let t = 0; t < T; t++) for (let e = 0; e < 3; e++) {
    const a = weld[m.indices[3 * t + e]], b = weld[m.indices[3 * t + (e + 1) % 3]], k = a < b ? `${a}|${b}` : `${b}|${a}`;
    (edges.get(k) ?? edges.set(k, []).get(k)!).push(t);
  }
  // Relief: how far below its neighbourhood's mean (along its normal) each vertex sits.
  const vn = new Float64Array(m.count * 3);
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) { const w = weld[m.indices[3 * t + k]]; for (let c = 0; c < 3; c++) vn[3 * w + c] += fn[t][c] * area[t]; }
  const reps = [...new Set(Array.from(weld))], grid = new Map<string, number[]>();
  const cell = (p: V3, d = [0, 0, 0]) => p.map((v, c) => Math.floor(v / R) + d[c]).join(",");
  for (const v of reps) { const k = cell(P(v)); (grid.get(k) ?? grid.set(k, []).get(k)!).push(v); }
  const depth = new Float64Array(m.count);
  for (const v of reps) {
    const p = P(v), nv = norm([vn[3 * v], vn[3 * v + 1], vn[3 * v + 2]]), sum: V3 = [0, 0, 0];
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (const u of grid.get(cell(p, [dx, dy, dz])) ?? []) {
      const q = P(u), d = sub(q, p);
      if (dot(d, d) > R * R || dot(norm([vn[3 * u], vn[3 * u + 1], vn[3 * u + 2]]), nv) < 0.2) continue;
      sum[0] += q[0]; sum[1] += q[1]; sum[2] += q[2]; n++;
    }
    if (n >= 4) depth[v] = Math.max(0, dot(sub([sum[0] / n, sum[1] / n, sum[2] / n], p), nv));
  }
  // Seeds from the art.
  const M = proj.camera.matrix, W = proj.width, H = proj.height, zb = new Float32Array(W * H).fill(Infinity), owner = new Int32Array(W * H).fill(-1);
  const px = Array.from({ length: m.count }, (_, i) => projectPoint(M, P(i)));
  for (let t = 0; t < T; t++) {
    const [a, b, c] = [0, 1, 2].map(k => px[m.indices[3 * t + k]]);
    const ar = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(ar) < 1e-12) continue;
    for (let y = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))); y <= Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1]))); y++)
      for (let x = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))); x <= Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0]))); x++) {
        const w1 = ((x + 0.5 - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y + 0.5 - a[1])) / ar, w2 = ((b[0] - a[0]) * (y + 0.5 - a[1]) - (x + 0.5 - a[0]) * (b[1] - a[1])) / ar;
        if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
        const z = a[2] + w1 * (b[2] - a[2]) + w2 * (c[2] - a[2]);
        if (z < zb[y * W + x]) { zb[y * W + x] = z; owner[y * W + x] = t; }
      }
  }
  const seen = new Uint8Array(T);
  for (const t of owner) if (t >= 0) seen[t] = 1;
  const classAt = (x: number, y: number) => { const o = 3 * (y * W + x), k = spec.classify(proj.rgb[o], proj.rgb[o + 1], proj.rgb[o + 2]); return k === undefined ? -1 : names.indexOf(k); };
  const cls = new Int32Array(T).fill(-1), dist = new Float64Array(T).fill(Infinity);
  const heap: Array<[number, number]> = [];
  const push = (d: number, t: number) => { heap.push([d, t]); for (let i = heap.length - 1; i;) { const q = (i - 1) >> 1; if (heap[q][0] <= heap[i][0]) break; [heap[q], heap[i]] = [heap[i], heap[q]]; i = q; } };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) { heap[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let k = i; if (l < heap.length && heap[l][0] < heap[k][0]) k = l; if (r < heap.length && heap[r][0] < heap[k][0]) k = r; if (k === i) break; [heap[k], heap[i]] = [heap[i], heap[k]]; i = k; } }
    return top;
  };
  let seeds = 0;
  for (let t = 0; t < T; t++) {
    if (!seen[t] || dot(fn[t], norm(sub(proj.camera.eye, cen[t]))) < 0.4) continue;
    const [u, v] = projectPoint(M, cen[t]), votes = new Map<number, number>();
    let all = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = Math.round(u) + dx, y = Math.round(v) + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      all++;
      const k = classAt(x, y);
      if (k >= 0) votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    const [best, count] = [...votes].sort((a, b) => b[1] - a[1])[0] ?? [-1, 0];
    if (best >= 0 && count >= (spec.seedThreshold ?? 0.8) * all) { cls[t] = best; dist[t] = 0; push(0, t); seeds++; }
  }
  const nbr: Array<Array<[number, number]>> = Array.from({ length: T }, () => []), flat: number[][] = Array.from({ length: T }, () => []);
  for (const [k, ts] of edges) {
    if (ts.length !== 2) continue;
    const [a, b] = k.split("|").map(Number), g = Math.max(depth[a], depth[b]) / 0.01, cost = len(sub(cen[ts[0]], cen[ts[1]])) * (1 + 60 * g * g);
    nbr[ts[0]].push([ts[1], cost]); nbr[ts[1]].push([ts[0], cost]);
    if (g < 0.6) { flat[ts[0]].push(ts[1]); flat[ts[1]].push(ts[0]); }
  }
  const cap = names.map(nm => spec.spread?.[nm] ?? Infinity);
  while (heap.length) {
    const [d, t] = pop();
    if (d > dist[t]) continue;
    for (const [u, c] of nbr[t]) if (d + c < dist[u] && d + c <= cap[cls[t]]) { dist[u] = d + c; cls[u] = cls[t]; push(d + c, u); }
  }
  const fallback = Math.max(0, names.indexOf(spec.fallback));
  for (let t = 0; t < T; t++) if (cls[t] < 0) cls[t] = fallback;
  for (let it = 0; it < (spec.smooth ?? 6); it++) {
    const next = cls.slice();
    for (let t = 0; t < T; t++) {
      const w = new Float64Array(names.length);
      w[cls[t]] += area[t];
      for (const u of flat[t]) w[cls[u]] += area[u];
      next[t] = w.indexOf(Math.max(...w));
    }
    cls.set(next);
  }
  console.log(`  blocks: ${seeds} seed triangles from ${proj.image}; ${names.map((nm, k) => `${nm} ${cls.filter(c => c === k).length}`).join(", ")}`);
  return cls;
}

/**
 * Texture for a projected paint (BotConfig.paint.project): the reference cropped to the character on the top rows, its
 * background replaced by the nearest character colour (grown outward a ring at a time), and the palette cells in the
 * bottom strip. Metallic-roughness follows each texel's nearest swatch by hue (grey → the least saturated swatch).
 */
async function writeProjected(name: string, paint: NonNullable<BotConfig["paint"]>, proj: LoadedProjection) {
  const sharp = (await import("sharp")).default;
  const [x0, y0, x1, y1] = proj.crop, cw = x1 - x0, ch = y1 - y0;
  const crop = Buffer.alloc(cw * ch * 3), known = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const s = (y + y0) * proj.width + x + x0;
    if (!proj.fg[s]) continue;
    known[y * cw + x] = 1;
    crop.set(proj.rgb.subarray(3 * s, 3 * s + 3), 3 * (y * cw + x));
  }
  for (let ring = 0, grown = 1; ring < 64 && grown; ring++) {
    grown = 0;
    const next = known.slice();
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      if (known[y * cw + x]) continue;
      const sum = [0, 0, 0];
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= cw || yy >= ch || !known[yy * cw + xx]) continue;
        for (let c = 0; c < 3; c++) sum[c] += crop[3 * (yy * cw + xx) + c];
        n++;
      }
      if (!n) continue;
      for (let c = 0; c < 3; c++) crop[3 * (y * cw + x) + c] = Math.round(sum[c] / n);
      next[y * cw + x] = 1; grown++;
    }
    known.set(next);
  }
  const image = await sharp(crop, { raw: { width: cw, height: ch, channels: 3 } }).resize(PROJECT_PX, IMAGE_ROWS, { fit: "fill" }).raw().toBuffer();
  const swatches = Object.values(paint.swatches);
  const hsv = (r: number, g: number, b: number) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const h = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, mx ? d / mx : 0, mx / 255];
  };
  const tones = swatches.map(s => hsv(...s.rgb));
  const greyest = tones.reduce((best, t, k) => (t[1] < tones[best][1] ? k : best), 0);
  const nearest = (r: number, g: number, b: number) => {
    const [h, sat] = hsv(r, g, b);
    if (sat < 0.15) return greyest;
    let best = 0, bestD = Infinity;
    tones.forEach((t, k) => { if (k === greyest) return; const d = Math.min(Math.abs(h - t[0]), 360 - Math.abs(h - t[0])); if (d < bestD) { bestD = d; best = k; } });
    return best;
  };
  const color = Buffer.alloc(PROJECT_PX * PROJECT_PX * 3), mr = Buffer.alloc(PROJECT_PX * PROJECT_PX * 3);
  for (let i = 0; i < PROJECT_PX * IMAGE_ROWS; i++) {
    const [r, g, b] = [image[3 * i], image[3 * i + 1], image[3 * i + 2]], s = swatches[nearest(r, g, b)];
    color.set([r, g, b], 3 * i);
    mr.set([255, Math.round(s.rough * 255), Math.round(s.metal * 255)], 3 * i);
  }
  swatches.forEach((s, k) => {
    for (let y = IMAGE_ROWS; y < PROJECT_PX; y++) for (let x = k * PALETTE_CELL; x < (k + 1) * PALETTE_CELL; x++) {
      const o = 3 * (y * PROJECT_PX + x);
      color.set(s.rgb, o);
      mr.set([255, Math.round(s.rough * 255), Math.round(s.metal * 255)], o);
    }
  });
  await sharp(color, { raw: { width: PROJECT_PX, height: PROJECT_PX, channels: 3 } }).webp({ quality: 90 }).toFile(join(OUT, `${name}-color.webp`));
  await sharp(mr, { raw: { width: PROJECT_PX, height: PROJECT_PX, channels: 3 } }).webp({ quality: 90 }).toFile(join(OUT, `${name}-mr.webp`));
  console.log(`  projected: ${proj.image} crop ${cw}×${ch} → ${PROJECT_PX}×${IMAGE_ROWS}, palette strip below`);
  return { color: `${name}-color.webp`, mr: `${name}-mr.webp` };
}

/**
 * Rig a model's own open hand (BotConfig.fingers): among side `side`'s hand vertices, the welded pieces farther than
 * `radius` from `palm` are fingers, matched to the nearest `tips` and relabelled to their finger bone, with a
 * knuckle pivot (the piece's base ring) and a curl axis toward the palm.
 */
function rigFingers(m: { count: number; pos: Float64Array; indices: number[]; label: Uint8Array }, spec: NonNullable<BotConfig["fingers"]>): NonNullable<Rig["fingers"]> {
  const s = spec.side > 0 ? "+1" : "-1";
  const hand = BONES.indexOf(`hand${s}` as Bone);
  const at = (i: number): V3 => [m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]];
  const far = (i: number) => m.label[i] === hand && len(sub(at(i), spec.palm)) > spec.radius;
  const key = new Map<string, number>();
  const weldId = Array.from({ length: m.count }, (_, i) => { const k = at(i).map(v => Math.round(v * 1e4)).join(","); if (!key.has(k)) key.set(k, key.size); return key.get(k)!; });
  const adj = new Map<number, number[]>();
  for (let t = 0; t < m.indices.length; t += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
    const i = m.indices[t + a], j = m.indices[t + b];
    if (!far(i) || !far(j)) continue;
    adj.set(weldId[i], [...(adj.get(weldId[i]) ?? []), weldId[j]]);
    adj.set(weldId[j], [...(adj.get(weldId[j]) ?? []), weldId[i]]);
  }
  const piece = new Map<number, number>();
  let pieces = 0;
  for (let i = 0; i < m.count; i++) {
    if (!far(i) || piece.has(weldId[i])) continue;
    const id = pieces++, stack = [weldId[i]];
    piece.set(weldId[i], id);
    while (stack.length) for (const nb of adj.get(stack.pop()!) ?? []) if (!piece.has(nb)) { piece.set(nb, id); stack.push(nb); }
  }
  const tipOf = new Map<number, V3>();
  for (let i = 0; i < m.count; i++) {
    const pc = far(i) ? piece.get(weldId[i]) : undefined;
    if (pc === undefined) continue;
    const best = tipOf.get(pc);
    if (!best || len(sub(at(i), spec.palm)) > len(sub(best, spec.palm))) tipOf.set(pc, at(i));
  }
  const fingerOf = new Map<number, Finger>();
  for (const [pc, tip] of tipOf) {
    const match = FINGERS.filter(f => spec.tips[f]).map(f => ({ f, d: len(sub(tip, spec.tips[f]!)) })).sort((a, b) => a.d - b.d)[0];
    if (match && match.d < 0.3) fingerOf.set(pc, match.f);
    else if (match) console.log(`  finger piece tip ${tip.map(v => v.toFixed(2)).join(",")} matched nothing (nearest ${match.f} ${match.d.toFixed(2)})`);
  }
  const ring = new Map<Finger, V3[]>();
  for (let i = 0; i < m.count; i++) {
    const pc = far(i) ? piece.get(weldId[i]) : undefined;
    const f = pc === undefined ? undefined : fingerOf.get(pc);
    if (!f) continue;
    m.label[i] = BONES.indexOf(`${f}${s}` as Bone);
    if (len(sub(at(i), spec.palm)) < spec.radius + 0.1) ring.set(f, [...(ring.get(f) ?? []), at(i)]);
  }
  const fingers: NonNullable<Rig["fingers"]> = [];
  for (const f of FINGERS) {
    const pts = ring.get(f), tip = spec.tips[f];
    if (!pts || !tip) continue;
    const pivot = [0, 1, 2].map(k => pts.reduce((sum, p) => sum + p[k], 0) / pts.length) as V3;
    const dir = norm(sub(tip, pivot)), toPalm = sub(spec.palm, pivot);
    const inward = norm(sub(toPalm, dir.map(v => v * dot(toPalm, dir)) as V3));
    const curl = norm([dir[1] * inward[2] - dir[2] * inward[1], dir[2] * inward[0] - dir[0] * inward[2], dir[0] * inward[1] - dir[1] * inward[0]]);
    fingers.push({ name: f, pivot: [pivot, pivot], curl: [curl, curl], tip: [tip, tip] });
    console.log(`  ${f}${s}: knuckle ${pivot.map(v => v.toFixed(2)).join(",")}`);
  }
  return fingers;
}

/** Fingers with their own bones (BotConfig.handTransplant), each a child of its side's hand. */
const FINGERS = ["index", "middle", "ring", "thumb"] as const;
type Finger = (typeof FINGERS)[number];

/** Row-major 3×3 rotation turning unit vector `a` onto unit vector `b` (shortest arc). */
function rotationBetween(a: V3, b: V3): number[] {
  const v: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const c = dot(a, b), s = len(v);
  if (s < 1e-9) return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : rotationAbout(norm(Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[2], 0, a[0]]), Math.PI);
  return rotationAbout(norm(v), Math.atan2(s, c));
}

/** Row-major 3×3 rotation by `angle` about the unit axis `k` (right-hand rule, Rodrigues). */
function rotationAbout(k: V3, angle: number): number[] {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c, [x, y, z] = k;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}
const apply = (m: number[], [x, y, z]: V3): V3 => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const compose = (a: number[], b: number[]) => Array.from({ length: 9 }, (_, k) => { const r = Math.floor(k / 3), c = k % 3; return a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c]; });

/**
 * Copy side `from`'s sculpted hand (everything past its wrist plane, crossing triangles clipped) onto the other wrist:
 * mirrored into the other hand, turned so its forearm axis lies along the target forearm's, rolled about it by `roll`
 * and moved onto the target wrist. Its extended fingers (pieces of the mesh farther than `radius` from `palm`, matched
 * to the nearest `tips`) get finger labels, each with a knuckle pivot (the piece's base ring) and a curl axis that
 * swings the finger toward the palm. Positions are in measured units; the result is appended to the mesh.
 */
function transplantHand(m: { pos: Float64Array; nrm: Float64Array; uv: Float64Array; indices: number[]; label: Uint8Array; lum: Float32Array }, source: SourceHand, rig: Rig, spec: NonNullable<BotConfig["handTransplant"]>, keepOpen?: Set<string>) {
  const from = spec.from > 0 ? 1 : 0, to = 1 - from;
  // Source frame: side `from`'s wrist and forearm, or the donor hand's own axis.
  const Ws = spec.donor ? spec.donor.wrist : rig.wrist[from];
  const As = spec.donor ? norm(sub(spec.donor.toward, spec.donor.wrist)) : norm(sub(rig.wrist[from], rig.elbow[from])), At = norm(sub(rig.wrist[to], rig.elbow[to]));
  const flipX = ([x, y, z]: V3): V3 => [-x, y, z];
  const turn = compose(rotationAbout(At, spec.roll), spec.preserveFacing
    ? [1, 0, 0, 0, 1, 0, 0, 0, 1]
    : rotationBetween(flipX(As), At));
  const sink = spec.sink ?? 0;
  const place = (p: V3): V3 => { const q = apply(turn, flipX(sub(p, Ws))); return [0, 1, 2].map(c => q[c] + rig.wrist[to][c] - At[c] * sink) as V3; };
  // Fingers: welded pieces beyond the palm radius, each matched to its nearest configured tip.
  const n = source.pos.length / 3;
  const at = (i: number): V3 => [source.pos[3 * i], source.pos[3 * i + 1], source.pos[3 * i + 2]];
  const key = new Map<string, number>();
  const weldId = Array.from({ length: n }, (_, i) => { const k = at(i).map(v => Math.round(v * 1e4)).join(","); if (!key.has(k)) key.set(k, key.size); return key.get(k)!; });
  const far = (i: number) => len(sub(at(i), spec.fingers.palm)) > spec.fingers.radius;
  const adj = new Map<number, number[]>();
  for (let t = 0; t < source.indices.length; t += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
    const i = source.indices[t + a], j = source.indices[t + b];
    if (!far(i) || !far(j)) continue;
    adj.set(weldId[i], [...(adj.get(weldId[i]) ?? []), weldId[j]]);
    adj.set(weldId[j], [...(adj.get(weldId[j]) ?? []), weldId[i]]);
  }
  const piece = new Map<number, number>();
  let pieces = 0;
  for (let i = 0; i < n; i++) {
    if (!far(i) || piece.has(weldId[i])) continue;
    const id = pieces++, stack = [weldId[i]];
    piece.set(weldId[i], id);
    while (stack.length) for (const nb of adj.get(stack.pop()!) ?? []) if (!piece.has(nb)) { piece.set(nb, id); stack.push(nb); }
  }
  const pieceOf = (i: number) => piece.get(weldId[i]) ?? -1;
  // Each piece's farthest point decides its finger; pieces far from every tip (knuckle bumps) stay on the hand.
  const tipOf = new Map<number, V3>();
  for (let i = 0; i < n; i++) {
    const pc = pieceOf(i);
    if (pc < 0) continue;
    const best = tipOf.get(pc);
    if (!best || len(sub(at(i), spec.fingers.palm)) > len(sub(best, spec.fingers.palm))) tipOf.set(pc, at(i));
  }
  const fingerOf = new Map<number, Finger>();
  for (const [pc, tip] of tipOf) {
    const match = FINGERS.filter(f => spec.fingers.tips[f]).map(f => ({ f, d: len(sub(tip, spec.fingers.tips[f]!)) })).sort((a, b) => a.d - b.d)[0];
    if (match && match.d < 0.3) fingerOf.set(pc, match.f);
  }
  const s = to ? "+1" : "-1";
  const P = Array.from(m.pos), N = Array.from(m.nrm), U = Array.from(m.uv), L = Array.from(m.label), Lum = Array.from(m.lum);
  const base = L.length;
  const ring = new Map<Finger, V3[]>();
  for (let i = 0; i < n; i++) {
    const f = fingerOf.get(pieceOf(i));
    P.push(...place(at(i)));
    N.push(...apply(turn, flipX([source.nrm[3 * i], source.nrm[3 * i + 1], source.nrm[3 * i + 2]])));
    U.push(source.uv[2 * i], source.uv[2 * i + 1]);
    L.push(BONES.indexOf(f ? `${f}${s}` as Bone : `hand${s}` as Bone));
    Lum.push(source.lum[i]);
    if (f && len(sub(at(i), spec.fingers.palm)) < spec.fingers.radius + 0.1) ring.set(f, [...(ring.get(f) ?? []), at(i)]);
  }
  for (const j of source.rim) keepOpen?.add(rimKey(P[3 * (base + j)], P[3 * (base + j) + 1], P[3 * (base + j) + 2]));
  // The copy is mirrored: reverse the winding so it faces out.
  const indices = [...m.indices];
  for (let t = 0; t < source.indices.length; t += 3) indices.push(base + source.indices[t], base + source.indices[t + 2], base + source.indices[t + 1]);
  // Knuckles: the base ring's centre; curl axis: finger direction × the way toward the palm (right-hand rule).
  const palm = place(spec.fingers.palm);
  const fingers: NonNullable<Rig["fingers"]> = [];
  for (const f of FINGERS) {
    const pts = ring.get(f), tip = spec.fingers.tips[f];
    if (!pts || !tip) continue;
    const pivot = place([0, 1, 2].map(k => pts.reduce((sum, p) => sum + p[k], 0) / pts.length) as V3);
    const dir = norm(sub(place(tip), pivot)), toPalm = sub(palm, pivot);
    const inward = norm(sub(toPalm, dir.map(v => v * dot(toPalm, dir)) as V3));
    const curl = norm([dir[1] * inward[2] - dir[2] * inward[1], dir[2] * inward[0] - dir[0] * inward[2], dir[0] * inward[1] - dir[1] * inward[0]]);
    // Only side `to` is real here; the bake's mirror fills in the other side.
    fingers.push({ name: f, pivot: [pivot, pivot], curl: [curl, curl], tip: [place(tip), place(tip)] });
    console.log(`  ${f}${s}: ${[...fingerOf.values()].filter(v => v === f).length} piece(s), knuckle ${pivot.map(v => v.toFixed(2)).join(",")}`);
  }
  console.log(`  hand from side ${from ? "+1" : "-1"} placed on side ${s}: ${n} vertices, roll ${spec.roll}`);
  return {
    count: L.length, pos: Float64Array.from(P), nrm: Float64Array.from(N), uv: Float64Array.from(U), indices,
    label: Uint8Array.from(L), lum: Float32Array.from(Lum), fingers,
  };
}

/**
 * The donor's hand as a SourceHand (BotConfig.handTransplant.donor): the triangles in front of the plane
 * dot(p, keep.axis) > keep.at (crossing ones dropped; the open back is capped later), welded, decimated to
 * `triangles`, and painted with two texels of the bot's own base colour: `shell` everywhere and `glow` on the palm
 * repulsor (within `repulsor` of `palm`, facing the palm's way).
 */
async function donorHand(donor: NonNullable<NonNullable<BotConfig["handTransplant"]>["donor"]>, palm: V3, paint: { shell: [number, number]; glow: [number, number]; shellLum: number; glowLum: number }): Promise<SourceHand> {
  const d = loadDonor(resolve(donor.file));
  const ax = norm(donor.keep.axis);
  const dist = (i: number) => d.pos[3 * i] * ax[0] + d.pos[3 * i + 1] * ax[1] + d.pos[3 * i + 2] * ax[2] - donor.keep.at;
  // Clip at the plane (crossing triangles cut, new points on it), so the back of the hand ends in a planar rim.
  const P: number[] = [], N: number[] = [], tris: number[] = [], local = new Map<string, number>(), rim: number[] = [];
  const vertex = (a: number, b = a) => {
    const id = a <= b ? `${a}|${b}` : `${b}|${a}`;
    let j = local.get(id);
    if (j !== undefined) return j;
    const t = a === b ? 0 : dist(a) / (dist(a) - dist(b));
    j = P.length / 3;
    local.set(id, j);
    for (let c = 0; c < 3; c++) P.push(d.pos[3 * a + c] + t * (d.pos[3 * b + c] - d.pos[3 * a + c]));
    N.push(...norm([0, 1, 2].map(c => d.nrm[3 * a + c] + t * (d.nrm[3 * b + c] - d.nrm[3 * a + c])) as V3));
    if (a !== b) rim.push(j);
    return j;
  };
  for (let t = 0; t < d.indices.length; t += 3) {
    const v = [d.indices[t], d.indices[t + 1], d.indices[t + 2]], ds = v.map(dist);
    if (ds.every(x => x <= 0)) continue;
    const poly: number[] = [];
    for (let c = 0; c < 3; c++) {
      const a = v[c], b = v[(c + 1) % 3];
      if (ds[c] > 0) poly.push(vertex(a));
      if ((ds[c] > 0) !== (ds[(c + 1) % 3] > 0)) poly.push(vertex(a, b));
    }
    for (let c = 1; c + 1 < poly.length; c++) tris.push(poly[0], poly[c], poly[c + 1]);
  }
  // Close the back with a plate: the rim fanned from its centre in angle order (the palm outline is star-shaped
  // about it), wound to face back along −keep.axis, and domed out so it reads as the back of an armoured hand rather
  // than a flat cut.
  if (rim.length >= 3) {
    const c: V3 = [0, 1, 2].map(k => rim.reduce((sum, j) => sum + P[3 * j + k], 0) / rim.length) as V3;
    const e1 = norm(Math.abs(ax[1]) < 0.9 ? [ax[2], 0, -ax[0]] : [0, ax[2], -ax[1]]);
    const e2: V3 = [ax[1] * e1[2] - ax[2] * e1[1], ax[2] * e1[0] - ax[0] * e1[2], ax[0] * e1[1] - ax[1] * e1[0]];
    const angle = (j: number) => { const v = sub([P[3 * j], P[3 * j + 1], P[3 * j + 2]], c); return Math.atan2(dot(v, e2), dot(v, e1)); };
    const ring = [...rim].sort((a, b) => angle(a) - angle(b));
    const back = norm(ax.map(v => -v) as V3);
    const radius = ring.reduce((sum, j) => sum + len(sub([P[3 * j], P[3 * j + 1], P[3 * j + 2]], c)), 0) / ring.length;
    const centre = P.length / 3;
    P.push(...c.map((v, k) => v + back[k] * radius * 0.28)); N.push(...back);
    // One cap vertex per rim point too, tilted outward like the dome's edge, so the rim keeps its own normals.
    const capRing = ring.map(j => {
      const k = P.length / 3, out = norm(sub([P[3 * j], P[3 * j + 1], P[3 * j + 2]], c));
      P.push(P[3 * j], P[3 * j + 1], P[3 * j + 2]); N.push(...norm(back.map((v, q) => v + out[q] * 0.55) as V3));
      return k;
    });
    for (let r = 0; r < capRing.length; r++) {
      const a = capRing[r], b = capRing[(r + 1) % capRing.length];
      // Facing −axis: (b − centre) × (a − centre) should point along −axis.
      const pa = sub([P[3 * a], P[3 * a + 1], P[3 * a + 2]], c), pb = sub([P[3 * b], P[3 * b + 1], P[3 * b + 2]], c);
      const cr: V3 = [pa[1] * pb[2] - pa[2] * pb[1], pa[2] * pb[0] - pa[0] * pb[2], pa[0] * pb[1] - pa[1] * pb[0]];
      if (dot(cr, back) > 0) tris.push(centre, a, b); else tris.push(centre, b, a);
    }
  }
  let count = P.length / 3;
  let pos = Float64Array.from(P), nrm = Float64Array.from(N), uv = new Float64Array(count * 2);
  let indices = tris;
  ({ count, pos, nrm, uv, indices } = weld(count, pos, nrm, uv, indices, false));
  // A dense sculpt's hand (Jarvis's donor: 83k triangles) needs a looser error bound to reach the target.
  if (indices.length / 3 > donor.triangles) ({ count, pos, nrm, uv, indices } = await simplify(count, pos, nrm, uv, indices, donor.triangles, 0.05));
  // Paint: the repulsor disc faces where the palm faces (away from the cut plane, along keep.axis).
  const out: SourceHand = { pos: Array.from(pos), nrm: Array.from(nrm), uv: [], lum: [], indices, rim: [] };
  let glowing = 0;
  for (let i = 0; i < count; i++) {
    const p: V3 = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], n: V3 = [nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]];
    const glow = len(sub(p, palm)) < donor.repulsor && dot(n, ax) > 0.5;
    if (glow) glowing++;
    out.uv.push(...(glow ? paint.glow : paint.shell));
    out.lum.push(glow ? paint.glowLum : paint.shellLum);
  }
  console.log(`  donor hand ${donor.file}: ${count} vertices, ${indices.length / 3} triangles (${glowing} repulsor vertices)`);
  return out;
}

/**
 * Two paint texels from the bot's base colour, picked among the given vertices (Jarvis: its sculpted +X hand): the
 * texel nearest `shell` and the most cyan one (the palm repulsor), each where its 5×5 neighbourhood is near-uniform,
 * so bilinear filtering doesn't bleed a seam line in.
 */
async function pickPaint(json: any, image: (i: number) => Uint8Array, material: any, uv: Float64Array, among: number[], shell: [number, number, number]) {
  const tex = json.textures[material.pbrMetallicRoughness.baseColorTexture.index];
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(Buffer.from(image(tex.extensions?.EXT_texture_webp?.source ?? tex.source))).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const texel = (x: number, y: number) => { const k = (Math.min(info.height - 1, Math.max(0, y)) * info.width + Math.min(info.width - 1, Math.max(0, x))) * 3; return [data[k], data[k + 1], data[k + 2]]; };
  const at = (i: number) => [Math.floor((uv[2 * i] - Math.floor(uv[2 * i])) * info.width), Math.floor((uv[2 * i + 1] - Math.floor(uv[2 * i + 1])) * info.height)];
  const spread = (x: number, y: number) => { const c = texel(x, y); let worst = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const o = texel(x + dx, y + dy); worst = Math.max(worst, Math.abs(o[0] - c[0]) + Math.abs(o[1] - c[1]) + Math.abs(o[2] - c[2])); } return worst; };
  let bestShell = { i: among[0], score: Infinity }, bestGlow = { i: among[0], score: -Infinity };
  for (const i of among) {
    const [x, y] = at(i), c = texel(x, y), s = spread(x, y);
    if (s > 40) continue;
    const dShell = Math.abs(c[0] - shell[0]) + Math.abs(c[1] - shell[1]) + Math.abs(c[2] - shell[2]);
    if (dShell < bestShell.score) bestShell = { i, score: dShell };
    const cyan = c[1] > 150 && c[2] > 160 ? c[2] - c[0] : -Infinity;
    if (cyan > bestGlow.score) bestGlow = { i, score: cyan };
  }
  const uvOf = (i: number): [number, number] => [uv[2 * i], uv[2 * i + 1]];
  const lumOf = (i: number) => { const [x, y] = at(i), c = texel(x, y); return (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]) / 255; };
  console.log(`  paint: shell ${texel(...(at(bestShell.i) as [number, number])).join(",")}, glow ${texel(...(at(bestGlow.i) as [number, number])).join(",")}`);
  return { shell: uvOf(bestShell.i), glow: uvOf(bestGlow.i), shellLum: lumOf(bestShell.i), glowLum: lumOf(bestGlow.i) };
}

/** A sculpted hand cut out of the mesh (extractHand): its own vertices and triangles. */
type SourceHand = { pos: number[]; nrm: number[]; uv: number[]; lum: number[]; indices: number[]; rim: number[] };

/** Copy side `k`'s hand: the triangles of its forearm and hand past the wrist plane, crossing ones clipped. */
function extractHand(m: { pos: Float64Array; nrm: Float64Array; uv: Float64Array; indices: number[]; label: Uint8Array; lum: Float32Array }, rig: Rig, k: 0 | 1, offset = 0): SourceHand {
  const axis = norm(sub(rig.wrist[k], rig.elbow[k]));
  const d = (i: number) => dot(sub([m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]], rig.wrist[k]), axis) - offset;
  const parts = [BONES.indexOf(k ? "forearm+1" : "forearm-1"), BONES.indexOf(k ? "hand+1" : "hand-1")];
  const out: SourceHand = { pos: [], nrm: [], uv: [], lum: [], indices: [], rim: [] };
  const local = new Map<string, number>();
  // A source vertex, or a point on edge a→b at the plane (shared by both triangles on that edge).
  const vertex = (a: number, b = a) => {
    const id = a <= b ? `${a}|${b}` : `${b}|${a}`;
    let j = local.get(id);
    if (j !== undefined) return j;
    const s = a === b ? 0 : d(a) / (d(a) - d(b));
    const mix = (arr: ArrayLike<number>, w: number, c: number) => arr[w * a + c] + s * (arr[w * b + c] - arr[w * a + c]);
    j = out.lum.length;
    local.set(id, j);
    out.pos.push(...[0, 1, 2].map(c => mix(m.pos, 3, c)));
    out.nrm.push(...norm([0, 1, 2].map(c => mix(m.nrm, 3, c)) as V3));
    out.uv.push(mix(m.uv, 2, 0), mix(m.uv, 2, 1));
    out.lum.push(m.lum[a] + s * (m.lum[b] - m.lum[a]));
    if (a !== b) out.rim.push(j);
    return j;
  };
  for (let t = 0; t < m.indices.length; t += 3) {
    const v = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    if (!v.some(i => parts.includes(m.label[i]))) continue;
    const ds = v.map(d);
    if (ds.every(x => x <= 0)) continue;
    // Sutherland–Hodgman, keeping the hand side, in the triangle's winding.
    const poly: number[] = [];
    for (let c = 0; c < 3; c++) {
      const a = v[c], b = v[(c + 1) % 3], da = ds[c], db = ds[(c + 1) % 3];
      if (da > 0) poly.push(vertex(a));
      if ((da > 0) !== (db > 0)) poly.push(vertex(a, b));
    }
    for (let c = 1; c + 1 < poly.length; c++) out.indices.push(poly[0], poly[c], poly[c + 1]);
  }
  return out;
}


function weld(count: number, pos: Float64Array, nrm: Float64Array, uv: Float64Array, indices: number[], textured: boolean, minDot = 0.9) {
  const buckets = new Map<string, number[]>();
  const remap = new Int32Array(count);
  const keep: number[] = [];
  const sum: number[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos[3 * i] * 1e4)},${Math.round(pos[3 * i + 1] * 1e4)},${Math.round(pos[3 * i + 2] * 1e4)}` +
      (textured ? `|${Math.round(uv[2 * i] * 1e5)},${Math.round(uv[2 * i + 1] * 1e5)}` : "");
    const list = buckets.get(key) ?? [];
    let j = list.find(k => nrm[3 * i] * nrm[3 * keep[k]] + nrm[3 * i + 1] * nrm[3 * keep[k] + 1] + nrm[3 * i + 2] * nrm[3 * keep[k] + 2] > minDot);
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

async function simplify(count: number, pos: Float64Array, nrm: Float64Array, uv: Float64Array, indices: number[], triangles: number, maxError = 0.02) {
  const { MeshoptSimplifier } = await import("meshoptimizer");
  await MeshoptSimplifier.ready;
  const [kept, error] = MeshoptSimplifier.simplifyWithAttributes(Uint32Array.from(indices), Float32Array.from(pos), 3, Float32Array.from(nrm), 3, [0.4, 0.4, 0.4], null, triangles * 3, maxError);
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
/** Position key shared by capHoles and the cuts that mark rims to leave open. */
const rimKey = (x: number, y: number, z: number) => `${Math.round(x * 2000)},${Math.round(y * 2000)},${Math.round(z * 2000)}`;

function capHoles(m: MeshArrays, lum: Float32Array, label: Uint8Array, keepOpen?: Set<string>): MeshArrays {
  const key = (i: number) => rimKey(m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]);
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
    if (keepOpen?.size && loop.filter(v => keepOpen.has(key(v))).length * 2 > loop.length) continue;
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
