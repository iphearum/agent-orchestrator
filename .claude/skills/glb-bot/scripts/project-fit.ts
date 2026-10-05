// Fit a perspective camera that lays a source .glb over a reference image of it (the art a model was generated
// from), for painting the bot from that image (BotConfig.paint.project). The model is normalised exactly like the bake
// (X mirrored, 8.7 tall, floor at 0, centred; same `yaw`), so the camera is in measured units. The image's character is
// cut from its background (a smooth gradient: each row's colour is read at the left and right margins) and the camera
// (yaw, pitch, roll about the body's centre, scale, offset, distance) is searched to maximise the overlap (IoU) of the
// two silhouettes. Generated art is rendered in perspective (an outstretched hand looks bigger), so the distance matters.
//   bun .claude/skills/glb-bot/scripts/project-fit.ts backend/src/bots/<bot>.glb <reference.png> [--yaw=0] [--margin=24]
//   → prints the `camera` for the CONFIG and the IoU; .ui-check/glb-bot/project-<bot>.png overlays the fitted outline
//     (green: both, red: model only, blue: image only) on the reference.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import sharp from "sharp";
import { OUT } from "./lib";

const [file, ref] = process.argv.slice(2);
if (!file || !ref) { console.error("usage: project-fit.ts <file.glb> <reference.png> [--yaw=0] [--margin=24]"); process.exit(1); }
const flag = (name: string, fallback: number) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const yawDeg = flag("yaw", 0), margin = flag("margin", 24);
type V3 = [number, number, number];

// ---------- the model, normalised like scripts/bake-bots.ts ----------
const buf = readFileSync(file);
const jl = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jl).toString("utf8"));
const bin = new DataView(buf.buffer, buf.byteOffset + 20 + jl + 8, buf.readUInt32LE(20 + jl));
const READ: Record<number, [number, (o: number) => number, number]> = {
  5120: [1, o => bin.getInt8(o), 127], 5121: [1, o => bin.getUint8(o), 255], 5122: [2, o => bin.getInt16(o, true), 32767],
  5123: [2, o => bin.getUint16(o, true), 65535], 5125: [4, o => bin.getUint32(o, true), 4294967295], 5126: [4, o => bin.getFloat32(o, true), 1],
};
const accessor = (i: number, n: number) => {
  const a = json.accessors[i], bv = json.bufferViews[a.bufferView], [size, get, max] = READ[a.componentType];
  const stride = bv.byteStride ?? size * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[a.type];
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), out = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) { const v = get(base + k * stride + c * size); out[k * n + c] = a.normalized ? Math.max(v / max, -1) : v; }
  return out;
};
const local = (n: any): number[] => {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
};
const mul = (a: number[], b: number[]) => Array.from({ length: 16 }, (_, k) => { const c = Math.floor(k / 4), r = k % 4; return [0, 1, 2, 3].reduce((s, i) => s + a[i * 4 + r] * b[c * 4 + i], 0); });
const parents = new Map<number, number>();
json.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parents.set(c, i)));
const world = (i: number): number[] => { const p = parents.get(i); return p === undefined ? local(json.nodes[i]) : mul(world(p), local(json.nodes[i])); };
const meshNode = json.nodes.findIndex((n: any) => n.mesh !== undefined);
const prim = json.meshes[json.nodes[meshNode].mesh].primitives[0], m = world(meshNode);
const raw = accessor(prim.attributes.POSITION, 3), count = raw.length / 3;
const yc = Math.cos(yawDeg * Math.PI / 180), ys = Math.sin(yawDeg * Math.PI / 180);
const pos = new Float64Array(raw.length);
for (let i = 0; i < count; i++) {
  const [x, y, z] = [raw[3 * i], raw[3 * i + 1], raw[3 * i + 2]];
  const p = [-(m[0] * x + m[4] * y + m[8] * z + m[12]), m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
  pos.set([p[0] * yc + p[2] * ys, p[1], -p[0] * ys + p[2] * yc], 3 * i);
}
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], pos[3 * i + c]); mx[c] = Math.max(mx[c], pos[3 * i + c]); }
const k8 = 8.7 / (mx[1] - mn[1]);
for (let i = 0; i < count; i++) {
  pos[3 * i] = (pos[3 * i] - (mn[0] + mx[0]) / 2) * k8; pos[3 * i + 1] = (pos[3 * i + 1] - mn[1]) * k8; pos[3 * i + 2] = (pos[3 * i + 2] - (mn[2] + mx[2]) / 2) * k8;
}
const indices = prim.indices !== undefined ? accessor(prim.indices, 1) : Float64Array.from({ length: count }, (_, i) => i);

