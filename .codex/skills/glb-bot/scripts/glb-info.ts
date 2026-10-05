// Inspect a .glb before converting it: compression, mesh/primitive layout, node transforms, materials and texture
// sizes, skins/animations, and the size it will have once baked (8.7 units tall, feet at y = 0).
//   bun .codex/skills/glb-bot/scripts/glb-info.ts backend/src/bots/<name>.glb
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: glb-info.ts <file.glb>"); process.exit(1); }
const buf = readFileSync(file);
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (buf.subarray(0, 4).toString() !== "glTF") { console.error(`${file}: not a binary glTF (magic ${JSON.stringify(buf.subarray(0, 8).toString("latin1"))})`); process.exit(1); }
const jsonLength = view.getUint32(12, true);
const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString("utf8"));
const binStart = 20 + jsonLength + 8;
const bin = buf.subarray(binStart);
const warn: string[] = [];

console.log(`${file}: ${(buf.length / 1e6).toFixed(2)} MB, generator ${json.asset?.generator ?? "?"}`);
console.log(`  extensions used ${JSON.stringify(json.extensionsUsed ?? [])}, required ${JSON.stringify(json.extensionsRequired ?? [])}`);
const known = new Set(["KHR_mesh_quantization", "KHR_texture_transform", "EXT_texture_webp"]);
for (const ext of json.extensionsRequired ?? []) if (!known.has(ext)) warn.push(`required extension ${ext} is not decoded by scripts/bake-bots.ts (e.g. Draco/meshopt: decompress first with gltf-transform or gltfpack -noq)`);

const TYPES: Record<number, string> = { 5120: "i8", 5121: "u8", 5122: "i16", 5123: "u16", 5125: "u32", 5126: "f32" };
let triangles = 0;
const meshNodes = json.nodes.map((n: any, i: number) => [i, n]).filter(([, n]: any) => n.mesh !== undefined);
for (const [i, n] of meshNodes as Array<[number, any]>) {
  const mesh = json.meshes[n.mesh];
  console.log(`  node ${i} ${JSON.stringify(n.name ?? "")} → mesh ${n.mesh} (${mesh.primitives.length} primitive${mesh.primitives.length > 1 ? "s" : ""})${n.skin !== undefined ? " skinned" : ""}`);
  for (const [k, p] of mesh.primitives.entries()) {
    const pos = json.accessors[p.attributes.POSITION];
    const tris = p.indices !== undefined ? json.accessors[p.indices].count / 3 : pos.count / 3;
    triangles += tris;
    const attrs = Object.entries(p.attributes).map(([name, a]: any) => `${name}:${TYPES[json.accessors[a].componentType]}${json.accessors[a].normalized ? "n" : ""}`).join(" ");
    console.log(`    primitive ${k}: ${pos.count} verts, ${tris} tris, material ${p.material ?? "-"}, ${attrs}${p.extensions ? ` ext ${Object.keys(p.extensions)}` : ""}`);
  }
}
if (meshNodes.length !== 1 || json.meshes[(meshNodes[0] as any)?.[1].mesh]?.primitives.length !== 1)
  warn.push("the bake reads only the first mesh node's first primitive; merge meshes/primitives first (gltf-transform join) or extend the decoder");

