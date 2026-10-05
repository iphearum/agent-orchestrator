// Read a humanoid skeleton that came with the model (Meshy auto-rig, Mixamo, Tripo, a Blender armature) and turn it
// into the bake's terms: each source joint mapped to a runtime part, the joint pivots in baked units (8.7 tall, floor
// at 0, centred, X mirrored like Babylon's loader, same `yaw` as the bake) printed as a draft CONFIG `rig`, the
// sculpted arm angle, and how many vertices each part would own. An auto-rigger puts joints at the limb centres, so
// this replaces most grid measuring; check the antenna, face and anything odd on the grids as usual.
//   bun .claude/skills/glb-bot/scripts/skeleton.ts <file.glb> [--yaw=0]
//   bun .claude/skills/glb-bot/scripts/skeleton.ts <file.glb> --rigged=<bot> [--yaw=0]
// --rigged also writes .ui-check/glb-bot/<bot>-from-skin.glb: the same file with the skin collapsed onto the runtime's
// bones (one joint per part, named as in BONES, weights summed per part). Copied to backend/src/bots/<bot>-rigged.glb it
// is baked through the rigged-input path: the source weights replace classify, bands, smoothing and seams.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./lib";

const file = process.argv[2];
if (!file || file.startsWith("--")) { console.error("usage: skeleton.ts <file.glb> [--yaw=0] [--rigged=<bot>]"); process.exit(1); }
const flag = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1];
const yawDeg = Number(flag("yaw") ?? 0), riggedBot = flag("rigged");
const HEIGHT = 8.7;

type M4 = number[];
type V3 = [number, number, number];

const buf = readFileSync(file);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (buf.subarray(0, 4).toString() !== "glTF") { console.error(`${file}: not a binary glTF`); process.exit(1); }
const jsonLength = dv.getUint32(12, true);
const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString("utf8"));
const binStart = 20 + jsonLength + 8, binLength = dv.getUint32(20 + jsonLength, true);
const bin = new DataView(buf.buffer, buf.byteOffset + binStart, binLength);

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const READ: Record<number, [number, (d: DataView, o: number) => number, number]> = {
  5120: [1, (d, o) => d.getInt8(o), 127], 5121: [1, (d, o) => d.getUint8(o), 255],
  5122: [2, (d, o) => d.getInt16(o, true), 32767], 5123: [2, (d, o) => d.getUint16(o, true), 65535],
  5125: [4, (d, o) => d.getUint32(o, true), 4294967295], 5126: [4, (d, o) => d.getFloat32(o, true), 1],
};
const accessor = (index: number) => {
  const a = json.accessors[index], bv = json.bufferViews[a.bufferView], n = COMPONENTS[a.type];
  const [size, get, max] = READ[a.componentType];
  const stride = bv.byteStride ?? size * n, base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out = new Float64Array(a.count * n);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) {
    const v = get(bin, base + i * stride + c * size);
    out[i * n + c] = a.normalized ? Math.max(v / max, -1) : v;
  }
  return out;
};

// ---------- matrices (column-major, as glTF) ----------
const local = (n: any): M4 => {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
};
const mul = (a: M4, b: M4) => Array.from({ length: 16 }, (_, k) => { const c = Math.floor(k / 4), r = k % 4; return [0, 1, 2, 3].reduce((s, i) => s + a[i * 4 + r] * b[c * 4 + i], 0); });
const apply = (m: M4, p: V3): V3 => [0, 1, 2].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]) as V3;
/** Inverse of an affine column-major 4×4. */
const invert = (m: M4): M4 => {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  const r = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det); // row-major
  const t = [0, 1, 2].map(k => -(r[3 * k] * m[12] + r[3 * k + 1] * m[13] + r[3 * k + 2] * m[14]));
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, t[0], t[1], t[2], 1];
};
const parents = new Map<number, number>();
json.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parents.set(c, i)));
const worldCache = new Map<number, M4>();
const world = (i: number): M4 => {
  if (!worldCache.has(i)) { const p = parents.get(i); worldCache.set(i, p === undefined ? local(json.nodes[i]) : mul(world(p), local(json.nodes[i]))); }
  return worldCache.get(i)!;
};
const depth = (i: number) => { let d = 0; for (let p = parents.get(i); p !== undefined; p = parents.get(p)) d++; return d; };

