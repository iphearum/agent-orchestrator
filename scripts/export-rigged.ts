// Export a baked bot (media/bots/<bot>.bin + textures) as a standard skinned glTF binary, to correct it in Blender or
// any DCC tool: the mesh, an armature whose bones are the runtime's parts (named as in BONES, joints at the rig
// pivots), the baked skin weights and the textures. Feed the edited file back to the bake as
// backend/src/bots/<bot>.glb: a GLB with a skin named this way is read as-is (weights and pivots from the file)
// instead of being re-labelled. See .claude/skills/glb-bot/SKILL.md, "Correcting in Blender".
//   bun scripts/export-rigged.ts <bot> [out.glb]     → .ui-check/glb-bot/<bot>-rigged.glb by default
//
// Space: glTF's right-handed +Y up, so X is mirrored back (the bake mirrors X like Babylon's loader), at the baked
// scale (8.7 units tall); re-baking it is then an identity transform.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MeshoptDecoder } from "meshoptimizer";

const bot = process.argv[2];
if (!bot) { console.error("usage: export-rigged.ts <bot> [out.glb]"); process.exit(1); }
const out = resolve(process.argv[3] ?? `.ui-check/glb-bot/${bot}-rigged.glb`);
const BOTS = resolve("media/bots");

const buf = readFileSync(join(BOTS, `${bot}.bin`));
const headerLength = buf.readUInt32LE(0);
const header = JSON.parse(buf.subarray(4, 4 + headerLength).toString("utf8"));
if (header.version !== 2) throw new Error(`${bot}.bin is version ${header.version}; re-run scripts/bake-bots.ts`);
await MeshoptDecoder.ready;
const n: number = header.vertexCount, stride: number = header.stride;
const at = (4 + headerLength + 3) & ~3;
const vertexData = new Uint8Array(n * stride);
MeshoptDecoder.decodeVertexBuffer(vertexData, n, stride, new Uint8Array(buf.buffer, buf.byteOffset + at, header.vertexBytes));
const indices = new Uint32Array(header.indexCount);
MeshoptDecoder.decodeIndexBuffer(new Uint8Array(indices.buffer), header.indexCount, 4, new Uint8Array(buf.buffer, buf.byteOffset + ((at + header.vertexBytes + 3) & ~3), header.indexBytes));
const view = new DataView(vertexData.buffer);

// Unpack, mirroring X back to glTF space (and flipping the winding to match).
const position = new Float32Array(n * 3), normal = new Float32Array(n * 3), uv = new Float32Array(n * 2);
const joints = new Uint8Array(n * 4), weights = new Uint8Array(n * 4);
const { min, max } = header.position;
for (let i = 0; i < n; i++) {
  const o = i * stride;
  for (let c = 0; c < 3; c++) position[3 * i + c] = (c === 0 ? -1 : 1) * (min[c] + (view.getUint16(o + 2 * c, true) / 65535) * (max[c] - min[c]));
  const nx = -view.getInt8(o + 6) / 127, ny = view.getInt8(o + 7) / 127, nz = view.getInt8(o + 8) / 127, l = Math.hypot(nx, ny, nz) || 1;
  normal.set([nx / l, ny / l, nz / l], 3 * i);
  for (let c = 0; c < 2; c++) uv[2 * i + c] = header.uv.min[c] + (view.getUint16(o + 10 + 2 * c, true) / 65535) * (header.uv.max[c] - header.uv.min[c]);
  for (let c = 0; c < 3; c++) { joints[4 * i + c] = vertexData[o + 14 + c]; weights[4 * i + c] = vertexData[o + 17 + c]; }
}
for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];

// Armature: the runtime's hierarchy (buildBot), each joint at its pivot. Leg bones are omitted when unused.
type V3 = [number, number, number];
const rig = header.rig;
const mirror = (p: V3): V3 => [-p[0], p[1], p[2]];
const used = new Set<number>();
for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) if (c === 0 || weights[4 * i + c]) used.add(joints[4 * i + c]);
const bones: Array<{ name: string; parent?: string; at: V3 }> = [
  { name: "root", at: [0, 0, 0] },
  { name: "upper", parent: "root", at: rig.hip },
  { name: "head", parent: "upper", at: rig.neck },
  { name: "antenna", parent: "head", at: rig.antenna },
];
for (const [i, s] of [[0, "-1"], [1, "+1"]] as const) {
  bones.push({ name: `arm${s}`, parent: "upper", at: rig.shoulder[i] }, { name: `forearm${s}`, parent: `arm${s}`, at: rig.elbow[i] });
  bones.push({ name: `thigh${s}`, parent: "root", at: rig.hipJoint[i] }, { name: `shin${s}`, parent: `thigh${s}`, at: rig.knee[i] }, { name: `foot${s}`, parent: `shin${s}`, at: rig.ankle[i] });
}
const kept = bones.filter(b => !/^(thigh|shin|foot)/.test(b.name) || used.has(header.bones.indexOf(b.name)));
const skinIndex = new Map(kept.map((b, k) => [b.name, k]));
// Vertex joints: BONES index → skin joint index.
for (let i = 0; i < n * 4; i++) joints[i] = weights[i] ? skinIndex.get(header.bones[joints[i]])! : 0;