// World transform of the mesh node, including matrix nodes and rotations.
const parents = new Map<number, number>();
json.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parents.set(c, i)));
const first = (meshNodes[0] as any)?.[0];
for (let i: number | undefined = first; i !== undefined; i = parents.get(i)) {
  const n = json.nodes[i];
  console.log(`  chain node ${i} ${JSON.stringify(n.name ?? "")}: t=${JSON.stringify(n.translation ?? null)} r=${JSON.stringify(n.rotation ?? null)} s=${JSON.stringify(n.scale ?? null)}${n.matrix ? " matrix" : ""}`);
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const localMatrix = (n: any): number[] => {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
};
const mul = (a: number[], b: number[]) => Array.from({ length: 16 }, (_, k) => { const c = Math.floor(k / 4), r = k % 4; return [0, 1, 2, 3].reduce((sum, i) => sum + a[i * 4 + r] * b[c * 4 + i], 0); });
const world = (i: number): number[] => { const p = parents.get(i); return p === undefined ? localMatrix(json.nodes[i]) : mul(world(p), localMatrix(json.nodes[i])); };
// Size once baked: transform all eight corners of the POSITION accessor bounds through the node chain.
const pos = json.accessors[json.meshes[(meshNodes[0] as any)[1].mesh].primitives[0].attributes.POSITION];
if (pos.min && pos.max) {
  const m = first === undefined ? identity : world(first), corners = Array.from({ length: 8 }, (_, k) => [0, 1, 2].map(c => (k >> c) & 1 ? pos.max[c] : pos.min[c]));
  const points = corners.map(([x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]);
  const min = [0, 1, 2].map(c => Math.min(...points.map(p => p[c]))), max = [0, 1, 2].map(c => Math.max(...points.map(p => p[c])));
  const size = max.map((v, c) => v - min[c]);
  const k = 8.7 / size[1];
  console.log(`  model size ${size.map(v => v.toFixed(3)).join(" × ")} → baked ${size.map(v => (v * k).toFixed(2)).join(" × ")} units (W × H × D; the procedural robot is ≈ 4 wide)`);
  if (size[0] * k > 6) warn.push("wider than ~6 baked units: the hero camera backs off to fit it (botFit), so the bot will look small in the welcome canvas");
}

for (const [i, m] of (json.materials ?? []).entries()) {
  const pbr = m.pbrMetallicRoughness ?? {};
  const slots = { color: pbr.baseColorTexture, mr: pbr.metallicRoughnessTexture, normal: m.normalTexture, emissive: m.emissiveTexture, occlusion: m.occlusionTexture };
  const used = Object.entries(slots).filter(([, v]) => v).map(([k, v]: any) => `${k}${v.extensions?.KHR_texture_transform ? "(tt)" : ""}`);
  console.log(`  material ${i} ${JSON.stringify(m.name ?? "")}: ${used.join(", ") || "no textures"}; baseColorFactor ${JSON.stringify(pbr.baseColorFactor ?? null)} emissive ${JSON.stringify(m.emissiveFactor ?? null)} doubleSided ${!!m.doubleSided} alpha ${m.alphaMode ?? "OPAQUE"}`);
  if (slots.occlusion) warn.push("occlusion texture is ignored by the bake");
  if (!pbr.baseColorTexture) warn.push(`material ${i} has no base colour texture; the bake's hand/paint heuristics (luminance) assume one. Paint it by region (\`paint\`, as Ironman) or texture it first (Meshy retexture / uv-unwrap, references/meshy.md)`);
}
if ((json.materials ?? []).length > 1) warn.push("more than one material; the bake uses the first primitive's material only");

const dims = (b: Buffer) => {
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return `png ${b.readUInt32BE(16)}×${b.readUInt32BE(20)}`;
  if (b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8X") return `webp ${1 + b.readUIntLE(24, 3)}×${1 + b.readUIntLE(27, 3)}`;
    if (kind === "VP8L") { const bits = b.readUInt32LE(21); return `webp ${(bits & 0x3fff) + 1}×${((bits >> 14) & 0x3fff) + 1}`; }
    return `webp ${b.readUInt16LE(26) & 0x3fff}×${b.readUInt16LE(28) & 0x3fff}`;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let k = 2; k < b.length - 9;) {
      if (b[k] !== 0xff) break;
      const marker = b[k + 1], length = b.readUInt16BE(k + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return `jpeg ${b.readUInt16BE(k + 7)}×${b.readUInt16BE(k + 5)}`;
      k += 2 + length;
    }
    return "jpeg";
  }
  return "unknown";
};
for (const [i, im] of (json.images ?? []).entries()) {
  if (im.bufferView === undefined) { console.log(`  image ${i}: external ${im.uri}`); warn.push("external image URIs are not read by the bake"); continue; }
  const bv = json.bufferViews[im.bufferView];
  const b = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  console.log(`  image ${i}: ${dims(b)} ${(b.length / 1e6).toFixed(2)} MB`);
}
for (const s of json.skins ?? []) console.log(`  skin ${JSON.stringify(s.name ?? "")}: ${s.joints.length} joints → bun .codex/skills/glb-bot/scripts/skeleton.ts ${file} prints its pivots as a draft rig (--rigged=<bot> bakes its weights)`);
for (const a of json.animations ?? []) console.log(`  animation ${JSON.stringify(a.name ?? "")}: ${a.channels.length} channels (ignored)`);

console.log(`  total ${triangles} triangles${triangles > 120000 ? ` → set triangles: ~60000–80000 in the bot's CONFIG (decimation)` : ""}`);
if (triangles > 300000) warn.push(`${triangles} triangles is over Meshy's 300k-face auto-rig limit; remesh first if it is going to meshy_rig (references/meshy.md)`);
for (const w of warn) console.log(`  ! ${w}`);