// ---------- the mesh, normalised exactly like scripts/bake-bots.ts ----------
const meshNode = json.nodes.findIndex((n: any) => n.mesh !== undefined);
if (meshNode < 0) { console.error(`${file}: no mesh node`); process.exit(1); }
const primitive = json.meshes[json.nodes[meshNode].mesh].primitives[0];
const skinIndex = json.nodes[meshNode].skin;
if (skinIndex === undefined || primitive.attributes.JOINTS_0 === undefined) {
  console.error(`${file}: the first mesh node has no skin; nothing to read (measure on grid.ts, or rig it first — references/meshy.md)`);
  process.exit(1);
}
const skin = json.skins[skinIndex];
const meshWorld = world(meshNode);
const yc = Math.cos(yawDeg * Math.PI / 180), ys = Math.sin(yawDeg * Math.PI / 180);
const toBakeRaw = (p: V3): V3 => { const [x, y, z] = [-p[0], p[1], p[2]]; return [x * yc + z * ys, y, -x * ys + z * yc]; };
const rawPos = accessor(primitive.attributes.POSITION), count = rawPos.length / 3;
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < count; i++) {
  const p = toBakeRaw(apply(meshWorld, [rawPos[3 * i], rawPos[3 * i + 1], rawPos[3 * i + 2]]));
  for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], p[c]); max[c] = Math.max(max[c], p[c]); }
}
const scale = HEIGHT / (max[1] - min[1]);
/** A world-space point in baked units (what the bake's `normalise` does to a rigged file's joints). */
const baked = (p: V3): V3 => { const q = toBakeRaw(p); return [(q[0] - (min[0] + max[0]) / 2) * scale, (q[1] - min[1]) * scale, (q[2] - (min[2] + max[2]) / 2) * scale]; };

// Joint positions two ways: the node's world origin (what the bake reads) and the bind pose from the inverse bind
// matrix, carried through the mesh node like the vertices are. They differ when the file is saved in a pose other
// than its bind pose (an animation frame) or the mesh node is moved off its armature.
const ibm = skin.inverseBindMatrices !== undefined ? accessor(skin.inverseBindMatrices) : undefined;
const joints = (skin.joints as number[]).map((node, k) => {
  const nodeAt = baked([world(node)[12], world(node)[13], world(node)[14]]);
  const bind = ibm ? invert(Array.from(ibm.subarray(16 * k, 16 * k + 16))) : undefined;
  const bindAt = bind ? baked(apply(meshWorld, [bind[12], bind[13], bind[14]])) : nodeAt;
  return { k, node, name: String(json.nodes[node].name ?? `joint${k}`), depth: depth(node), nodeAt, bindAt };
});
const drift = Math.max(...joints.map(j => Math.hypot(j.nodeAt[0] - j.bindAt[0], j.nodeAt[1] - j.bindAt[1], j.nodeAt[2] - j.bindAt[2])));