// Binary chunk: accessors packed 4-byte aligned.
const chunks: Uint8Array[] = [];
let length = 0;
const bufferViews: any[] = [], accessors: any[] = [];
const add = (data: ArrayBufferView, accessor: any, target?: number) => {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pad = (4 - (length % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
  bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) });
  chunks.push(bytes); length += bytes.length;
  accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
  return accessors.length - 1;
};
const pmin = [0, 1, 2].map(c => Math.min(...Array.from({ length: n }, (_, i) => position[3 * i + c])));
const pmax = [0, 1, 2].map(c => Math.max(...Array.from({ length: n }, (_, i) => position[3 * i + c])));
const attributes = {
  POSITION: add(position, { componentType: 5126, count: n, type: "VEC3", min: pmin, max: pmax }, 34962),
  NORMAL: add(normal, { componentType: 5126, count: n, type: "VEC3" }, 34962),
  TEXCOORD_0: add(uv, { componentType: 5126, count: n, type: "VEC2" }, 34962),
  JOINTS_0: add(joints, { componentType: 5121, count: n, type: "VEC4" }, 34962),
  WEIGHTS_0: add(weights, { componentType: 5121, normalized: true, count: n, type: "VEC4" }, 34962),
};
const indexAccessor = add(indices, { componentType: 5125, count: indices.length, type: "SCALAR" }, 34963);
// Inverse bind matrices: joints carry only translation, so each is a translation by −pivot (column-major).
const ibm = new Float32Array(kept.length * 16);
kept.forEach((b, k) => { const p = mirror(b.at); ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], 16 * k); });
const ibmAccessor = add(ibm, { componentType: 5126, count: kept.length, type: "MAT4" });

// Textures, re-encoded as PNG (glTF core; WebP needs an extension not every importer has).
const sharp = (await import("sharp")).default;
const images: any[] = [], textures: any[] = [];
const texture = async (slot: string) => {
  const file = header.textures?.[slot];
  if (!file) return undefined;
  const png = await sharp(join(BOTS, file)).png().toBuffer();
  const pad = (4 - (length % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
  bufferViews.push({ buffer: 0, byteOffset: length, byteLength: png.length });
  chunks.push(new Uint8Array(png)); length += png.length;
  images.push({ bufferView: bufferViews.length - 1, mimeType: "image/png", name: `${bot}-${slot}` });
  textures.push({ source: images.length - 1 });
  return { index: textures.length - 1 };
};
const color = await texture("color"), mr = await texture("mr"), normalMap = await texture("normal"), emissive = await texture("emissive");
const material = {
  name: `${bot}-shell`,
  pbrMetallicRoughness: {
    ...(color ? { baseColorTexture: color } : { baseColorFactor: [0.93, 0.94, 0.96, 1] }),
    ...(mr ? { metallicRoughnessTexture: mr, metallicFactor: 1, roughnessFactor: 1 } : { metallicFactor: 0, roughnessFactor: 0.4 }),
  },
  ...(normalMap ? { normalTexture: normalMap } : {}),
  ...(emissive ? { emissiveTexture: emissive, emissiveFactor: header.emissive ?? [1, 1, 1] } : {}),
};

// Nodes: bones (translation relative to the parent's pivot), then the skinned mesh under the scene root.
const nodes: any[] = kept.map(b => {
  const p = mirror(b.at), parent = b.parent ? mirror(kept.find(k => k.name === b.parent)!.at) : [0, 0, 0];
  return { name: b.name, translation: [p[0] - parent[0], p[1] - parent[1], p[2] - parent[2]] };
});
kept.forEach((b, k) => { const children = kept.flatMap((c, j) => c.parent === b.name ? [j] : []); if (children.length) nodes[k].children = children; });
nodes.push({ name: `${bot}-body`, mesh: 0, skin: 0 });
const json = {
  asset: { version: "2.0", generator: "agent-orchestrator scripts/export-rigged.ts" },
  extras: { bot, rig: header.rig, face: header.face, note: "Bones match the robot runtime's parts; joints sit at the rig pivots." },
  scene: 0,
  scenes: [{ name: bot, nodes: [0, nodes.length - 1] }],
  nodes,
  skins: [{ name: `${bot}-rig`, skeleton: 0, joints: kept.map((_, k) => k), inverseBindMatrices: ibmAccessor }],
  meshes: [{ name: `${bot}-body`, primitives: [{ attributes, indices: indexAccessor, material: 0 }] }],
  materials: [material],
  ...(images.length ? { images, textures, samplers: [{}] } : {}),
  accessors, bufferViews,
  buffers: [{ byteLength: 0 }],
};
if (textures.length) textures.forEach(t => (t.sampler = 0));
const pad4 = (x: number) => (x + 3) & ~3;
const binLength = pad4(length);
json.buffers[0].byteLength = binLength;
const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
const jsonLength = pad4(jsonBytes.length);
const glb = new Uint8Array(12 + 8 + jsonLength + 8 + binLength);
const dv = new DataView(glb.buffer);
dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, glb.length, true);
dv.setUint32(12, jsonLength, true); dv.setUint32(16, 0x4e4f534a, true);
glb.set(jsonBytes, 20); glb.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
dv.setUint32(20 + jsonLength, binLength, true); dv.setUint32(24 + jsonLength, 0x004e4942, true);
let o = 28 + jsonLength;
for (const c of chunks) { glb.set(c, o); o += c.length; }
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, glb);
console.log(`${bot}: ${n} vertices, ${indices.length / 3} triangles, ${kept.length} bones (${kept.map(b => b.name).join(", ")}) → ${out} (${(glb.length / 1e6).toFixed(2)} MB)`);