// ---------- the image's silhouette ----------
const { data: img, info } = await sharp(ref).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const fg = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  // Background colour of this row: median of the left and right margins (inside any frame border).
  const samples: number[][] = [];
  for (const x0 of [margin, W - margin - 12]) for (let x = x0; x < x0 + 12; x++) samples.push([...img.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)]);
  const bg = [0, 1, 2].map(c => samples.map(s => s[c]).sort((a, b) => a - b)[samples.length >> 1]);
  for (let x = margin; x < W - margin; x++) {
    const o = (y * W + x) * 3;
    if (Math.hypot(img[o] - bg[0], img[o + 1] - bg[1], img[o + 2] - bg[2]) > 48) fg[y * W + x] = 1;
  }
}

// ---------- camera ----------
// q = R (p − centre); a pinhole `dist` units in front of the centre (+q.z) sees u = tx − s·k·q.x, v = ty − s·k·q.y with
// k = dist / (dist − q.z), so s is px per unit at the centre's depth (front view: +x on screen-left, like grid.ts).
const CENTRE: V3 = [0, 4.35, 0];
type Cam = { yaw: number; pitch: number; roll: number; s: number; tx: number; ty: number; dist: number };
const rot = (c: Cam) => {
  const [a, b, g] = [c.yaw, c.pitch, c.roll].map(d => d * Math.PI / 180);
  const Ry = [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
  const Rx = [1, 0, 0, 0, Math.cos(b), -Math.sin(b), 0, Math.sin(b), Math.cos(b)];
  const Rz = [Math.cos(g), -Math.sin(g), 0, Math.sin(g), Math.cos(g), 0, 0, 0, 1];
  const m3 = (A: number[], B: number[]) => Array.from({ length: 9 }, (_, k) => [0, 1, 2].reduce((s, i) => s + A[3 * Math.floor(k / 3) + i] * B[3 * i + (k % 3)], 0));
  return m3(Rz, m3(Rx, Ry)); // row-major
};
/**
 * The camera as the bake uses it: a 3×4 projection `matrix` (row-major; [u·w, v·w, w] = M·[x, y, z, 1]) and the eye
 * position in measured units (for facing and occlusion).
 */
const projection = (c: Cam) => {
  const R = rot(c), d = c.dist;
  // q = R p − R centre; w = (d − q.z) / d; u·w = tx·w − s·q.x
  const t = [0, 1, 2].map(r => -(R[3 * r] * CENTRE[0] + R[3 * r + 1] * CENTRE[1] + R[3 * r + 2] * CENTRE[2]));
  const wRow = [-R[6] / d, -R[7] / d, -R[8] / d, (d - t[2]) / d];
  const row = (k: number, off: number) => [0, 1, 2, 3].map(j => off * wRow[j] - c.s * (j < 3 ? R[3 * k + j] : t[k]));
  // Eye: q = (0, 0, d) → p = Rᵀ q + centre.
  const eye: V3 = [0, 1, 2].map(j => R[6 + j] * d + CENTRE[j]) as V3;
  return { matrix: [...row(0, c.tx), ...row(1, c.ty), ...wRow], eye };
};
const project = (M: number[], x: number, y: number, z: number) => {
  const w = M[8] * x + M[9] * y + M[10] * z + M[11];
  return [(M[0] * x + M[1] * y + M[2] * z + M[3]) / w, (M[4] * x + M[5] * y + M[6] * z + M[7]) / w];
};
const silhouette = (c: Cam, scale: number) => {
  const w = Math.ceil(W * scale), h = Math.ceil(H * scale), out = new Uint8Array(w * h), M = projection(c).matrix;
  const px = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    const [u, v] = project(M, pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
    px[2 * i] = u * scale; px[2 * i + 1] = v * scale;
  }
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], d = indices[t + 2];
    const ax = px[2 * a], ay = px[2 * a + 1], bx = px[2 * b], by = px[2 * b + 1], dx = px[2 * d], dy = px[2 * d + 1];
    const area = (bx - ax) * (dy - ay) - (dx - ax) * (by - ay);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, dx))), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, dx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, dy))), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, dy)));
    if (x0 > x1 || y0 > y1) continue;
    if (Math.abs(area) < 1e-9) { out[y0 * w + x0] = 1; continue; }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      const w1 = ((cx - ax) * (dy - ay) - (dx - ax) * (cy - ay)) / area, w2 = ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / area;
      if (w1 >= 0 && w2 >= 0 && w1 + w2 <= 1) out[y * w + x] = 1;
    }
  }
  return { out, w, h };
};
const target = (scale: number) => {
  const w = Math.ceil(W * scale), h = Math.ceil(H * scale), out = new Uint8Array(w * h);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fg[y * W + x]) out[Math.min(h - 1, Math.floor(y * scale)) * w + Math.min(w - 1, Math.floor(x * scale))] = 1;
  return out;
};
const iou = (c: Cam, scale: number, t: Uint8Array) => {
  const { out } = silhouette(c, scale);
  let both = 0, either = 0;
  for (let i = 0; i < out.length; i++) { both += out[i] & t[i]; either += out[i] | t[i]; }
  return both / (either || 1);
};