// ---------- name → runtime part ----------
type Role = "root" | "upper" | "head" | "antenna" | "arm" | "forearm" | "hand" | "thigh" | "shin" | "foot";
/** A joint's role from its name (prefixes like `mixamorig:` and side words stripped); undefined = inherit the parent's. */
function role(raw: string): Role | undefined {
  const n = raw.toLowerCase().replace(/^.*[:|]/, "").replace(/^(mixamorig|def|bip0?1|cc_base|rig)[_\-. ]*/, "");
  // The runtime's own bone names (scripts/export-rigged.ts output, or a skin already renamed in Blender).
  const own = /^(root|upper|head|antenna|arm|forearm|hand|thigh|shin|foot)([+-]1)?$/.exec(n);
  if (own) return own[1] as Role;
  if (/antenna/.test(n)) return "antenna";
  if (/^(root|armature|skeleton|reference)/.test(n)) return "root";
  if (/thumb|index|middle|ring|pinky|little|finger|palm/.test(n)) return "hand";
  if (/toe/.test(n)) return "foot";
  if (/fore ?arm|lower ?_?arm|elbow/.test(n)) return "forearm";
  if (/hand|wrist/.test(n)) return "hand";
  if (/up ?leg|upper ?_?leg|thigh/.test(n)) return "thigh";
  if (/lower ?_?leg|calf|shin|knee/.test(n)) return "shin";
  if (/foot|ankle/.test(n)) return "foot";
  if (/shoulder|clavicle|collar/.test(n)) return "upper";
  if (/arm/.test(n)) return "arm";
  if (/leg/.test(n)) return "shin";
  if (/head|jaw|eye|ear|nose|hair|brow|lip|teeth|tongue/.test(n)) return "head";
  if (/neck|spine|chest|hips?$|hips|pelvis|torso|waist|abdomen|body/.test(n)) return "upper";
  return undefined;
}
const nameSide = (raw: string): -1 | 1 | 0 => {
  const n = raw.replace(/^.*[:|]/, "");
  if (/left|(^|[_\-. ])l([_\-. ]|$)|^l(?=[A-Z])|[_.]l$/i.test(n) || /^L[A-Z_]/.test(n)) return -1;
  if (/right|(^|[_\-. ])r([_\-. ]|$)|^r(?=[A-Z])|[_.]r$/i.test(n) || /^R[A-Z_]/.test(n)) return 1;
  return 0;
};
const SIDED = new Set<Role>(["arm", "forearm", "hand", "thigh", "shin", "foot"]);
const byNode = new Map(joints.map(j => [j.node, j]));
const hipsX = joints.filter(j => role(j.name) === "upper").sort((a, b) => a.depth - b.depth)[0]?.bindAt[0] ?? 0;
const warn: string[] = [];
const part = new Map<number, string>(); // skin index → BONES name
for (const j of [...joints].sort((a, b) => a.depth - b.depth)) {
  let r = role(j.name);
  let from = j.node;
  for (let p = parents.get(j.node); !r && p !== undefined; p = parents.get(p)) { const pj = byNode.get(p); if (pj && part.has(pj.k)) { from = p; break; } r = role(String(json.nodes[p].name ?? "")); }
  if (!r && from !== j.node) { part.set(j.k, part.get(byNode.get(from)!.k)!); continue; }
  r ??= "upper";
  if (!SIDED.has(r)) { part.set(j.k, r); continue; }
  // Side by where the joint sits (glTF's left hand lands at −X once mirrored, but a `yaw` or a crossed limb changes
  // that); the name decides when the joint is on the midline.
  const dx = j.bindAt[0] - hipsX, byName = nameSide(j.name);
  const side = Math.abs(dx) > 0.05 ? (dx < 0 ? -1 : 1) : byName || -1;
  if (byName && byName !== side && Math.abs(dx) > 0.05) warn.push(`${j.name} is named side ${byName > 0 ? "right" : "left"} but sits at x ${dx.toFixed(2)}; placed on side ${side > 0 ? "+1" : "-1"} by position`);
  part.set(j.k, `${r}${side > 0 ? "+1" : "-1"}`);
}

// One pivot per part: its root-most joint (Hips for upper, Head over HeadTop_End, Hand over the fingers).
const pivot = new Map<string, (typeof joints)[number]>();
for (const j of [...joints].sort((a, b) => a.depth - b.depth || a.bindAt[1] - b.bindAt[1])) if (!pivot.has(part.get(j.k)!)) pivot.set(part.get(j.k)!, j);

// ---------- weights per part ----------
const sets: Array<[Float64Array, Float64Array]> = [];
for (let s = 0; primitive.attributes[`JOINTS_${s}`] !== undefined; s++) sets.push([accessor(primitive.attributes[`JOINTS_${s}`]), accessor(primitive.attributes[`WEIGHTS_${s}`])]);
const PARTS = ["root", "upper", "head", "antenna", "arm-1", "forearm-1", "arm+1", "forearm+1", "thigh-1", "shin-1", "foot-1", "thigh+1", "shin+1", "foot+1", "hand-1", "hand+1"];
const vertexParts = (i: number) => {
  const acc = new Map<string, number>();
  for (const [jn, wt] of sets) for (let c = 0; c < 4; c++) if (wt[4 * i + c] > 0) { const p = part.get(jn[4 * i + c])!; acc.set(p, (acc.get(p) ?? 0) + wt[4 * i + c]); }
  return [...acc].sort((a, b) => b[1] - a[1]);
};
const owned = new Map<string, number>();
for (let i = 0; i < count; i++) { const top = vertexParts(i)[0]?.[0] ?? "root"; owned.set(top, (owned.get(top) ?? 0) + 1); }

