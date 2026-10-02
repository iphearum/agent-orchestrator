// Relief maps of a baked bot (media/bots/<bot>.bin): an orthographic depth map per view, high-passed (depth minus
// its neighbourhood mean) so sculpted detail reads as grey-on-grey and damage stands out. No browser needed.
//   bun .codex/skills/glb-bot/scripts/relief.ts <bot>            front / from -X / back / from +X
//   bun .codex/skills/glb-bot/scripts/relief.ts <bot> head       the same, cropped to the head (above the neck)
//   → .ui-check/glb-bot/relief-<bot>[-head].png, plus a printed list of open-edge clusters
// Reading it: flat grey = smooth surface; white = raised (rims, ridges); black = recessed (grooves, seams).
// Damage looks different from sculpt: sharp-edged white or black polygons, ragged blotches, red open edges (holes
// the bake didn't cap), and in the front view the cyan visor outline (header.face.outline / rectangle) should hug
// the recess's inner edge.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./lib";

const bot = process.argv[2];
if (!bot) { console.error("usage: relief.ts <bot> [head]"); process.exit(1); }
const headOnly = process.argv[3] === "head";
const buf = readFileSync(`media/bots/${bot}.bin`);
const headerLength = buf.readUInt32LE(0);
const header = JSON.parse(buf.subarray(4, 4 + headerLength).toString("utf8"));
const n: number = header.vertexCount;
// .bin version 2 (scripts/bake-bots.ts): meshopt-compressed interleaved vertices (position u16×3 first) and indices.
const { MeshoptDecoder } = await import("meshoptimizer");
await MeshoptDecoder.ready;
const at = (4 + headerLength + 3) & ~3;
const vertexData = new Uint8Array(n * header.stride);
MeshoptDecoder.decodeVertexBuffer(vertexData, n, header.stride, new Uint8Array(buf.buffer, buf.byteOffset + at, header.vertexBytes));
const indexData = new Uint32Array(header.indexCount);
MeshoptDecoder.decodeIndexBuffer(new Uint8Array(indexData.buffer), header.indexCount, 4, new Uint8Array(buf.buffer, buf.byteOffset + ((at + header.vertexBytes + 3) & ~3), header.indexBytes));
const view = new DataView(vertexData.buffer);
const pos = new Float64Array(n * 3);
for (let i = 0; i < n * 3; i++) {
  const c = i % 3;
  pos[i] = header.position.min[c] + (view.getUint16(Math.floor(i / 3) * header.stride + 2 * c, true) / 65535) * (header.position.max[c] - header.position.min[c]);
}
const indices = Array.from(indexData);

// Open edges: weld by position (UV seams split vertices), then edges used by exactly one triangle.
const weld = new Map<string, number>();
const id = Int32Array.from({ length: n }, (_, i) => {
  const key = `${Math.round(pos[3 * i] * 2000)},${Math.round(pos[3 * i + 1] * 2000)},${Math.round(pos[3 * i + 2] * 2000)}`;
  if (!weld.has(key)) weld.set(key, i);
  return weld.get(key)!;
});
const edgeUse = new Map<string, [number, number, number]>();
for (let t = 0; t < indices.length; t += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
  const p = id[indices[t + a]], q = id[indices[t + b]];
  if (p === q) continue;
  const key = p < q ? `${p},${q}` : `${q},${p}`;
  const e = edgeUse.get(key) ?? [p, q, 0];
  e[2]++;
  edgeUse.set(key, e);
}
const open = [...edgeUse.values()].filter(e => e[2] === 1);

