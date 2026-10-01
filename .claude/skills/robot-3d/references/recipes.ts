// Copy-paste building blocks for webview-ui/src/robot-runtime.ts. Every import is a deep, tree-shakable path;
// builders used through MeshBuilder need their side-effect import (see SKILL.md, "Imports").
// Typecheck after editing: bunx tsc --noEmit --skipLibCheck --strict --module esnext --moduleResolution bundler --target es2022 --lib es2022,dom .claude/skills/robot-3d/references/recipes.ts
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.pure";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/tubeBuilder";
import "@babylonjs/core/Meshes/Builders/latheBuilder";

/** Glossy plastic / brushed metal without an environment texture (the webview CSP blocks fetching one). */
export function plastic(scene: Scene, name: string, hex: string, roughness = 0.35, metallic = 0) {
  const mat = new PBRMaterial(name, scene);
  mat.albedoColor = Color3.FromHexString(hex).toLinearSpace();
  mat.roughness = roughness;
  mat.metallic = metallic;
  // No IBL: lift the shadow side so white plastic does not go grey.
  mat.ambientColor = new Color3(0.35, 0.35, 0.38);
  return mat;
}

/** Unlit glow for eyes / mouth; pair with one GlowLayer per scene (hero only — skip in sprite renders). */
export function glow(scene: Scene, name: string, hex: string) {
  const mat = new PBRMaterial(name, scene);
  mat.unlit = true;
  mat.albedoColor = Color3.Black();
  mat.emissiveColor = Color3.FromHexString(hex);
  return mat;
}

export function addGlow(scene: Scene, meshes: Mesh[]) {
  const layer = new GlowLayer("robot-glow", scene, { mainTextureSamples: 2, blurKernelSize: 32 });
  layer.intensity = 0.5;
  for (const mesh of meshes) layer.addIncludedOnlyMesh(mesh);
  return layer;
}

/**
 * Rounded box: a sphere pushed toward a superellipsoid |x|^n + |y|^n + |z|^n = 1.
 * n = 2 is a sphere, n ≈ 4 matches the reference head, n ≥ 8 is nearly a cube.
 */
export function roundedBox(scene: Scene, parent: TransformNode, name: string, size: Vector3, exponent = 4, segments = 32) {
  const mesh = MeshBuilder.CreateSphere(name, { diameter: 2, segments, updatable: true }, scene);
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < positions.length; i += 3) {
    const v = new Vector3(positions[i], positions[i + 1], positions[i + 2]);
    const norm = Math.pow(Math.pow(Math.abs(v.x), exponent) + Math.pow(Math.abs(v.y), exponent) + Math.pow(Math.abs(v.z), exponent), 1 / exponent);
    const p = v.scale(1 / (norm || 1));
    positions[i] = p.x * size.x / 2;
    positions[i + 1] = p.y * size.y / 2;
    positions[i + 2] = p.z * size.z / 2;
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
  mesh.createNormals(true);
  mesh.parent = parent;
  return mesh;
}

/** Egg torso: a lathe profile, wide at the top third, tapering to a soft point at the bottom. */
export function eggTorso(scene: Scene, parent: TransformNode, name: string, width: number, height: number) {
  const r = width / 2;
  const h = height / 2;
  const shape: Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / 24;
    const y = Math.sin(t) * h;
    // Wider above the middle, narrower below.
    const taper = y > 0 ? 1 : 1 - 0.12 * (-y / h);
    shape.push(new Vector3(Math.cos(t) * r * taper, y, 0));
  }
  const mesh = MeshBuilder.CreateLathe(name, { shape, tessellation: 48, sideOrientation: 0 }, scene);
  mesh.parent = parent;
  return mesh;
}

/** Ear disc: a short cylinder lying on the X axis. */
export function earDisc(scene: Scene, parent: TransformNode, name: string, diameter: number, depth: number, position: Vector3) {
  const mesh = MeshBuilder.CreateCylinder(name, { diameter, height: depth, tessellation: 32 }, scene);
  mesh.rotation.z = Math.PI / 2;
  mesh.position.copyFrom(position);
  mesh.parent = parent;
  return mesh;
}

/**
 * One pincer finger hanging from the wrist at `base`: bulges out toward `side` (+1 = +X) and curls back so its tip
 * points inward. Build one finger per side; together they read as "( )".
 */
export function clawFinger(scene: Scene, parent: TransformNode, name: string, base: Vector3, side: 1 | -1, radius = 0.16, thickness = 0.045) {
  const path: Vector3[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI / 2 - (Math.PI * 0.85 * i) / 12; // top of the circle → round the outer side → just past the bottom
    path.push(new Vector3(base.x + side * Math.cos(a) * radius, base.y - radius + Math.sin(a) * radius, base.z));
  }
  const mesh = MeshBuilder.CreateTube(name, { path, radius: thickness, tessellation: 12, cap: 3 }, scene);
  mesh.parent = parent;
  return mesh;
}

/** Rotation that turns +Y (the axis cylinders and capsules are built along) onto `dir`. */
export function alignY(dir: Vector3) {
  return Quaternion.FromUnitVectorsToRef(Vector3.Up(), dir.normalizeToNew(), new Quaternion());
}

/** Limb segment: a cylinder spanning two joint centres. */
export function segment(scene: Scene, parent: TransformNode, name: string, from: Vector3, to: Vector3, diameter: number) {
  const dir = to.subtract(from);
  const mesh = MeshBuilder.CreateCylinder(name, { height: dir.length(), diameter, tessellation: 20 }, scene);
  mesh.position = from.add(to).scale(0.5);
  mesh.rotationQuaternion = alignY(dir);
  mesh.parent = parent;
  return mesh;
}

/** Ribbed elbow: short stacked cylinders along an arbitrary axis. */
export function ribbedJoint(scene: Scene, parent: TransformNode, name: string, centre: Vector3, axis: Vector3, diameter: number, ribs = 3) {
  const meshes: Mesh[] = [];
  const dir = axis.normalize();
  for (let i = 0; i < ribs; i++) {
    const rib = MeshBuilder.CreateCylinder(`${name}-${i}`, { diameter: diameter * (i % 2 ? 0.85 : 1), height: diameter * 0.32, tessellation: 24 }, scene);
    rib.position = centre.add(dir.scale((i - (ribs - 1) / 2) * diameter * 0.34));
    rib.rotationQuaternion = alignY(dir); // cylinders are built along +Y
    rib.parent = parent;
    meshes.push(rib);
  }
  return meshes;
}