// ---------- report ----------
const f = (v: number) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);
const v3 = (p: V3) => `[${p.map(f).join(", ")}]`;
console.log(`${file}: skin ${JSON.stringify(skin.name ?? "")}, ${joints.length} joints, ${count} vertices, ${sets.length * 4} influences per vertex${yawDeg ? `, yaw ${yawDeg}°` : ""}`);
for (const j of joints.sort((a, b) => a.depth - b.depth || a.k - b.k)) {
  const isPivot = pivot.get(part.get(j.k)!) === j;
  console.log(`  ${"  ".repeat(Math.min(j.depth, 8))}${j.name} → ${part.get(j.k)}${isPivot ? " (pivot)" : ""} ${v3(j.bindAt)}`);
}
if (drift > 0.05) warn.push(`node positions differ from the bind pose by up to ${drift.toFixed(2)} units (the file is saved posed, or the mesh node is offset from its armature). The printed pivots are the bind pose, which matches the mesh; the bake's rigged-input path reads node positions, so re-export at rest before using --rigged`);
const at = (p: string) => pivot.get(p)?.bindAt;
const pair = (p: string) => (at(`${p}-1`) && at(`${p}+1`) ? `[${v3(at(`${p}-1`)!)}, ${v3(at(`${p}+1`)!)}]` : "/* not in the skin: measure on grid.ts */");
const head = at("head"), upper = at("upper");
// A skeleton has no antenna: the draft parks the pivot inside the top of the head with no glow cap (as Jarvis does).
// A model that has one needs its stalk base and ball measured on grid.ts.
const crown: V3 = head ? [head[0], HEIGHT - 0.5, head[2]] : [0, HEIGHT - 0.5, 0];
console.log(`\n  draft rig (baked units; side −1 = −X = viewer's right):`);
console.log(`    rig: {
      hip: ${upper ? v3(upper) : "/* measure */"}, neck: ${head ? v3(head) : "/* measure */"},
      ${at("antenna") ? `antenna: ${v3(at("antenna")!)}, antennaBall: { at: /* measure the ball's centre and radius */ ${v3(at("antenna")!)}, radius: 0 },`
        : `antenna: ${v3(crown)}, antennaBall: { at: ${v3(crown)}, radius: 0 }, // no antenna; measure one if the model has it`}
      shoulder: ${pair("arm")}, elbow: ${pair("forearm")}, wrist: ${pair("hand")},
      hipJoint: ${pair("thigh")}, knee: ${pair("shin")}, ankle: ${pair("foot")},
    },`);
// The runtime's poses are offsets from the sculpted pose (references/pipeline.md §6), so the sculpted arm angle is the
// idle arm angle: a T-pose idles with its arms straight out.
for (const s of ["-1", "+1"]) {
  const a = at(`arm${s}`), w = at(`hand${s}`) ?? at(`forearm${s}`);
  if (!a || !w) continue;
  const down = Math.atan2(a[1] - w[1], Math.abs(w[0] - a[0])) * 180 / Math.PI;
  const kind = down < 20 ? "T-pose: idles with this arm straight out" : down < 60 ? "A-pose: idles with this arm held out" : "arm down: idles like the procedural robot";
  console.log(`  arm ${s}: ${down.toFixed(0)}° below horizontal (${kind})`);
  if (down < 20) warn.push(`arm ${s} is sculpted in a T-pose; the runtime can't lower it (more than ~90° pinches the shoulder). Re-pose it in Blender, or regenerate with pose_mode "a-pose" (references/meshy.md)`);
}
console.log(`  vertices per part (strongest influence): ${PARTS.filter(p => owned.get(p)).map(p => `${p} ${owned.get(p)}`).join(", ")}`);
for (const p of PARTS.slice(4)) if (!owned.get(p)) warn.push(`no vertex is mostly ${p}; check the mapping above`);
if (count > 120000) warn.push(`${count} vertices: the rigged-input path skips decimation, so remesh to ~60–80k triangles before rigging (Meshy remesh target_polycount) or use the draft rig with the normal bake and its \`triangles\``);