// Start: no rotation, scale and offset matching the bounding boxes.
let fy0 = H, fy1 = 0, fx0 = W, fx1 = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fg[y * W + x]) { fy0 = Math.min(fy0, y); fy1 = Math.max(fy1, y); fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); }
let cam: Cam = { yaw: 0, pitch: 0, roll: 0, s: (fy1 - fy0) / 8.7, tx: (fx0 + fx1) / 2, ty: (fy0 + fy1) / 2, dist: 40 };
const steps: Record<keyof Cam, number> = { yaw: 8, pitch: 8, roll: 4, s: cam.s * 0.08, tx: 16, ty: 16, dist: 12 };
for (const scale of [0.25, 0.5]) {
  const t = target(scale);
  let best = iou(cam, scale, t);
  for (let round = 0; round < 60; round++) {
    let improved = false;
    for (const key of Object.keys(steps) as Array<keyof Cam>) for (const sign of [1, -1]) {
      const next = { ...cam, [key]: cam[key] + sign * steps[key] };
      if (next.dist < 9) continue;
      const score = iou(next, scale, t);
      if (score > best) { best = score; cam = next; improved = true; }
    }
    if (!improved) { for (const key of Object.keys(steps) as Array<keyof Cam>) steps[key] /= 2; if (steps.tx < 0.25) break; }
  }
  console.log(`  scale ${scale}: IoU ${best.toFixed(3)}`);
}

// ---------- report and overlay ----------
const final = iou(cam, 1, target(1));
const { matrix, eye } = projection(cam);
const f = (v: number) => Number(v.toFixed(6));
console.log(`${basename(file)} on ${basename(ref)} (${W}×${H}): IoU ${final.toFixed(3)}, yaw ${cam.yaw.toFixed(2)}° pitch ${cam.pitch.toFixed(2)}° roll ${cam.roll.toFixed(2)}°, ${cam.s.toFixed(2)} px/unit, eye ${cam.dist.toFixed(1)} units from the centre`);
console.log(`  camera: { matrix: [${matrix.map(f).join(", ")}], eye: [${eye.map(v => v.toFixed(3)).join(", ")}] },`);
if (final < 0.9) console.log("  ! IoU under 0.9: the art and the model differ in pose or the camera is in perspective; projected colour will miss at the edges");
const { out } = silhouette(cam, 1);
const over = Buffer.from(img);
for (let i = 0; i < W * H; i++) {
  const a = out[i], b = fg[i];
  if (!a && !b) continue;
  const tint = a && b ? [0, 200, 0] : a ? [230, 0, 0] : [0, 60, 255];
  for (let c = 0; c < 3; c++) over[3 * i + c] = Math.round(over[3 * i + c] * 0.55 + tint[c] * 0.45);
}
const png = join(OUT, `project-${basename(file, ".glb")}.png`);
await sharp(over, { raw: { width: W, height: H, channels: 3 } }).png().toFile(png);
console.log(`  overlay: ${png}`);