const neckY: number = header.rig.neck[1];
const R = 0.02, K = 8;
// Each view: screen x / depth as functions of the model point (matching grid.ts: front has +X on screen-left).
const VIEWS: Array<[string, (p: number[]) => [number, number]]> = [
  ["front", p => [-p[0], p[2]]],
  ["from -X (its left side)", p => [p[2], -p[0]]],
  ["back", p => [p[0], -p[2]]],
  ["from +X (its right side)", p => [-p[2], p[0]]],
];
const y0 = headOnly ? neckY - 0.3 : 0, y1 = header.position.max[1];
const span = Math.max(...[0, 2].map(c => Math.max(Math.abs(header.position.min[c]), Math.abs(header.position.max[c])))) + 0.1;
const W = Math.ceil((2 * span) / R), H = Math.ceil((y1 - y0 + 0.1) / R);
const sharp = (await import("sharp")).default;
const panels: Buffer[] = [];
for (const [name, project] of VIEWS) {
  const Z = new Float32Array(W * H).fill(-Infinity);
  const P = (i: number): [number, number, number] => { const p = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]; const [sx, d] = project(p); return [sx, p[1], d]; };
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [P(indices[t]), P(indices[t + 1]), P(indices[t + 2])];
    const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(det) < 1e-12) continue;
    const gx0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) + span) / R)), gx1 = Math.min(W - 1, Math.ceil((Math.max(a[0], b[0], c[0]) + span) / R));
    const gy0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - y0) / R)), gy1 = Math.min(H - 1, Math.ceil((Math.max(a[1], b[1], c[1]) - y0) / R));
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const x = gx * R - span, y = y0 + gy * R;
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
      if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
      Z[gy * W + gx] = Math.max(Z[gy * W + gx], l1 * a[2] + l2 * b[2] + (1 - l1 - l2) * c[2]);
    }
  }
  const img = Buffer.alloc(W * H * 3, 40);
  const px = (gx: number, gy: number) => ((H - 1 - gy) * W + gx) * 3;
  for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) {
    const z = Z[gy * W + gx];
    if (z === -Infinity) continue;
    let sum = 0, count = 0;
    for (let dy = -K; dy <= K; dy += 2) for (let dx = -K; dx <= K; dx += 2) {
      const q = Z[(gy + dy) * W + gx + dx];
      if (gx + dx >= 0 && gx + dx < W && gy + dy >= 0 && gy + dy < H && q > -Infinity) { sum += q; count++; }
    }
    img.fill(Math.max(0, Math.min(255, Math.round(128 + (z - sum / count) * 4000))), px(gx, gy), px(gx, gy) + 3);
  }
  const mark = (x: number, y: number, depth: number, rgb: number[]) => {
    const gx = Math.round((x + span) / R), gy = Math.round((y - y0) / R);
    if (gx < 0 || gy < 0 || gx >= W || gy >= H) return;
    // Only where the mark is on the visible surface (within 0.05 of the depth buffer).
    if (depth < Z[gy * W + gx] - 0.05) return;
    img.set(rgb, px(gx, gy));
  };
  for (const [p, q] of open) {
    const a = P(p), b = P(q);
    const steps = Math.max(1, Math.ceil(Math.hypot(a[0] - b[0], a[1] - b[1]) / (R / 2)));
    for (let s = 0; s <= steps; s++) { const u = s / steps; mark(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, [255, 40, 40]); }
  }
  if (name === "front") {
    // The visor outline the runtime fills (traced outline, else the face rectangle's superellipse).
    const { centre: [cx, cy], width, height, outline, squircle: k } = header.face;
    const pts: number[][] = outline
      ? Array.from({ length: outline.length / 2 }, (_, i) => [cx + (0.5 - outline[2 * i]) * width, cy + (0.5 - outline[2 * i + 1]) * height])
      : Array.from({ length: 160 }, (_, i) => { const t = (i / 160) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t); return [cx + (width / 2) * Math.sign(c) * Math.abs(c) ** (2 / k), cy + (height / 2) * Math.sign(s) * Math.abs(s) ** (2 / k)]; });
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      for (let s = 0; s <= 8; s++) mark(-(ax + (bx - ax) * s / 8), ay + (by - ay) * s / 8, Infinity, [0, 220, 255]);
    }
  }
  const caption = Buffer.from(`<svg width="${W * 2}" height="28"><rect width="100%" height="100%" fill="#202020"/><text x="8" y="19" font-family="sans-serif" font-size="15" fill="#ddd">${bot} ${name}</text></svg>`);
  panels.push(await sharp({ create: { width: W * 2, height: H * 2 + 28, channels: 3, background: "#202020" } })
    .composite([{ input: caption, left: 0, top: 0 }, { input: await sharp(img, { raw: { width: W, height: H, channels: 3 } }).resize(W * 2, H * 2, { kernel: "nearest" }).png().toBuffer(), left: 0, top: 28 }])
    .png().toBuffer());
}
const file = join(OUT, `relief-${bot}${headOnly ? "-head" : ""}.png`);
await sharp({ create: { width: W * 2 * 4 + 30, height: H * 2 + 28, channels: 3, background: "#202020" } })
  .composite(panels.map((input, i) => ({ input, left: i * (W * 2 + 10), top: 0 })))
  .png().toFile(file);

// Open-edge clusters (≈0.15-unit cells), largest first: where to look.
const cells = new Map<string, { n: number; at: number[] }>();
for (const [p] of open) {
  const at = [pos[3 * p], pos[3 * p + 1], pos[3 * p + 2]];
  const key = at.map(v => Math.round(v / 0.15)).join(",");
  const c = cells.get(key) ?? { n: 0, at };
  c.n++;
  cells.set(key, c);
}
const top = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 8);
console.log(`open edges: ${open.length}${top.length ? " — busiest at " + top.map(c => `${c.at.map(v => v.toFixed(2)).join(",")} (${c.n})`).join("; ") : ""}`);
console.log(`relief: ${file}`);