// ---------- --rigged: collapse the skin onto the runtime's bones ----------
if (riggedBot) {
  const used = PARTS.filter(p => pivot.has(p));
  const newIndex = new Map(used.map((p, k) => [p, k]));
  const jointsOut = new Uint8Array(count * 4), weightsOut = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const top = vertexParts(i).slice(0, 4), sum = top.reduce((s, e) => s + e[1], 0) || 1;
    top.forEach(([p, w], c) => { jointsOut[4 * i + c] = newIndex.get(p)!; weightsOut[4 * i + c] = w / sum; });
    if (!top.length) weightsOut[4 * i] = 1;
  }
  const ibmOut = new Float32Array(used.length * 16);
  used.forEach((p, k) => {
    const j = pivot.get(p)!;
    ibmOut.set(ibm ? ibm.subarray(16 * j.k, 16 * j.k + 16) : invert(world(j.node)), 16 * k);
    json.nodes[j.node].name = p;
  });
  // Append the new accessors at the end of the BIN chunk (4-byte aligned).
  const chunks: Uint8Array[] = [new Uint8Array(buf.buffer, buf.byteOffset + binStart, binLength)];
  let length = binLength;
  const add = (data: ArrayBufferView, acc: object, target?: number) => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) });
    chunks.push(bytes); length += bytes.length;
    json.accessors.push({ bufferView: json.bufferViews.length - 1, ...acc });
    return json.accessors.length - 1;
  };
  for (let s = 0; primitive.attributes[`JOINTS_${s}`] !== undefined; s++) { delete primitive.attributes[`JOINTS_${s}`]; delete primitive.attributes[`WEIGHTS_${s}`]; }
  primitive.attributes.JOINTS_0 = add(jointsOut, { componentType: 5121, count, type: "VEC4" }, 34962);
  primitive.attributes.WEIGHTS_0 = add(weightsOut, { componentType: 5126, count, type: "VEC4" }, 34962);
  json.skins[skinIndex] = { ...skin, name: `${riggedBot}-rig`, joints: used.map(p => pivot.get(p)!.node), inverseBindMatrices: add(ibmOut, { componentType: 5126, count: used.length, type: "MAT4" }) };
  // Other joints keep their nodes (children of the pivots), so the hierarchy and any animation stay valid.
  json.buffers[0].byteLength = length + ((4 - (length % 4)) % 4);
  const binOut = Buffer.concat([...chunks, new Uint8Array((4 - (length % 4)) % 4)]);
  let text = JSON.stringify(json);
  text += " ".repeat((4 - (Buffer.byteLength(text) % 4)) % 4);
  const jsonOut = Buffer.from(text, "utf8");
  const head12 = Buffer.alloc(12), jsonHead = Buffer.alloc(8), binHead = Buffer.alloc(8);
  head12.write("glTF", 0); head12.writeUInt32LE(2, 4); head12.writeUInt32LE(12 + 8 + jsonOut.length + 8 + binOut.length, 8);
  jsonHead.writeUInt32LE(jsonOut.length, 0); jsonHead.write("JSON", 4);
  binHead.writeUInt32LE(binOut.length, 0); binHead.write("BIN\0", 4);
  const out = join(OUT, `${riggedBot}-from-skin.glb`);
  writeFileSync(out, Buffer.concat([head12, jsonHead, jsonOut, binHead, binOut]));
  console.log(`\n  wrote ${out}: ${used.length} bones (${used.join(", ")})`);
  console.log(`  to bake it: copy to backend/src/bots/${riggedBot}-rigged.glb (CONFIG[${riggedBot}] still supplies face, antenna, antennaBall)`);
}
for (const w of warn) console.log(`  ! ${w}`);
