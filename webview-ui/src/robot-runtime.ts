import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.pure";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/tubeBuilder";
import "@babylonjs/core/Meshes/Builders/latheBuilder";
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/core/Meshes/Builders/capsuleBuilder";

/** What the robot is doing. The hero canvas reads it from `canvas.dataset.robotState`; avatars get one sheet each. */
type RobotState = "idle" | "listening" | "thinking" | "working" | "talking" | "happy" | "error";
type RobotModel = "default" | "wanted";
/** A horizontal strip of square frames, played with CSS `steps()`; `frames: 1` is a still. */
type AvatarSheet = { url: string; frames: number; duration: number };

type RobotRuntime = {
  getAvatarSprite(model?: RobotModel): Promise<string | undefined>;
  getAvatarSheet(state: RobotState, model?: RobotModel): Promise<AvatarSheet | undefined>;
  mount(canvas: HTMLCanvasElement, model?: RobotModel): (() => void) | undefined;
};

declare global {
  interface Window { AgentRobot3D?: RobotRuntime }
}

/** "head-front" is a preview-only view that matches target/3d-robot-head.png (straight-on head close-up). */
type Framing = "avatar" | "hero" | "head-front";
type Arm = { arm: TransformNode; forearm: TransformNode; side: number; fingers: Array<{ node: TransformNode; sign: number }> };
/** `thigh` pivots at the hip, `shin` at the knee, `foot` at the ankle. */
type Leg = { thigh: TransformNode; shin: TransformNode; foot: TransformNode; side: number };
type Robot = {
  root: TransformNode;
  /** Root yaw the framing starts from; `Pose.turn` is added to it. */
  baseYaw: number;
  /** Resting head attitude and how much of each state's head motion to use (avatars keep the face in view). */
  attitude: { pitch: number; yaw: number; roll: number; motion: number };
  /** Upper body (torso, neck, head, arms), pivoting at the hips; legs stay planted. */
  upper: TransformNode;
  /** Neck pivot: rotations here nod/tilt/turn the head about its base. */
  head: TransformNode;
  arms: Arm[];
  legs: Leg[];
  antenna: PBRMaterial;
  /** Secondary-motion handles: the antenna stalk (springs at its base), the head on its coil, the coil itself. */
  antennaStem: TransformNode;
  headBody: TransformNode;
  coil: Mesh;
  coilLength: number;
  headRest: number;
  setFace(face: Face): void;
};

type Eyes = "open" | "happy" | "focus" | "sad";
type Mouth = "smile" | "grin" | "talk" | "o" | "flat" | "frown" | "dots";
/**
 * Screen face. `lid` is eye openness (1 open → 0.1 shut; blinks run through it), `scale` the eye size, `lookX/Y`
 * the gaze (−1..1, +Y looks down), `open`/`width` the mouth's opening and width (talk syllables, grin bounce).
 */
type Face = {
  eyes: Eyes; lid: number; scale: number; lookX: number; lookY: number; mouth: Mouth; open: number; width: number; tone: "blue" | "red";
  /** Avatar rendering: bigger eyes, thicker strokes and a stronger glow so the face reads at 22–30 px. */
  bold?: boolean;
};
/** grip > 0 opens the claw fingers, < 0 closes them. */
type ArmPose = { swing: number; raise: number; bend: number; wave: number; grip: number };
/** hip < 0 swings the thigh forward, knee > 0 bends the shin back, foot pitches the shoe (< 0 toe up). */
type LegPose = { hip: number; knee: number; foot: number };
type Pose = {
  /** Whole-body turn added to the framing's base yaw (> 0 turns toward the viewer's left). */
  turn: number;
  /** Sideways step offset of the whole robot (+ toward the viewer's left), for walking. */
  x: number;
  lean: number; sway: number; bob: number;
  headPitch: number; headYaw: number; headRoll: number;
  arms: [ArmPose, ArmPose];
  legs: [LegPose, LegPose];
  antenna: number;
  face: Face;
};

// Head silhouette is tuned against target/3d-robot-head.png; full-body layout is tuned against target/3d-robot-full.png.
// The floor is y = 0; `scale` sizes the head against the standing body proportions.
const HEAD = { width: 1.9, height: 1.7, depth: 1.3, xy: 3.2, z: 3, y: 7.05, scale: 1.15 };
const BODY = { torsoTop: 5.62, torsoBottom: 4.49, hipY: 3.68, legX: 0.72, kneeY: 2.38, ankleY: 0.9, height: 8.7 };
// The screen sits `depth` deep in the head; `lip` is the bezel's roll-in outside the edge, `edge` the screen's curl inside it.
const VISOR = { width: 1.43, height: 1.1, y: -0.02, depth: 0.08, lip: 0.07, edge: 0.03, squircle: 3.6 };

/** Glossy plastic / brushed metal. No environment texture is available, so ambient lifts the shadow side. */
function plastic(scene: Scene, name: string, hex: string, roughness: number, metallic = 0) {
  const mat = new PBRMaterial(name, scene);
  mat.albedoColor = Color3.FromHexString(hex).toLinearSpace();
  mat.roughness = roughness;
  mat.metallic = metallic;
  mat.ambientColor = new Color3(0.24, 0.27, 0.32);
  return mat;
}

function place<T extends Mesh>(mesh: T, parent: TransformNode, mat: PBRMaterial, position?: Vector3) {
  mesh.parent = parent;
  mesh.material = mat;
  if (position) mesh.position.copyFrom(position);
  return mesh;
}

/** Rotation that turns +Y (the axis cylinders and lathes are built along) onto `dir`. */
function alignY(dir: Vector3) {
  return Quaternion.FromUnitVectorsToRef(Vector3.Up(), dir.normalizeToNew(), new Quaternion());
}

/**
 * Rounded box as a Barr superellipsoid: (|x/a|^xy + |y/b|^xy)^(z/xy) + |z/c|^z = 1.
 * `xy` rounds the front outline, `z` flattens the front and back faces.
 */
function roundedBox(scene: Scene, name: string, size: Vector3, xy: number, z = xy, segments = 40) {
  const mesh = MeshBuilder.CreateSphere(name, { diameter: 2, segments, updatable: true }, scene);
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, w] = [positions[i], positions[i + 1], positions[i + 2]];
    const f = Math.pow(Math.abs(x) ** xy + Math.abs(y) ** xy, z / xy) + Math.abs(w) ** z;
    const s = f > 0 ? f ** (-1 / z) : 0;
    positions[i] = x * s * size.x / 2;
    positions[i + 1] = y * s * size.y / 2;
    positions[i + 2] = w * s * size.z / 2;
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
  mesh.createNormals(true);
  return mesh;
}

/** Front (+Z) surface depth of the head superellipsoid at head-local (x, y). */
function headFrontZ(x: number, y: number) {
  const r = Math.pow(Math.abs(x / (HEAD.width / 2)) ** HEAD.xy + Math.abs(y / (HEAD.height / 2)) ** HEAD.xy, HEAD.z / HEAD.xy);
  return HEAD.depth / 2 * Math.max(0, 1 - r) ** (1 / HEAD.z);
}

/**
 * How far the screen recess sinks the head's front at (x, y): full depth on the screen, easing to zero across a
 * soft lip just outside its squircle edge, so the white bezel rolls inward like the reference.
 */
function visorRecess(x: number, y: number) {
  const a = VISOR.width / 2;
  const b = VISOR.height / 2;
  const f = (Math.abs(x / a) ** VISOR.squircle + Math.abs((y - VISOR.y) / b) ** VISOR.squircle) ** (1 / VISOR.squircle);
  const distance = (f - 1) * b; // approximate signed distance to the edge
  const t = Math.min(1, Math.max(0, (VISOR.lip - distance) / (VISOR.lip + VISOR.edge)));
  return VISOR.depth * t * t * (3 - 2 * t);
}

/** Head front surface including the recess; the screen grid lies on this. */
function headSurfaceZ(x: number, y: number) {
  return headFrontZ(x, y) - visorRecess(x, y);
}

/** Rounded barrel from a lathe: superellipse profile (flat sides, soft rims), narrowing by `taper` toward the base. */
function barrel(scene: Scene, name: string, width: number, height: number, exponent = 3, taper = 0.1) {
  const r = width / 2;
  const h = height / 2;
  const shape: Vector3[] = [];
  for (let i = 0; i <= 36; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / 36;
    const y = Math.sign(Math.sin(t)) * Math.abs(Math.sin(t)) ** (2 / exponent) * h;
    const radius = Math.abs(Math.cos(t)) ** (2 / exponent) * r * (1 - taper * (h - y) / (2 * h));
    shape.push(new Vector3(radius, y, 0));
  }
  return MeshBuilder.CreateLathe(name, { shape, tessellation: 48 }, scene);
}

/** Squircle |x/a|^n + |y/b|^n = 1 centred in a w×h canvas, inset by `inset` px; matches the carved recess. */
function squircle(ctx: CanvasRenderingContext2D, w: number, h: number, inset = 0, from = 0, to = Math.PI * 2, close = true) {
  const n = VISOR.squircle;
  const a = w / 2 - inset;
  const b = h / 2 - inset;
  ctx.beginPath();
  for (let i = 0; i <= 120; i++) {
    const t = from + ((to - from) * i) / 120;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = w / 2 + a * Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = h / 2 - b * Math.sign(s) * Math.abs(s) ** (2 / n);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  if (close) ctx.closePath();
}

const NEUTRAL_FACE: Face = { eyes: "open", lid: 1, scale: 1, lookX: 0, lookY: 0, mouth: "smile", open: 0, width: 1, tone: "blue" };

const FACE_COLOR = { blue: { ink: "#F7FEFF", glow: ["rgba(50, 130, 255, 1)", "rgba(90, 170, 255, 1)", "rgba(170, 225, 255, 1)"] }, red: { ink: "#FFE1DA", glow: ["rgba(255, 70, 50, 1)", "rgba(255, 110, 90, 1)", "rgba(255, 190, 175, 1)"] } };

/**
 * Eyes and mouth in screen-relative units (0..1 across, 0..1 down); the neutral face is measured from
 * target/3d-robot-head.png and every expression keeps its proportions so it still reads at 24 px.
 */
function drawFace(ctx: CanvasRenderingContext2D, w: number, h: number, face: Face, glow: boolean) {
  const colors = FACE_COLOR[face.tone];
  ctx.save();
  ctx.fillStyle = colors.ink;
  ctx.strokeStyle = colors.ink;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Glow passes: a wide soft halo first, then tighter brighter ones, then the crisp shape.
  const bold = face.bold ? 1.4 : 1;
  const passes: Array<[number, string]> = glow ? [[0.15 * bold, colors.glow[0]], [0.07 * bold, colors.glow[1]], [0.03 * bold, colors.glow[2]], [0, "transparent"]] : [[0, "transparent"]];
  const r = h * 0.118 * (face.bold ? 1.18 : 1);
  const dx = face.lookX * w * 0.035;
  const dy = face.lookY * h * 0.05;
  for (const [blur, color] of passes) {
    ctx.shadowColor = color;
    ctx.shadowBlur = h * blur;
    for (const [i, cx] of [0.252, 0.748].entries()) {
      const x = cx * w + dx;
      const y = 0.466 * h + dy;
      const outward = i === 0 ? -1 : 1;
      // Turning: the eye on the side the face turns toward recedes (smaller), the other comes forward.
      const turn = face.lookX * 0.14 * outward;
      const size = r * face.scale * (1 - turn);
      // Closing lids squash the eye and widen it a touch, like a soft screen animation.
      const lid = Math.max(0.1, Math.min(1, face.lid));
      const squash = 1 + 0.12 * (1 - lid);
      ctx.beginPath();
      if (face.eyes === "open") ctx.ellipse(x, y, size * squash, size * lid, 0, 0, Math.PI * 2);
      else if (face.eyes === "focus") ctx.ellipse(x, y + size * 0.2, size * 1.05 * squash, size * 0.42 * Math.max(0.3, lid), 0, 0, Math.PI * 2);
      else if (face.eyes === "sad") ctx.ellipse(x, y + size * 0.15, size * 0.95 * squash, size * 0.95 * Math.max(0.2, lid), outward * 0.35, 0, Math.PI);
      if (face.eyes === "happy") {
        ctx.lineWidth = h * 0.065 * bold;
        ctx.arc(x, y + size * 0.45, size * 0.85, Math.PI * 1.12, Math.PI * 1.88);
        ctx.stroke();
      } else ctx.fill();
    }
    ctx.lineWidth = h * 0.055 * bold;
    // The mouth follows the gaze a little less than the eyes and narrows as the face turns or tips back,
    // so the flat screen reads as a face turning left/right/up/down.
    ctx.save();
    ctx.translate(face.lookX * w * 0.028, face.lookY * h * 0.035);
    ctx.translate(0.5 * w, 0.8 * h);
    ctx.scale(1 - 0.12 * Math.abs(face.lookX), 1 - 0.1 * Math.max(0, -face.lookY));
    ctx.translate(-0.5 * w, -0.8 * h);
    ctx.beginPath();
    switch (face.mouth) {
      case "smile":
        ctx.moveTo((0.5 - 0.235 * face.width) * w, 0.72 * h);
        ctx.quadraticCurveTo(0.5 * w, 0.932 * h, (0.5 + 0.235 * face.width) * w, 0.72 * h);
        ctx.stroke();
        break;
      case "grin":
        ctx.moveTo((0.5 - 0.21 * face.width) * w, 0.71 * h);
        ctx.quadraticCurveTo(0.5 * w, (0.96 + 0.05 * face.width) * h, (0.5 + 0.21 * face.width) * w, 0.71 * h);
        ctx.closePath();
        ctx.fill();
        break;
      case "talk":
        // Syllables: the opening varies in height and width; at rest the lips close to a short rounded bar.
        if (face.open < 0.08) {
          ctx.moveTo((0.5 - 0.08 * face.width) * w, 0.79 * h);
          ctx.lineTo((0.5 + 0.08 * face.width) * w, 0.79 * h);
          ctx.stroke();
        } else {
          ctx.ellipse(0.5 * w, 0.79 * h, w * 0.085 * face.width, h * (0.02 + 0.085 * face.open), 0, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      case "o":
        ctx.ellipse(0.5 * w, 0.8 * h, w * 0.04, h * 0.055, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "flat":
        ctx.moveTo(0.41 * w, 0.8 * h);
        ctx.lineTo(0.59 * w, 0.8 * h);
        ctx.stroke();
        break;
      case "frown":
        ctx.moveTo((0.5 - 0.16 * face.width) * w, 0.86 * h);
        ctx.quadraticCurveTo(0.5 * w, 0.7 * h, (0.5 + 0.16 * face.width) * w, 0.86 * h);
        ctx.stroke();
        break;
      case "dots":
        for (let k = 0; k < 3; k++) {
          ctx.globalAlpha = k === Math.round(face.open) ? 1 : 0.35;
          ctx.beginPath();
          ctx.ellipse((0.4 + k * 0.1) * w, 0.8 * h, h * 0.04, h * 0.04, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        break;
    }
    ctx.restore();
  }
  ctx.restore();
}

/** Quantise the continuous face values so eased motion redraws only when the change is visible on the screen. */
function faceKey(face: Face) {
  const q = (v: number, step: number) => Math.round(v / step) * step;
  return [face.eyes, q(face.lid, 0.1), q(face.scale, 0.05), q(face.lookX, 0.1), q(face.lookY, 0.1), face.mouth,
    q(face.open, 0.125), q(face.width, 0.1), face.tone, face.bold ? "bold" : ""].map(v => (typeof v === "number" ? v.toFixed(2) : v)).join("|");
}

/**
 * The visor is a screen, not a box: a grid shaped to the head's curved front, textured with a dark rounded
 * rectangle (albedo + alpha) and the glowing face (emissive). Returns `setFace`, which swaps in a cached expression.
 */
function buildVisor(scene: Scene, head: TransformNode) {
  const N = 40;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const v = j / N;
      const x = (u - 0.5) * VISOR.width;
      const y = VISOR.y + (0.5 - v) * VISOR.height;
      positions.push(x, y, headSurfaceZ(x, y) + 0.008);
      uvs.push(1 - u, 1 - v); // +X is the viewer's left, so u runs right-to-left in model space
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const b = a + 1;
      const c = a + N + 1;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  // Wind so the front faces +Z (toward the camera).
  const p = (k: number) => new Vector3(positions[3 * k], positions[3 * k + 1], positions[3 * k + 2]);
  const n = Vector3.Cross(p(indices[1]).subtract(p(indices[0])), p(indices[2]).subtract(p(indices[0])));
  if (n.z > 0) for (let k = 0; k < indices.length; k += 3) [indices[k + 1], indices[k + 2]] = [indices[k + 2], indices[k + 1]];
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.uvs = uvs;
  data.normals = [];
  VertexData.ComputeNormals(positions, indices, data.normals);
  const visor = new Mesh("visor", scene);
  data.applyToMesh(visor);

  const W = 640;
  const H = Math.round(W * VISOR.height / VISOR.width);
  const albedo = new DynamicTexture("visor-albedo", { width: W, height: H }, scene, true);
  const emissive = new DynamicTexture("visor-emissive", { width: W, height: H }, scene, true);
  albedo.hasAlpha = true;
  const canvas = () => Object.assign(document.createElement("canvas"), { width: W, height: H });
  // The glass and its self-glow never change; draw them once and stamp faces on top.
  const glassCanvas = canvas();
  {
    const a = glassCanvas.getContext("2d")!;
    // Dark navy glass, slightly lighter toward the bottom where the smile lights it.
    const glass = a.createLinearGradient(0, 0, 0, H);
    glass.addColorStop(0, "#0D1426");
    glass.addColorStop(0.5, "#121B32");
    glass.addColorStop(1, "#192640");
    a.fillStyle = glass;
    squircle(a, W, H, 2);
    a.fill();
    a.save();
    squircle(a, W, H, 2);
    a.clip();
    // Edge vignette, then a dark bevel ring where the glass meets the bezel.
    const vignette = a.createRadialGradient(W / 2, H * 0.55, H * 0.35, W / 2, H * 0.55, W * 0.6);
    vignette.addColorStop(0, "rgba(10, 16, 32, 0)");
    vignette.addColorStop(1, "rgba(8, 12, 24, 0.45)");
    a.fillStyle = vignette;
    a.fillRect(0, 0, W, H);
    a.lineWidth = H * 0.05;
    a.strokeStyle = "rgba(6, 10, 20, 0.7)";
    squircle(a, W, H, 2);
    a.stroke();
    // Gloss: a bright thin line just inside the top-left of the bevel, and a soft band along the top.
    a.save();
    a.lineCap = "round";
    a.lineWidth = H * 0.022;
    a.strokeStyle = "rgba(205, 220, 245, 0.45)";
    a.shadowColor = "rgba(205, 220, 245, 0.6)";
    a.shadowBlur = H * 0.03;
    squircle(a, W, H, H * 0.05, Math.PI * 0.6, Math.PI * 0.92, false);
    a.stroke();
    a.restore();
    const sheen = a.createLinearGradient(0, H * 0.03, 0, H * 0.13);
    sheen.addColorStop(0, "rgba(150, 170, 210, 0.35)");
    sheen.addColorStop(1, "rgba(150, 170, 210, 0)");
    a.fillStyle = sheen;
    a.fillRect(W * 0.15, H * 0.03, W * 0.7, H * 0.1);
    // Broad, soft studio reflection on the upper-left glass, visible in the close-up reference.
    const reflection = a.createLinearGradient(W * 0.08, H * 0.05, W * 0.52, H * 0.48);
    reflection.addColorStop(0, "rgba(225, 238, 255, 0.22)");
    reflection.addColorStop(0.32, "rgba(198, 219, 255, 0.12)");
    reflection.addColorStop(1, "rgba(170, 200, 255, 0)");
    a.shadowColor = "rgba(205, 222, 255, 0.28)";
    a.shadowBlur = H * 0.07;
    a.fillStyle = reflection;
    a.beginPath();
    a.moveTo(W * 0.12, H * 0.08);
    a.quadraticCurveTo(W * 0.25, H * 0.08, W * 0.39, H * 0.27);
    a.quadraticCurveTo(W * 0.25, H * 0.19, W * 0.16, H * 0.22);
    a.closePath();
    a.fill();
    a.restore();
  }
  const baseCanvas = canvas();
  {
    const e = baseCanvas.getContext("2d")!;
    // Faint navy self-glow keeps the glass blue under tone mapping instead of crushing to black.
    e.fillStyle = "#000";
    e.fillRect(0, 0, W, H);
    const base = e.createRadialGradient(W / 2, H * 0.55, H * 0.1, W / 2, H * 0.55, W * 0.6);
    base.addColorStop(0, "#090F1C");
    base.addColorStop(1, "#040710");
    e.fillStyle = base;
    squircle(e, W, H, H * 0.05);
    e.fill();
  }
  // Only the glow layer is cached (its blur passes are the expensive part); the crisp albedo face is redrawn on the
  // glass each time. A small LRU bounds memory to ~16 × 1.2 MB.
  const glows = new Map<string, HTMLCanvasElement>();
  let shown = "";
  const setFace = (face: Face) => {
    const key = faceKey(face);
    if (key === shown) return;
    shown = key;
    let glow = glows.get(key);
    if (glow) glows.delete(key);
    else {
      glow = canvas();
      const ec = glow.getContext("2d")!;
      ec.drawImage(baseCanvas, 0, 0);
      drawFace(ec, W, H, face, true);
      if (glows.size >= 16) glows.delete(glows.keys().next().value!);
    }
    glows.set(key, glow);
    const ac = albedo.getContext() as CanvasRenderingContext2D;
    ac.clearRect(0, 0, W, H);
    ac.drawImage(glassCanvas, 0, 0);
    drawFace(ac, W, H, face, false);
    albedo.update();
    const ec = emissive.getContext() as CanvasRenderingContext2D;
    ec.drawImage(glow, 0, 0);
    emissive.update();
  };
  setFace(NEUTRAL_FACE);

  const mat = new PBRMaterial("visor-screen", scene);
  mat.albedoTexture = albedo;
  mat.useAlphaFromAlbedoTexture = true;
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  mat.emissiveTexture = emissive;
  mat.emissiveColor = Color3.White();
  mat.emissiveIntensity = 2;
  mat.roughness = 0.55;
  mat.metallic = 0;
  mat.ambientColor = new Color3(0.2, 0.2, 0.22);
  visor.material = mat;
  visor.parent = head;

  return setFace;
}

/** One thick, flattened pincer finger: a circular arc from the palm, out, down and back in; two make an open ring. */
function clawFinger(scene: Scene, name: string, side: number) {
  const path: Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI / 2 - (Math.PI * 0.78 * i) / 16;
    path.push(new Vector3(side * (0.03 + Math.cos(a) * 0.2), -0.32 + Math.sin(a) * 0.32, 0));
  }
  const finger = MeshBuilder.CreateTube(name, { path, radius: 0.1, tessellation: 14, cap: 3 }, scene);
  finger.scaling.z = 0.55; // flat bars, like the reference
  return finger;
}

/** Rounded box whose width and depth shrink linearly to `bottomScale` at its base (torso, thigh and shin shells). */
function taperedBox(scene: Scene, name: string, size: Vector3, bottomScale: number, xy = 4, z = 3) {
  const mesh = roundedBox(scene, name, size, xy, z, 40);
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < positions.length; i += 3) {
    const k = bottomScale + (1 - bottomScale) * (positions[i + 1] / size.y + 0.5);
    positions[i] *= k;
    positions[i + 2] *= 0.5 + 0.5 * k;
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
  mesh.createNormals(true);
  return mesh;
}

/** Smooth path through `points` (Catmull-Rom), as a metal tube with a dark seam ring every `spacing` units. */
function ribbedLimb(scene: Scene, parent: TransformNode, name: string, points: Vector3[], radius: number, metal: PBRMaterial, seam: PBRMaterial, spacing = 0.13) {
  const path: Vector3[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    for (let k = 0; k < 10; k++) path.push(Vector3.CatmullRom(p0, p1, p2, p3, k / 10));
  }
  path.push(points[points.length - 1]);
  place(MeshBuilder.CreateTube(`${name}-tube`, { path, radius, tessellation: 20, cap: 3 }, scene), parent, metal);
  let travelled = 0;
  let next = spacing * 0.6;
  for (let k = 1; k < path.length - 1; k++) {
    travelled += Vector3.Distance(path[k - 1], path[k]);
    if (travelled < next) continue;
    next += spacing;
    const ring = place(MeshBuilder.CreateCylinder(`${name}-seam-${k}`, { diameter: radius * 2.08, height: 0.018, tessellation: 20 }, scene), parent, seam, path[k]);
    ring.rotationQuaternion = alignY(path[k + 1].subtract(path[k - 1]));
  }
}

/** Joint axle along `axis` with a blue roller in the middle and grey end nuts (knees, elbows, hips). */
function joint(scene: Scene, parent: TransformNode, name: string, centre: Vector3, axis: Vector3, length: number, diameter: number, metal: PBRMaterial, blue: PBRMaterial, roller = 0.4) {
  const q = alignY(axis);
  const axle = place(MeshBuilder.CreateCylinder(`${name}-axle`, { diameter: diameter * 0.68, height: length, tessellation: 24 }, scene), parent, metal, centre);
  axle.rotationQuaternion = q;
  const ring = place(MeshBuilder.CreateCylinder(`${name}-roller`, { diameter, height: length * roller, tessellation: 28 }, scene), parent, blue, centre);
  ring.rotationQuaternion = q;
  for (const end of [-1, 1]) {
    const nut = place(MeshBuilder.CreateCylinder(`${name}-nut-${end}`, { diameter: diameter * 0.6, height: 0.05, tessellation: 20 }, scene), parent, metal, centre.add(axis.normalizeToNew().scale(end * length / 2)));
    nut.rotationQuaternion = q;
  }
}

function buildRobot(scene: Scene): Robot {
  const root = new TransformNode("agent-robot", scene);
  const shell = plastic(scene, "pearl-shell", "#EEF1F5", 0.3);
  const blue = plastic(scene, "blue-accents", "#2F7BEA", 0.28);
  const deepBlue = plastic(scene, "tread-grooves", "#1D4F9E", 0.5);
  const metal = plastic(scene, "silver-joints", "#D5DAE1", 0.2, 0.32);
  const seam = plastic(scene, "dark-seams", "#6C727B", 0.42, 0.35);
  const palm = plastic(scene, "palm", "#E2E6EC", 0.35);
  const neckMat = plastic(scene, "neck", "#6E757F", 0.4, 0.5);
  const spring = plastic(scene, "spring", "#B9C0C8", 0.25, 0.85);
  const collarMat = plastic(scene, "antenna-collar", "#80848F", 0.35, 0.6);
  const gunmetal = plastic(scene, "gunmetal", "#5C606C", 0.28, 0.7);
  const antenna = plastic(scene, "antenna-ball", "#2F7BEA", 0.28);

  // Upper body pivots at the hips so it can lean and breathe while the legs stay planted.
  const upper = new TransformNode("upper-body", scene);
  upper.parent = root;
  upper.setPivotPoint(new Vector3(0, BODY.hipY, 0));

  // Head: rotations live on a neck pivot at the head's base; the head itself is scaled against the body.
  const headBase = HEAD.y - (HEAD.height / 2) * HEAD.scale;
  const neck = new TransformNode("neck-pivot", scene);
  neck.parent = upper;
  neck.position.set(0, headBase, 0);
  const head = new TransformNode("head", scene);
  head.parent = neck;
  head.position.set(0, HEAD.y - headBase, 0);
  head.scaling.setAll(HEAD.scale);
  const headShell = place(roundedBox(scene, "head-shell", new Vector3(HEAD.width, HEAD.height, HEAD.depth), HEAD.xy, HEAD.z, 96), head, shell);
  // Carve the screen recess into the front of the shell.
  const shellPositions = headShell.getVerticesData(VertexBuffer.PositionKind)!;
  for (let i = 0; i < shellPositions.length; i += 3) {
    if (shellPositions[i + 2] > 0) shellPositions[i + 2] -= visorRecess(shellPositions[i], shellPositions[i + 1]);
  }
  headShell.updateVerticesData(VertexBuffer.PositionKind, shellPositions);
  headShell.createNormals(true);
  const setFace = buildVisor(scene, head);
  // Blue ear pucks sit just outside the head silhouette.
  for (const side of [-1, 1]) {
    const ear = place(barrel(scene, `ear-${side}`, 0.5, 0.3, 3, 0), head, blue, new Vector3(side * 1.0, -0.03, -0.02));
    ear.rotation.z = Math.PI / 2;
  }
  // Antenna: grey collar and stalk, blue ball.
  const top = HEAD.height / 2;
  place(barrel(scene, "antenna-collar", 0.52, 0.07, 2.6, 0), head, collarMat, new Vector3(0, top - 0.005, 0));
  place(MeshBuilder.CreateCylinder("antenna-collar-top", { diameter: 0.27, height: 0.07, tessellation: 24 }, scene), head, collarMat, new Vector3(0, top + 0.05, 0));
  const antennaStem = new TransformNode("antenna-stem", scene);
  antennaStem.parent = head;
  antennaStem.position.set(0, top + 0.08, 0);
  place(MeshBuilder.CreateCylinder("antenna", { diameter: 0.126, height: 0.2, tessellation: 16 }, scene), antennaStem, gunmetal, new Vector3(0, 0.09, 0));
  place(MeshBuilder.CreateSphere("antenna-tip", { diameter: 0.4, segments: 24 }, scene), antennaStem, antenna, new Vector3(0, 0.34, 0));

  // Neck: silver spring around a dark core.
  const neckBottom = BODY.torsoTop - 0.08;
  const neckTop = headBase + 0.1;
  place(MeshBuilder.CreateCylinder("neck-core", { diameter: 0.46, height: neckTop - neckBottom, tessellation: 24 }, scene), upper, neckMat, new Vector3(0, (neckTop + neckBottom) / 2, 0));
  const coil: Vector3[] = [];
  const turns = Math.max(3, Math.round((neckTop - neckBottom) / 0.075));
  for (let i = 0; i <= turns * 40; i++) {
    const t = (i / 40) * Math.PI * 2;
    coil.push(new Vector3(Math.cos(t) * 0.28, neckBottom + ((neckTop - neckBottom) * i) / (turns * 40), Math.sin(t) * 0.28));
  }
  const coilMesh = place(MeshBuilder.CreateTube("neck-spring", { path: coil, radius: 0.034, tessellation: 10, cap: 3 }, scene), upper, spring);
  coilMesh.setPivotPoint(new Vector3(0, neckBottom, 0));

  const torsoHeight = BODY.torsoTop - BODY.torsoBottom;
  place(taperedBox(scene, "torso", new Vector3(1.9, torsoHeight, 1.08), 0.76, 4.2, 3), upper, shell, new Vector3(0, BODY.torsoBottom + torsoHeight / 2, 0));
  place(MeshBuilder.CreateCylinder("spine-core", { diameter: 0.52, height: 0.72, tessellation: 24 }, scene), upper, seam, new Vector3(0, 4.15, 0));
  for (let i = 0; i < 5; i++) place(barrel(scene, `spine-rib-${i}`, 0.66, 0.08, 2.4, 0), upper, metal, new Vector3(0, 3.98 + i * 0.105, 0));

  place(taperedBox(scene, "pelvis", new Vector3(0.8, 0.55, 0.62), 0.7, 3, 3), root, metal, new Vector3(0, BODY.hipY + 0.02, 0));
  const hipAxle = place(barrel(scene, "hip-axle", 0.44, 1.5, 3.2, 0), root, metal, new Vector3(0, BODY.hipY, 0));
  hipAxle.rotation.z = Math.PI / 2;
  place(MeshBuilder.CreateSphere("pelvis-ball", { diameter: 0.54, segments: 24 }, scene), root, metal, new Vector3(0, BODY.hipY - 0.06, 0.02));
  const legRig: Leg[] = [];
  for (const side of [-1, 1]) {
    const x = side * BODY.legX;
    const hipRing = place(MeshBuilder.CreateCylinder(`hip-ring-${side}`, { diameter: 0.48, height: 0.1, tessellation: 24 }, scene), root, blue, new Vector3(side * 0.56, BODY.hipY, 0));
    hipRing.rotation.z = Math.PI / 2;
    const thigh = new TransformNode(`thigh-${side}`, scene); thigh.parent = root; thigh.setPivotPoint(new Vector3(x, BODY.hipY, 0));
    const shin = new TransformNode(`shin-${side}`, scene); shin.parent = thigh; shin.setPivotPoint(new Vector3(x, BODY.kneeY, 0.02));
    const ankleJoint = new TransformNode(`ankle-joint-${side}`, scene); ankleJoint.parent = shin; ankleJoint.setPivotPoint(new Vector3(x, BODY.ankleY, -0.04));
    legRig.push({ thigh, shin, foot: ankleJoint, side });
    place(MeshBuilder.CreateCylinder(`thigh-core-${side}`, { diameter: 0.4, height: 1.3, tessellation: 16 }, scene), thigh, seam, new Vector3(x, 3.0, 0));
    place(MeshBuilder.CreateCylinder(`shin-core-${side}`, { diameter: 0.4, height: 1.3, tessellation: 16 }, scene), shin, seam, new Vector3(x, 1.75, 0));
    place(taperedBox(scene, `thigh-shell-${side}`, new Vector3(0.98, 1.22, 0.88), 0.82, 5, 3.4), thigh, shell, new Vector3(x, 3.14, 0));
    place(barrel(scene, `thigh-rim-${side}`, 0.72, 0.1, 5, 0.03), thigh, metal, new Vector3(x, 2.5, 0));
    joint(scene, thigh, `knee-${side}`, new Vector3(x, BODY.kneeY, 0.02), Vector3.Right(), 0.66, 0.5, metal, blue, 0.45);
    place(taperedBox(scene, `shin-shell-${side}`, new Vector3(0.88, 0.96, 0.82), 0.84, 5, 3.4), shin, shell, new Vector3(x, 1.72, 0));
    place(barrel(scene, `shin-rim-${side}`, 0.69, 0.09, 5, 0.03), shin, metal, new Vector3(x, 1.23, 0));
    const vent = place(roundedBox(scene, `shin-vent-${side}`, new Vector3(0.12, 0.3, 0.22), 3, 3, 16), shin, metal, new Vector3(x + side * 0.33, 1.42, -0.16));
    for (const dy of [-0.06, 0.06]) place(roundedBox(scene, `shin-vent-slot-${side}-${dy}`, new Vector3(0.13, 0.035, 0.16), 3, 3, 12), shin, blue, vent.position.add(new Vector3(0, dy, 0)));
    const ankle = place(barrel(scene, `ankle-${side}`, 0.5, 0.72, 4.5, 0), shin, metal, new Vector3(x, BODY.ankleY, -0.04)); ankle.rotation.z = Math.PI / 2;
    for (const dx of [-0.14, 0.14]) { const rib = place(MeshBuilder.CreateCylinder(`ankle-seam-${side}-${dx}`, { diameter: 0.505, height: 0.02, tessellation: 24 }, scene), shin, seam, new Vector3(x + dx, BODY.ankleY, -0.04)); rib.rotation.z = Math.PI / 2; }
    for (const dx of [-0.4, 0.4]) place(roundedBox(scene, `ankle-bracket-${side}-${dx}`, new Vector3(0.08, 0.5, 0.42), 3.5, 3, 16), ankleJoint, metal, new Vector3(x + dx, 0.78, -0.06));
    const foot = new TransformNode(`foot-${side}`, scene); foot.parent = ankleJoint; foot.position.set(x + side * 0.1, 0, 0.04); foot.rotation.y = side * 0.22;
    place(roundedBox(scene, `sole-${side}`, new Vector3(1.12, 0.18, 1.58), 5, 3, 24), foot, blue, new Vector3(0, 0.09, 0.18));
    for (let r = 0; r < 7; r++) place(MeshBuilder.CreateBox(`groove-${side}-${r}`, { width: 1.07, height: 0.11, depth: 0.035 }, scene), foot, deepBlue, new Vector3(0, 0.075, -0.36 + r * 0.16));
    place(roundedBox(scene, `rim-${side}`, new Vector3(1.18, 0.09, 1.64), 4.5, 3, 24), foot, metal, new Vector3(0, 0.22, 0.18));
    place(roundedBox(scene, `upper-${side}`, new Vector3(1.06, 0.3, 1.46), 3.6, 2.6, 32), foot, shell, new Vector3(0, 0.38, 0.2));
    place(roundedBox(scene, `heel-${side}`, new Vector3(0.9, 0.3, 0.66), 3.6, 3, 24), foot, metal, new Vector3(0, 0.55, -0.2));
    place(roundedBox(scene, `strap-${side}`, new Vector3(0.78, 0.1, 0.46), 4.5, 3, 20), foot, metal, new Vector3(0, 0.55, 0.36));
  }

  // Ribbed mechanical arms, blue cuffs, and open pincers.
  const arms: Arm[] = [];
  for (const side of [-1, 1]) {
    const shoulder = new Vector3(side * 1.0, BODY.torsoTop - 0.2, 0);
    const elbow = new Vector3(side * 1.59, 4.66, 0.04);
    const wrist = new Vector3(side * 1.71, 3.95, 0.08);
    const arm = new TransformNode(`arm-${side}`, scene);
    arm.parent = upper;
    arm.setPivotPoint(shoulder);
    place(MeshBuilder.CreateSphere(`shoulder-${side}`, { diameter: 0.46, segments: 24 }, scene), arm, metal, shoulder);
    const socket = place(barrel(scene, `shoulder-cap-${side}`, 0.42, 0.12, 3, 0), arm, blue, shoulder.add(new Vector3(side * 0.16, 0, 0))); socket.rotation.z = Math.PI / 2;
    ribbedLimb(scene, arm, `upper-arm-${side}`, [shoulder.add(new Vector3(side * 0.12, -0.02, 0)), new Vector3(side * 1.3, shoulder.y - 0.1, 0.02), new Vector3(side * 1.52, 5.05, 0.03), elbow], 0.18, metal, seam, 0.18);
    const forearm = new TransformNode(`forearm-${side}`, scene);
    forearm.parent = arm;
    forearm.setPivotPoint(elbow);
    place(MeshBuilder.CreateSphere(`elbow-${side}`, { diameter: 0.4, segments: 20 }, scene), forearm, metal, elbow);
    for (const dz of [-0.17, 0.17]) { const cap = place(barrel(scene, `elbow-cap-${side}-${dz}`, 0.42, 0.1, 3, 0), forearm, blue, elbow.add(new Vector3(0, 0, dz))); cap.rotation.x = Math.PI / 2; }
    const nut = place(MeshBuilder.CreateCylinder(`elbow-nut-${side}`, { diameter: 0.2, height: 0.05, tessellation: 20 }, scene), forearm, metal, elbow.add(new Vector3(0, 0, 0.235))); nut.rotation.x = Math.PI / 2;
    ribbedLimb(scene, forearm, `forearm-${side}`, [elbow, new Vector3(side * 1.68, 4.3, 0.06), wrist], 0.165, metal, seam, 0.15);
    const hand = new TransformNode(`hand-${side}`, scene);
    hand.parent = forearm;
    hand.position.set(side * 1.71, 3.74, 0.08);
    place(barrel(scene, `cuff-${side}`, 0.68, 0.58, 3.4, -0.08), hand, blue);
    place(roundedBox(scene, `palm-${side}`, new Vector3(0.24, 0.3, 0.18), 2.6, 2.6, 16), hand, palm, new Vector3(0, -0.33, 0.06));
    const claw = new TransformNode(`claw-${side}`, scene); claw.parent = hand; claw.position.set(0, -0.33, 0);
    const fingers: Arm["fingers"] = [];
    for (const finger of [-1, 1]) {
      const hinge = new TransformNode(`claw-hinge-${side}-${finger}`, scene);
      hinge.parent = claw;
      const clawMesh = place(clawFinger(scene, `claw-${side}-${finger}`, finger), hinge, metal); clawMesh.scaling.x *= 1.12; clawMesh.scaling.y *= 1.3;
      fingers.push({ node: hinge, sign: finger });
    }
    arms.push({ arm, forearm, side, fingers });
  }

  return { root, baseYaw: 0, attitude: { pitch: BASE.headPitch, yaw: BASE.headYaw, roll: BASE.headRoll, motion: 1 }, upper, head: neck, arms, legs: legRig, antenna, setFace, antennaStem, headBody: head, coil: coilMesh, coilLength: neckTop - neckBottom, headRest: HEAD.y - headBase };
}

type WantedRobot = { root: TransformNode; waveArm: TransformNode; head: TransformNode };

/** Measured from target/wanted-robot.png at 100 px ≈ 1 unit; the head is a deep, almost round helmet. */
/** Clay turnaround (target/vally/*.png): the head is about as deep as it is wide. */
const WANTED_HEAD = { width: 2.62, height: 2.31, depth: 2.55, xy: 2.1, z: 2.0, y: 3.8 };
const WANTED_VISOR = { width: 2.12, height: 1.5, y: -0.04, squircle: 2.8 };

/** Front (+Z) depth of the wanted head at head-local (x, y). */
function wantedFrontZ(x: number, y: number) {
  const { width, height, depth, xy, z } = WANTED_HEAD;
  const r = Math.pow(Math.abs(2 * x / width) ** xy + Math.abs(2 * y / height) ** xy, z / xy);
  return depth / 2 * Math.max(0, 1 - r) ** (1 / z);
}

/** Navy-to-indigo glass with glowing cyan oval eyes and a pink smile; `glow` draws the emissive layer. */
function drawWantedScreen(ctx: CanvasRenderingContext2D, w: number, h: number, glow: boolean) {
  const n = WANTED_VISOR.squircle;
  const outline = (inset: number) => {
    ctx.beginPath();
    const a = w / 2 - inset;
    const b = h / 2 - inset;
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      ctx.lineTo(w / 2 + a * Math.sign(c) * Math.abs(c) ** (2 / n), h / 2 + b * Math.sign(s) * Math.abs(s) ** (2 / n));
    }
    ctx.closePath();
  };
  ctx.save();
  if (glow) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    const base = ctx.createRadialGradient(w * 0.5, h * 0.5, h * 0.1, w * 0.5, h * 0.5, w * 0.6);
    base.addColorStop(0, "#20236E");
    base.addColorStop(1, "#0A0D3C");
    ctx.fillStyle = base;
    outline(3);
    ctx.fill();
    // Bright blue reflection down the glass's left edge (it has to glow, or the lit albedo washes it out).
    ctx.save();
    outline(3);
    ctx.clip();
    // A thick band hugging the rim, fading out along the top and bottom toward the middle.
    const edge = ctx.createLinearGradient(0, 0, w * 0.4, 0);
    edge.addColorStop(0, "rgba(40, 160, 255, 1)");
    edge.addColorStop(1, "rgba(30, 120, 255, 0)");
    ctx.strokeStyle = edge;
    ctx.lineWidth = w * 0.13;
    outline(3);
    ctx.stroke();
    ctx.restore();
  } else {
    const glass = ctx.createRadialGradient(w * 0.55, h * 0.55, h * 0.1, w * 0.5, h * 0.5, w * 0.62);
    glass.addColorStop(0, "#2A2C8C");
    glass.addColorStop(0.55, "#1E2372");
    glass.addColorStop(1, "#10164E");
    ctx.fillStyle = glass;
    outline(3);
    ctx.fill();
    ctx.save();
    outline(3);
    ctx.clip();
    // Dark bevel where the glass meets the shell, a cool blue reflection down the left edge and a soft top sheen.
    ctx.lineWidth = h * 0.06;
    ctx.strokeStyle = "rgba(6, 8, 36, 0.75)";
    outline(3);
    ctx.stroke();
    const edge = ctx.createLinearGradient(0, 0, w * 0.2, 0);
    edge.addColorStop(0, "rgba(40, 150, 255, 0.95)");
    edge.addColorStop(0.45, "rgba(40, 120, 255, 0.45)");
    edge.addColorStop(1, "rgba(40, 120, 255, 0)");
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, w * 0.2, h);
    const sheen = ctx.createLinearGradient(0, h * 0.04, 0, h * 0.2);
    sheen.addColorStop(0, "rgba(170, 185, 255, 0.35)");
    sheen.addColorStop(1, "rgba(170, 185, 255, 0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(w * 0.12, h * 0.04, w * 0.76, h * 0.16);
    ctx.restore();
  }
  const passes: Array<[number, string]> = glow ? [[0.14, "rgba(40, 200, 255, 1)"], [0.06, "rgba(120, 230, 255, 1)"], [0, "transparent"]] : [[0, "transparent"]];
  for (const [blur, color] of passes) {
    ctx.shadowColor = color;
    ctx.shadowBlur = h * blur;
    ctx.fillStyle = "#86ECFF";
    for (const cx of [0.26, 0.74]) {
      ctx.beginPath();
      ctx.ellipse(cx * w, 0.43 * h, w * 0.072, h * 0.148, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const mouth: Array<[number, string]> = glow ? [[0.12, "rgba(225, 60, 255, 1)"], [0.05, "rgba(255, 120, 230, 1)"], [0, "transparent"]] : [[0, "transparent"]];
  ctx.lineCap = "round";
  ctx.lineWidth = h * 0.05;
  ctx.strokeStyle = "#FF78DC";
  for (const [blur, color] of mouth) {
    ctx.shadowColor = color;
    ctx.shadowBlur = h * blur;
    ctx.beginPath();
    ctx.moveTo(0.35 * w, 0.7 * h);
    ctx.quadraticCurveTo(0.49 * w, 0.88 * h, 0.63 * w, 0.7 * h);
    ctx.stroke();
  }
  ctx.restore();
}

/** Curved screen grid lying just proud of the wanted head's front, textured with `drawWantedScreen`. */
function buildWantedVisor(scene: Scene, head: TransformNode, shell: PBRMaterial) {
  const N = 40;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const v = j / N;
      const x = (u - 0.5) * WANTED_VISOR.width;
      const y = WANTED_VISOR.y + (0.5 - v) * WANTED_VISOR.height;
      positions.push(x, y, wantedFrontZ(x, y) + 0.02);
      uvs.push(1 - u, 1 - v);
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      indices.push(a, a + N + 1, a + 1, a + 1, a + N + 1, a + N + 2);
    }
  }
  const p = (k: number) => new Vector3(positions[3 * k], positions[3 * k + 1], positions[3 * k + 2]);
  const n = Vector3.Cross(p(indices[1]).subtract(p(indices[0])), p(indices[2]).subtract(p(indices[0])));
  if (n.z > 0) for (let k = 0; k < indices.length; k += 3) [indices[k + 1], indices[k + 2]] = [indices[k + 2], indices[k + 1]];
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.uvs = uvs;
  data.normals = [];
  VertexData.ComputeNormals(positions, indices, data.normals);
  const visor = new Mesh("wanted-visor", scene);
  data.applyToMesh(visor);

  const W = 640;
  const H = Math.round(W * WANTED_VISOR.height / WANTED_VISOR.width);
  const albedo = new DynamicTexture("wanted-visor-albedo", { width: W, height: H }, scene, true);
  const emissive = new DynamicTexture("wanted-visor-emissive", { width: W, height: H }, scene, true);
  albedo.hasAlpha = true;
  drawWantedScreen(albedo.getContext() as CanvasRenderingContext2D, W, H, false);
  drawWantedScreen(emissive.getContext() as CanvasRenderingContext2D, W, H, true);
  albedo.update();
  emissive.update();
  const mat = new PBRMaterial("wanted-visor-screen", scene);
  mat.albedoTexture = albedo;
  mat.useAlphaFromAlbedoTexture = true;
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  mat.emissiveTexture = emissive;
  mat.emissiveColor = Color3.White();
  mat.emissiveIntensity = 1.3;
  mat.roughness = 0.42;
  mat.ambientColor = new Color3(0.2, 0.2, 0.22);
  visor.material = mat;
  visor.parent = head;
  // Raised lip around the face plate, following the head's curve.
  const k = WANTED_VISOR.squircle;
  const rim: Vector3[] = [];
  for (let i = 0; i <= 96; i++) {
    const t = (i / 96) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = (WANTED_VISOR.width / 2 + 0.03) * Math.sign(c) * Math.abs(c) ** (2 / k);
    const y = WANTED_VISOR.y + (WANTED_VISOR.height / 2 + 0.03) * Math.sign(s) * Math.abs(s) ** (2 / k);
    rim.push(new Vector3(x, y, wantedFrontZ(x, y) + 0.005));
  }
  place(MeshBuilder.CreateTube("wanted-visor-rim", { path: rim, radius: 0.05, tessellation: 12 }, scene), head, shell);
}

/** Egg-shaped torso from a lathe: a superellipse profile, fuller toward the bottom, with a flat top for the neck socket. */
function eggTorso(scene: Scene, name: string, width: number, height: number) {
  const shape: Vector3[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / 40;
    const s = Math.sin(t);
    const y = Math.sign(s) * Math.abs(s) ** (2 / 2.6) * height / 2;
    const radius = Math.abs(Math.cos(t)) ** (2 / 2.6) * width / 2 * (1 - 0.08 * (y / (height / 2) + 1) / 2);
    shape.push(new Vector3(radius, y, 0));
  }
  return MeshBuilder.CreateLathe(name, { shape, tessellation: 48 }, scene);
}

type WantedParts = { scene: Scene; shell: PBRMaterial; metal: PBRMaterial; dark: PBRMaterial };

/** Short open cylinder (grey joint ring) centred on `at`, its axis along `axis`. */
function wantedRing(p: WantedParts, name: string, parent: TransformNode, at: Vector3, axis: Vector3, diameter: number, height: number, material = p.metal) {
  const ring = place(MeshBuilder.CreateCylinder(name, { diameter, height, tessellation: 32 }, p.scene), parent, material, at);
  ring.rotationQuaternion = alignY(axis);
  return ring;
}

function wantedCapsule(p: WantedParts, name: string, parent: TransformNode, start: Vector3, end: Vector3, radiusStart: number, radiusEnd = radiusStart) {
  const delta = end.subtract(start);
  const radius = Math.max(radiusStart, radiusEnd);
  const mesh = place(MeshBuilder.CreateCapsule(name, { height: delta.length() + radius * 2, radius, radiusTop: radiusEnd, radiusBottom: radiusStart, tessellation: 24, capSubdivisions: 8 }, p.scene), parent, p.shell, start.add(end).scale(0.5));
  mesh.rotationQuaternion = alignY(delta);
  return mesh;
}

/**
 * Cartoon mitten hand from the parts sheet: a rounded palm, three fat fingers along local +Y and a thumb on the
 * `thumbSide` (±1 local X) edge, slightly curled toward +Z.
 */
function wantedHand(p: WantedParts, name: string, parent: TransformNode, thumbSide: number, curl: number) {
  const hand = new TransformNode(name, p.scene);
  hand.parent = parent;
  place(roundedBox(p.scene, `${name}-palm`, new Vector3(0.56, 0.48, 0.3), 2.4, 2.4, 32), hand, p.shell);
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 0.17 - thumbSide * 0.03;
    const length = [0.28, 0.32, 0.28][i];
    const spread = (i - 1) * -0.1 * thumbSide;
    const base = new Vector3(x, 0.16, 0);
    const tip = base.add(new Vector3(Math.sin(spread) * length, Math.cos(spread) * length * (1 - curl * 0.3), curl * length * 0.7));
    wantedCapsule(p, `${name}-finger-${i}`, hand, base, tip, 0.1);
  }
  wantedCapsule(p, `${name}-thumb`, hand, new Vector3(thumbSide * 0.22, -0.06, 0.05), new Vector3(thumbSide * 0.34, 0.12, 0.1 + curl * 0.12), 0.1);
  return hand;
}

/**
 * Segmented arm from the parts sheet: shoulder cap with a grey socket ring toward the body, upper arm, grey elbow
 * ring, forearm, grey wrist ring. The forearm and hand hang from an elbow pivot so the hand can wave.
 */
function wantedArm(p: WantedParts, name: string, root: TransformNode, shoulder: Vector3, elbow: Vector3, wrist: Vector3, side: number) {
  // The socket faces the body and sits inside the torso edge, so only a grey seam shows at the shoulder.
  place(MeshBuilder.CreateSphere(`${name}-cap`, { diameter: 0.6, segments: 28 }, p.scene), root, p.shell, shoulder);
  wantedRing(p, `${name}-socket`, root, shoulder.add(new Vector3(-side * 0.24, 0, 0)), new Vector3(1, 0, 0), 0.4, 0.1);
  wantedRing(p, `${name}-socket-hole`, root, shoulder.add(new Vector3(-side * 0.29, 0, 0)), new Vector3(1, 0, 0), 0.24, 0.02, p.dark);
  const upper = elbow.subtract(shoulder);
  const upperDir = upper.normalizeToNew();
  wantedCapsule(p, `${name}-upper`, root, shoulder.add(upperDir.scale(0.12)), elbow.subtract(upperDir.scale(0.3)), 0.24, 0.22);
  wantedRing(p, `${name}-elbow-ring`, root, elbow.subtract(upperDir.scale(0.06)), upper, 0.36, 0.16);
  const forearm = new TransformNode(`${name}-forearm-pivot`, p.scene);
  forearm.parent = root;
  forearm.position.copyFrom(elbow);
  const wristLocal = wrist.subtract(elbow);
  const foreDir = wristLocal.normalizeToNew();
  // Elbow ball (white) carries the bend, then the forearm widens toward the grey wrist ring.
  place(MeshBuilder.CreateSphere(`${name}-elbow`, { diameter: 0.44, segments: 24 }, p.scene), forearm, p.shell, Vector3.Zero());
  wantedCapsule(p, `${name}-forearm`, forearm, foreDir.scale(0.12), wristLocal.subtract(foreDir.scale(0.1)), 0.22, 0.25);
  wantedRing(p, `${name}-wrist-ring`, forearm, wristLocal.add(foreDir.scale(0.08)), wristLocal, 0.38, 0.12);
  return { forearm, wristLocal: wristLocal.add(foreDir.scale(0.12)) };
}

/** Upper-body waving robot built from the parts sheet and posed/measured from target/wanted-robot.png (100 px ≈ 1 unit). */
function buildWantedRobot(scene: Scene): WantedRobot {
  const root = new TransformNode("wanted-robot", scene);
  const p: WantedParts = {
    scene,
    shell: plastic(scene, "wanted-pearl-shell", "#F2F4F8", 0.3),
    metal: plastic(scene, "wanted-metal", "#8E959F", 0.4, 0.35),
    dark: plastic(scene, "wanted-socket-dark", "#4A5058", 0.6),
  };

  // Head: near-spherical helmet facing a little toward the viewer's left and tipped ~6°, as in the target.
  const head = new TransformNode("wanted-head", scene);
  head.parent = root;
  head.position.set(0.04, WANTED_HEAD.y, 0);
  head.rotation.set(0, 0.15, 0.1);
  place(roundedBox(scene, "wanted-head-shell", new Vector3(WANTED_HEAD.width, WANTED_HEAD.height, WANTED_HEAD.depth), WANTED_HEAD.xy, WANTED_HEAD.z, 64), head, p.shell);
  buildWantedVisor(scene, head, p.shell);
  // Ear pods: discs with flat outer faces and a slightly raised inner plate.
  for (const side of [-1, 1]) {
    const pod = place(roundedBox(scene, `wanted-ear-${side}`, new Vector3(1.04, 1.06, 0.34), 2.1, 3.4, 32), head, p.shell, new Vector3(side * 1.3, -0.04, 0.08));
    pod.rotation.y = Math.PI / 2;
    const plate = place(roundedBox(scene, `wanted-ear-plate-${side}`, new Vector3(0.8, 0.82, 0.1), 2.1, 3, 24), head, p.shell, new Vector3(side * 1.48, -0.04, 0.08));
    plate.rotation.y = Math.PI / 2;
  }
  // Antenna: domed collar, thin grey metal stem leaning a little, white ball.
  const collar = place(MeshBuilder.CreateSphere("wanted-antenna-collar", { diameter: 0.56, segments: 24, slice: 0.5 }, scene), head, p.shell, new Vector3(0, 1.08, -0.18));
  collar.scaling.y = 0.55;
  const stemBase = new Vector3(0, 1.2, -0.18);
  const stemTop = new Vector3(-0.04, 1.52, -0.26);
  const stem = place(MeshBuilder.CreateCylinder("wanted-antenna-stem", { diameter: 0.075, height: 0.36, tessellation: 16 }, scene), head, p.metal, Vector3.Lerp(stemBase, stemTop, 0.5));
  stem.rotationQuaternion = alignY(stemTop.subtract(stemBase));
  place(MeshBuilder.CreateSphere("wanted-antenna-tip", { diameter: 0.36, segments: 28 }, scene), head, p.shell, new Vector3(-0.05, 1.66, -0.29));

  // Neck connector: a grey collar and a narrower post that plugs into the torso's grey socket.
  wantedRing(p, "wanted-neck-collar", root, new Vector3(0.02, 2.74, 0), Vector3.Up(), 0.78, 0.18);
  wantedRing(p, "wanted-neck-post", root, new Vector3(0.02, 2.6, 0), Vector3.Up(), 0.6, 0.18);
  const torso = place(eggTorso(scene, "wanted-torso", 1.78, 2.1), root, p.shell, new Vector3(0, 1.6, 0));
  torso.scaling.z = 0.98;
  wantedRing(p, "wanted-torso-socket", root, new Vector3(0, 2.62, 0), Vector3.Up(), 0.98, 0.06);

  // Waving arm (+X, the viewer's left): low elbow, forearm up, open mitten facing the viewer.
  const wave = wantedArm(p, "wanted-wave", root, new Vector3(0.92, 2.32, 0.05), new Vector3(1.22, 1.7, 0.55), new Vector3(1.42, 2.12, 1.05), 1);
  const waveHand = wantedHand(p, "wanted-wave-hand", wave.forearm, 1, 0.05);
  waveHand.position.copyFrom(wave.wristLocal.add(new Vector3(0.06, 0.24, 0.02)));
  waveHand.rotation.set(0, 0, -0.3);

  // Resting arm (−X): hangs at the side, mitten pointing down with the thumb toward the body.
  const rest = wantedArm(p, "wanted-rest", root, new Vector3(-0.82, 2.2, 0.05), new Vector3(-1.04, 1.7, 0.5), new Vector3(-1.2, 1.28, 1.1), -1);
  const restHand = wantedHand(p, "wanted-rest-hand", rest.forearm, -1, 0.35);
  restHand.position.copyFrom(rest.wristLocal.add(new Vector3(-0.02, -0.24, 0.02)));
  restHand.rotation.set(0, 0, Math.PI + 0.25);

  return { root, waveArm: wave.forearm, head };
}

/** Hero camera angles; the non-front ones exist to check the model against the clay turnaround in target/vally/. */
const WANTED_VIEWS: Record<string, [number, number]> = { front: [Math.PI / 2, 1.47], right: [Math.PI, 1.47], left: [0, 1.47], back: [-Math.PI / 2, 1.47], top: [Math.PI, 0.12] };

function createWantedScene(engine: Engine, framing: "hero" | "avatar" = "hero", view = "front") {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 0);
  scene.ambientColor = new Color3(1, 1, 1);
  scene.imageProcessingConfiguration.toneMappingEnabled = true;
  scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  scene.imageProcessingConfiguration.exposure = 1.15;
  const avatar = framing === "avatar";
  const [alpha, beta] = WANTED_VIEWS[view] ?? WANTED_VIEWS.front;
  const camera = new ArcRotateCamera("wanted-robot-camera", alpha, beta, avatar ? 7.0 : 11.25, new Vector3(0, avatar ? 4.05 : 3.0, 0), scene);
  camera.fov = 0.52;
  camera.minZ = 0.1;
  camera.maxZ = 30;
  const ambient = new HemisphericLight("wanted-softbox", new Vector3(0.2, 1, 0.4), scene);
  ambient.intensity = 0.62;
  ambient.groundColor = new Color3(0.55, 0.64, 0.78);
  const key = new DirectionalLight("wanted-key-light", new Vector3(-0.6, -0.75, -1), scene);
  key.intensity = 2.5;
  const rim = new DirectionalLight("wanted-rim-light", new Vector3(0.6, -0.2, 1), scene);
  rim.intensity = 0.75;
  const robot = buildWantedRobot(scene);
  if (avatar) for (const mesh of robot.root.getChildMeshes(false)) if (!mesh.isDescendantOf(robot.head)) mesh.setEnabled(false);
  return { scene, camera, robot };
}

/** Soft contact shadow under the feet so the standing robot sits on whatever surface the canvas is on. */
function contactShadow(scene: Scene, parent: TransformNode) {
  const size = 256;
  const texture = new DynamicTexture("contact-shadow", { width: size, height: size }, scene, false);
  texture.hasAlpha = true;
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(10, 20, 35, 0.42)");
  gradient.addColorStop(0.55, "rgba(10, 20, 35, 0.2)");
  gradient.addColorStop(1, "rgba(10, 20, 35, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  texture.update();
  const mat = new PBRMaterial("contact-shadow", scene);
  mat.unlit = true;
  mat.albedoColor = Color3.Black();
  mat.albedoTexture = texture;
  mat.useAlphaFromAlbedoTexture = true;
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  const ground = MeshBuilder.CreateGround("contact-shadow", { width: 4.4, height: 2.8 }, scene);
  ground.position.y = 0.004;
  ground.material = mat;
  ground.parent = parent;
}

// ---------- poses ----------

/** Loop length per state (s). Every motion inside a state is periodic in it, so avatar sheets loop seamlessly. */
const PERIOD: Record<RobotState, number> = { idle: 6, listening: 3, thinking: 2.4, working: 2.4, talking: 2.4, happy: 1.6, error: 3 };

/** Eyelid openness for a blink centred at `at` (fraction of the loop) lasting `span`; 1 outside it. */
function blink(phase: number, at: number, span: number) {
  const d = Math.abs(phase - at) / (span / 2);
  return d >= 1 ? 1 : 0.1 + 0.9 * d * d;
}

/**
 * Gaze path: hold each [start, x, y] target until the next start, easing into it over `blend` of the loop, so
 * sampled frames (avatar sheets) turn smoothly as well as the eased hero.
 */
function glanceSmooth(phase: number, stops: Array<[number, number, number]>, blend = 0.06): [number, number] {
  let index = 0;
  for (let i = 0; i < stops.length; i++) if (phase >= stops[i][0]) index = i;
  const [start, x, y] = stops[index];
  const [, px, py] = stops[(index + stops.length - 1) % stops.length];
  const k = smoothstep((phase - start) / blend);
  return [px + (x - px) * k, py + (y - py) * k];
}

function smoothstep(u: number) { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); }

/** Stepped gaze: hold each [start, x, y] target until the next start; the hero's face easing turns steps into glances. */
function glance(phase: number, stops: Array<[number, number, number]>) {
  let current = stops[0];
  for (const stop of stops) if (phase >= stop[0]) current = stop;
  return current;
}
const REST_ARM: ArmPose = { swing: 0, raise: 0, bend: 0, wave: 0, grip: 0 };
const REST_LEG: LegPose = { hip: 0, knee: 0, foot: 0 };
/** Base attitude from the reference: head turned toward the viewer's left, tipped up, rolled a little. */
const BASE = { yaw: 0.4, headPitch: -0.14, headYaw: 0.2, headRoll: -0.09 };

/**
 * Target pose for `state` at time `t` (s). Signs, with the camera on +Z and +X at the viewer's left: arm swing < 0
 * and forearm bend < 0 move forward, raise is side × angle outward/up, lean > 0 tips the upper body forward,
 * head pitch < 0 looks up.
 */
function poseAt(state: RobotState, t: number): Pose {
  const phase = (t % PERIOD[state]) / PERIOD[state];
  const sin = (k: number) => Math.sin(2 * Math.PI * k * phase);
  const face: Face = { ...NEUTRAL_FACE };
  const pose: Pose = { turn: 0, x: 0, legs: [{ ...REST_LEG }, { ...REST_LEG }], lean: 0, sway: 0, bob: 0, headPitch: 0, headYaw: 0, headRoll: 0, arms: [{ ...REST_ARM }, { ...REST_ARM }], antenna: 0.15, face };
  const [right, left] = pose.arms; // index 0 is side −1, index 1 is side +1
  switch (state) {
    case "idle": {
      pose.bob = 0.025 * sin(1);
      pose.sway = 0.015 * sin(1);
      right.swing = 0.04 * sin(1);
      left.swing = -0.04 * sin(1);
      // Look around: centre → left → centre → right → up → down → centre. The head turns with the gaze (screen
      // +x is the viewer's right, head yaw > 0 turns toward the viewer's left, pitch > 0 looks down), and the
      // mouth rounds to an "o" when looking up. Blinks sit on 36-frame sheet frames (7, 21, 23).
      const [gx, gy] = glanceSmooth(phase, [[0, 0, 0], [0.1, -0.85, 0.05], [0.26, 0, 0], [0.36, 0.85, 0.05], [0.52, 0.1, -0.75], [0.66, -0.1, 0.65], [0.82, 0, 0]]);
      face.lookX = gx;
      face.lookY = gy;
      pose.headYaw = -0.42 * gx;
      pose.headPitch = 0.3 * gy;
      pose.headRoll = 0.03 * sin(2) - 0.06 * gx;
      if (gy < -0.4) face.mouth = "o";
      else face.width = 1 - 0.1 * Math.max(0, gy);
      face.lid = Math.min(blink(phase, 7 / 36, 0.03), blink(phase, 21 / 36, 0.025), blink(phase, 23 / 36, 0.025));
      break;
    }
    case "listening":
      pose.lean = 0.05;
      pose.headPitch = 0.08 + 0.04 * sin(2);
      pose.headRoll = 0.12;
      pose.bob = 0.015 * sin(1);
      right.swing = left.swing = -0.15;
      right.bend = left.bend = -0.25;
      // Attentive: slightly bigger eyes on the composer, a slow blink.
      face.lookY = 0.5;
      face.lookX = -0.25 + 0.1 * sin(1);
      face.scale = 1.1;
      face.width = 0.9;
      face.lid = blink(phase, 0.55, 0.07);
      pose.antenna = 0.35;
      break;
    case "thinking":
      // Head tipped up and aside, eyes up-right, one hand raised toward the chin, "…" on the screen.
      pose.headPitch = -0.12;
      pose.headRoll = 0.1 + 0.03 * sin(1);
      right.swing = -1.15;
      right.raise = -0.25;
      right.bend = -1.55;
      right.grip = -0.2; // curled at the chin
      left.swing = 0.05;
      // Eyes drift up and aside, narrowed in thought; "…" dots cycle twice per loop.
      face.lookX = 0.65 + 0.12 * sin(1);
      face.lookY = -0.7 + 0.08 * sin(2);
      face.scale = 0.95;
      face.lid = Math.min(0.82, blink(phase, 0.85, 0.05));
      face.mouth = "dots";
      face.open = Math.floor(phase * 6) % 3;
      pose.antenna = 0.4 + 0.6 * (0.5 + 0.5 * sin(1));
      break;
    case "working":
      // Hunched over a keyboard: both forearms forward, alternating taps, eyes scanning.
      pose.lean = 0.08;
      pose.headPitch = 0.14;
      right.swing = -0.7 + 0.07 * sin(2);
      left.swing = -0.7 - 0.07 * sin(2);
      right.bend = left.bend = -0.95;
      right.raise = left.raise = -0.3; // hands come in front of the body
      right.wave = 0.25;
      left.wave = -0.25;
      // Claws click like keystrokes, out of step with each other.
      right.grip = 0.12 * sin(4);
      left.grip = -0.12 * sin(4);
      // Reading: eyes sweep left to right along a line, flick back, drop a line; one blink per loop.
      {
        const line = (phase * 3) % 1;
        face.eyes = "focus";
        face.lookX = line < 0.85 ? -0.6 + 1.2 * (line / 0.85) : 0.6 - 1.2 * ((line - 0.85) / 0.15);
        face.lookY = 0.3 + 0.15 * Math.floor(phase * 3);
        face.lid = blink(phase, 0.97, 0.04);
        face.mouth = "flat";
        face.width = 0.9 + 0.1 * sin(2);
      }
      pose.antenna = phase % 0.5 < 0.25 ? 1 : 0.3;
      break;
    case "talking":
      pose.headPitch = 0.04 * sin(3);
      pose.headYaw = -0.2 * sin(1); // turns between listeners, gaze leading
      pose.bob = 0.012 * sin(2);
      left.swing = -0.3 + 0.1 * sin(1);
      left.bend = -0.9 + 0.1 * sin(2);
      left.raise = 0.02;
      left.grip = 0.2 + 0.1 * sin(2); // open, gesturing
      // Syllables of varying height and width, lips closing between two "words"; eyes widen on the stressed beat.
      {
        const gap = Math.abs(phase - 0.5) < 0.06 || phase > 0.94 || phase < 0.02;
        face.mouth = "talk";
        face.open = gap ? 0 : Math.abs(Math.sin(Math.PI * 10 * phase)) * (0.5 + 0.5 * Math.abs(sin(3)));
        face.width = 0.8 + 0.4 * Math.abs(Math.sin(Math.PI * 7 * phase + 0.7));
        face.scale = 1 + 0.06 * Math.max(0, sin(2));
        face.lookX = 0.45 * sin(1);
        face.lid = blink(phase, 0.5, 0.05);
      }
      pose.antenna = 0.5;
      break;
    case "happy":
      // Wave with the arm on +X, a little bounce, happy eyes and an open grin.
      pose.bob = 0.06 * Math.abs(sin(2));
      pose.headRoll = 0.12 * sin(1);
      left.raise = 2.5;
      left.bend = -0.2;
      left.wave = 0.5 * sin(2);
      left.grip = 0.35;
      right.swing = 0.05;
      face.eyes = "happy";
      face.mouth = "grin";
      face.scale = 1 + 0.08 * Math.abs(sin(2));
      face.width = 1 + 0.08 * Math.abs(sin(2));
      pose.antenna = 1;
      break;
    case "error":
      pose.lean = 0.1;
      pose.headPitch = 0.28;
      pose.headRoll = -0.1;
      pose.headYaw = 0.04 * sin(3);
      right.raise = 0.08;
      left.raise = -0.08;
      right.grip = left.grip = -0.15; // limp
      // Downcast: heavy lids with one slow blink, gaze down and aside, a trembling frown.
      face.eyes = "sad";
      face.mouth = "frown";
      face.lookY = 0.5;
      face.lookX = -0.2;
      face.lid = Math.min(0.75, blink(phase, 0.7, 0.16));
      face.width = 1 + 0.05 * sin(6);
      face.tone = "red";
      pose.antenna = 0.8;
      break;
  }
  return pose;
}

const ANTENNA_GLOW = { blue: Color3.FromHexString("#3B8CFF"), red: Color3.FromHexString("#FF4A3A") };
/** The antenna ball itself turns red on error (red glow over a blue ball read as purple). */
const ANTENNA_BALL = { blue: Color3.FromHexString("#2F7BEA").toLinearSpace(), red: Color3.FromHexString("#E5463A").toLinearSpace() };

/**
 * Move the rig toward `target`; `k` is the blend factor (1 snaps, smaller eases). Face shapes (eyes, mouth, tone)
 * switch immediately, gaze/size/mouth values ease about twice as fast as the body, and lids follow at once so
 * blinks stay crisp.
 */
/**
 * Per-channel velocities for the hero's spring-driven pose. Body, head and arms follow their targets as damped
 * springs (ζ < 1), so stops overshoot a little and settle instead of easing to a dead halt.
 */
type Springs = { dt: number; velocity: Map<string, number> };

function applyPose(robot: Robot, current: Pose, target: Pose, k: number, springs?: Springs) {
  const mix = (a: number, b: number) => a + (b - a) * k;
  // Semi-implicit spring step (sub-stepped at ≤ 1/60 s); falls back to `mix` for snaps and sheet frames.
  const follow = (key: string, a: number, b: number, omega = 9, zeta = 0.6) => {
    if (!springs) return mix(a, b);
    let v = springs.velocity.get(key) ?? 0;
    const steps = Math.max(1, Math.ceil(springs.dt * 60));
    const h = springs.dt / steps;
    for (let i = 0; i < steps; i++) {
      v += (omega * omega * (b - a) - 2 * zeta * omega * v) * h;
      a += v * h;
    }
    springs.velocity.set(key, v);
    return a;
  };
  current.lean = follow("lean", current.lean, target.lean);
  current.sway = follow("sway", current.sway, target.sway);
  current.bob = mix(current.bob, target.bob);
  current.headPitch = follow("headPitch", current.headPitch, target.headPitch, 10);
  current.headYaw = follow("headYaw", current.headYaw, target.headYaw, 10);
  current.headRoll = follow("headRoll", current.headRoll, target.headRoll, 10);
  current.antenna = mix(current.antenna, target.antenna);
  current.turn = follow("turn", current.turn, target.turn, 8, 0.55);
  current.x = follow("x", current.x, target.x, 8, 0.7);
  robot.root.rotation.y = robot.baseYaw + current.turn;
  robot.root.position.x = current.x;
  robot.legs.forEach(({ thigh, shin, foot }, i) => {
    const c = current.legs[i];
    const g = target.legs[i];
    c.hip = mix(c.hip, g.hip);
    c.knee = mix(c.knee, g.knee);
    c.foot = mix(c.foot, g.foot);
    thigh.rotation.x = c.hip;
    shin.rotation.x = c.knee;
    foot.rotation.x = c.foot;
  });
  robot.upper.rotation.set(current.lean, 0, current.sway);
  robot.upper.position.y = current.bob;
  const att = robot.attitude;
  robot.head.rotation.set(att.pitch + current.headPitch * att.motion, att.yaw + current.headYaw * att.motion, att.roll + current.headRoll * att.motion);
  robot.arms.forEach(({ arm, forearm, side, fingers }, i) => {
    const c = current.arms[i];
    const g = target.arms[i];
    c.swing = follow(`swing${i}`, c.swing, g.swing, 11);
    c.raise = follow(`raise${i}`, c.raise, g.raise, 11);
    c.bend = follow(`bend${i}`, c.bend, g.bend, 12);
    c.wave = follow(`wave${i}`, c.wave, g.wave, 14);
    c.grip = follow(`grip${i}`, c.grip, g.grip, 16, 0.5);
    arm.rotation.set(c.swing, 0, side * c.raise);
    forearm.rotation.set(c.bend, 0, c.wave);
    // Opening swings each finger's tip outward about its palm hinge.
    for (const { node, sign } of fingers) node.rotation.z = sign * c.grip;
  });
  robot.antenna.emissiveColor = ANTENNA_GLOW[target.face.tone].scale(current.antenna * 0.9);
  robot.antenna.albedoColor = ANTENNA_BALL[target.face.tone];
  const kf = Math.min(1, k * 2.2);
  const face = current.face;
  const ease = (a: number, b: number) => a + (b - a) * kf;
  face.eyes = target.face.eyes;
  face.mouth = target.face.mouth;
  face.tone = target.face.tone;
  face.lid = target.face.lid;
  face.lookX = ease(face.lookX, target.face.lookX);
  face.lookY = ease(face.lookY, target.face.lookY);
  face.scale = ease(face.scale, target.face.scale);
  face.width = ease(face.width, target.face.width);
  // Discrete mouth counters (the "…" dot index) must not be blended.
  face.open = target.face.mouth === "dots" ? target.face.open : ease(face.open, target.face.open);
  robot.setFace(face);
}

function clonePose(pose: Pose): Pose {
  return { ...pose, arms: [{ ...pose.arms[0] }, { ...pose.arms[1] }], legs: [{ ...pose.legs[0] }, { ...pose.legs[1] }], face: { ...pose.face } };
}

function createScene(engine: Engine, framing: Framing) {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 0);
  scene.ambientColor = new Color3(1, 1, 1);
  // Filmic tone mapping keeps the white shell from clipping to a flat silhouette.
  scene.imageProcessingConfiguration.toneMappingEnabled = true;
  scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  scene.imageProcessingConfiguration.exposure = 1.25;
  const avatar = framing === "avatar";
  const headFront = framing === "head-front";
  const camera = headFront
    // Straight on, framed like target/3d-robot-head.png (head ≈ 285 px wide in 451×433, centred a little right).
    ? new ArcRotateCamera("robot-camera", Math.PI / 2, Math.PI / 2, 5.95 * HEAD.scale, new Vector3(0.1 * HEAD.scale, HEAD.y + 0.05 * HEAD.scale, 0), scene)
    : avatar
      // Head-only portrait: head + ears + antenna fill ~80% of the square, nothing cropped.
      ? new ArcRotateCamera("robot-camera", Math.PI / 2, 1.47, 5.7 * HEAD.scale, new Vector3(0, HEAD.y + 0.26 * HEAD.scale, 0), scene)
      // Hero framing reproduces the full standing reference.
      : new ArcRotateCamera("robot-camera", Math.PI / 2, 1.42, 18.5, new Vector3(0, BODY.height / 2 - 0.08, 0), scene);
  camera.fov = 0.5;
  camera.minZ = 0.1;
  camera.maxZ = 40;
  if (framing === "hero") {
    camera.panningSensibility = 0;
    camera.wheelPrecision = 60;
    camera.lowerRadiusLimit = 14;
    camera.upperRadiusLimit = 24;
    camera.lowerBetaLimit = 0.9;
    camera.upperBetaLimit = 1.9;
    camera.attachControl(engine.getRenderingCanvas(), true);
  }

  // Soft studio: sky fill with a cool bounce, key from the viewer's upper left-front, faint rim from behind right.
  // With the camera on +Z (alpha = π/2), +X is the viewer's left.
  const ambient = new HemisphericLight("softbox", new Vector3(0.2, 1, 0.4), scene);
  ambient.intensity = 0.55;
  ambient.groundColor = new Color3(0.45, 0.6, 0.72);
  const key = new DirectionalLight("key-light", new Vector3(-0.6, -0.75, -1), scene);
  key.intensity = 2.5;
  const rim = new DirectionalLight("rim-light", new Vector3(0.6, -0.2, 1), scene);
  rim.intensity = 0.9;

  const robot = buildRobot(scene);
  if (framing === "hero") contactShadow(scene, robot.root);
  // The reference is a gentle three-quarter view: face turned toward the viewer's left.
  // Avatars nearly face the camera so the expression reads at 24 px.
  robot.baseYaw = headFront ? 0 : avatar ? 0 : BASE.yaw;
  robot.root.rotation.y = robot.baseYaw;
  if (avatar) {
    // Portrait: a slight 3/4 for depth, half-strength head motion so droops and tilts never hide the face,
    // and only the head rendered (shoulders and neck are noise at 22 px).
    robot.attitude = { pitch: -0.05, yaw: 0.16, roll: -0.04, motion: 0.75 };
    for (const mesh of robot.root.getChildMeshes(false)) if (!mesh.isDescendantOf(robot.head)) mesh.setEnabled(false);
  }
  const pose = poseAt("idle", 0);
  applyPose(robot, clonePose(pose), pose, 1);
  if (headFront) robot.head.rotation.set(0, 0, 0);
  return { scene, camera, robot };
}

// ---------- play: idle acts, tap reaction, pointer look (hero only) ----------

type Play = "curious" | "look-around" | "check-hand" | "nod" | "wiggle" | "stretch" | "peek" | "giggle" | "turn-around" | "walk" | "dance";
/** How long each act lasts (s). "giggle" is the tap reaction; the rest are picked at random while idle. */
const PLAY_LENGTH: Record<Play, number> = {
  curious: 2.2, "look-around": 3, "check-hand": 2.4, nod: 1.4, wiggle: 1.4, stretch: 2.8, peek: 2, giggle: 1.4,
  "turn-around": 3, walk: 7, dance: 3.2
};
const IDLE_PLAYS: Play[] = ["curious", "look-around", "check-hand", "nod", "wiggle", "stretch", "peek", "turn-around", "walk", "dance"];

const smooth = smoothstep;

/**
 * Stepping legs for `cycles` full strides over the act (two steps per cycle). Each leg swings forward with its knee
 * bent (the swing phase), plants, and pushes back straight; the shoe stays roughly level; arms swing against the
 * legs and the body bobs twice per cycle. `weight` fades the gait in and out.
 */
function step(pose: Pose, phase: number, stride: number, lift: number, weight: number) {
  pose.legs.forEach((leg, i) => {
    const p = 2 * Math.PI * (phase + i * 0.5);
    const swinging = Math.max(0, Math.cos(p));
    leg.hip += -stride * Math.sin(p) * weight;
    leg.knee += lift * swinging * weight;
    leg.foot += (stride * Math.sin(p) - 0.8 * lift * swinging) * weight;
    // Opposite-side arm swings with this leg: the arm on the same side swings against it.
    pose.arms[i].swing += 0.8 * stride * Math.sin(p) * weight;
  });
  pose.bob += 0.05 * Math.abs(Math.cos(2 * Math.PI * phase)) * weight - 0.02 * weight;
  pose.sway += 0.03 * Math.sin(2 * Math.PI * phase) * weight;
}

/**
 * Layer a short act over the state pose. `u` runs 0→1 over the act; `env` rises and falls with it, so every act
 * blends in and out of whatever the state is doing. Same sign conventions as `poseAt`.
 */
function playOver(pose: Pose, play: Play, u: number) {
  const env = Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
  const face = pose.face;
  const [right, left] = pose.arms;
  switch (play) {
    case "curious": // head cocked, eyes big and up, a little "o"
      pose.headRoll += 0.35 * env;
      pose.headPitch -= 0.1 * env;
      face.scale = 1 + 0.15 * env;
      face.lookX = 0.5 * env;
      face.lookY = -0.4 * env;
      if (env > 0.5) face.mouth = "o";
      break;
    case "look-around": // head sweeps to one side then the other, eyes leading
      pose.headYaw += 0.7 * Math.sin(2 * Math.PI * u) * env;
      pose.turn += 0.15 * Math.sin(2 * Math.PI * u) * env;
      face.lookX = -0.9 * Math.sin(2 * Math.PI * u + 0.4);
      break;
    case "check-hand": // lifts a hand and inspects it
      right.swing += -1.0 * env;
      right.bend += -1.2 * env;
      right.raise += -0.2 * env;
      pose.headPitch += 0.25 * env;
      pose.headYaw += -0.35 * env;
      face.lookX = 0.6 * env;
      face.lookY = 0.6 * env;
      right.grip += 0.4 * Math.max(0, Math.sin(4 * Math.PI * u)) * env; // snaps the claw open and shut, twice
      if (env > 0.6) face.mouth = "o";
      break;
    case "nod":
      pose.headPitch += 0.18 * Math.sin(4 * Math.PI * u) * env;
      face.width = 1.1;
      break;
    case "wiggle": // happy head wiggle, antenna lit
      pose.headRoll += 0.16 * Math.sin(6 * Math.PI * u) * env;
      face.eyes = "happy";
      pose.antenna = Math.max(pose.antenna, env);
      break;
    case "stretch": // arms up, leans back, yawns with eyes shut
      right.raise += 2.3 * env;
      left.raise += 2.3 * env;
      right.bend += -0.3 * env;
      left.bend += -0.3 * env;
      pose.lean -= 0.06 * env;
      pose.headPitch -= 0.2 * env;
      if (env > 0.6) {
        face.lid = 0.15;
        face.mouth = "talk";
        face.open = env;
        face.width = 0.9;
      }
      break;
    case "peek": // leans to one side and peers past something
      pose.sway += 0.12 * env;
      pose.headRoll += -0.2 * env;
      pose.headYaw += 0.4 * env;
      face.lookX = -0.9 * env;
      face.scale = 1 + 0.08 * env;
      break;
    case "turn-around": { // wind-up, then a full spin in place, stepping round, arms a little out
      // Anticipation: crouch and twist the other way for the first ~15%, then spin.
      const windup = u < 0.15 ? smooth(u / 0.15) : 1 - smooth((u - 0.15) / 0.1);
      pose.turn += -0.3 * windup + 2 * Math.PI * smooth((u - 0.12) / 0.78);
      pose.bob -= 0.08 * windup;
      for (const leg of pose.legs) leg.knee += 0.25 * windup;
      step(pose, u * 3, 0.16, 0.7, u > 0.2 ? env : 0);
      pose.arms[0].raise += 0.25 * env;
      pose.arms[1].raise += 0.25 * env;
      face.eyes = u > 0.3 && u < 0.7 ? "happy" : face.eyes;
      break;
    }
    case "walk": { // turn to the viewer's left, stroll across, turn, stroll back, face front
      const baseYaw = BASE.yaw;
      const toLeft = Math.PI / 2 - baseYaw;
      const toRight = -Math.PI / 2 - baseYaw;
      let turn = 0;
      let x = 0;
      let walking = 0;
      let walkPhase = 0;
      // Anticipation: a small crouch before setting off.
      if (u < 0.06) {
        pose.bob -= 0.06 * Math.sin(Math.PI * u / 0.06);
        for (const leg of pose.legs) leg.knee += 0.2 * Math.sin(Math.PI * u / 0.06);
      }
      if (u < 0.12) turn = toLeft * smooth(u / 0.12);
      else if (u < 0.42) { turn = toLeft; x = 0.5 * ((u - 0.12) / 0.3); walking = 1; walkPhase = (u - 0.12) / 0.3 * 2; }
      else if (u < 0.55) { turn = toLeft + (toRight - toLeft) * smooth((u - 0.42) / 0.13); x = 0.5; }
      else if (u < 0.85) { turn = toRight; x = 0.5 * (1 - (u - 0.55) / 0.3); walking = 1; walkPhase = (u - 0.55) / 0.3 * 2; }
      else turn = toRight * (1 - smooth((u - 0.85) / 0.15));
      pose.turn += turn;
      pose.x += x;
      if (walking) step(pose, walkPhase, 0.32, 0.75, 1);
      face.lookX = turn > 0.3 ? -0.6 : turn < -0.3 ? 0.6 : face.lookX;
      face.width = 1.1;
      break;
    }
    case "dance": { // march in place, pumping arms, bobbing head, swaying the hips
      const beat = u * 4;
      step(pose, beat, 0.1, 1.0, env);
      pose.arms.forEach((arm, i) => {
        const pump = Math.sin(2 * Math.PI * (beat + i * 0.5));
        arm.swing += (-0.7 + 0.5 * pump) * env;
        arm.bend += -1.1 * env;
        arm.raise += 0.15 * env;
      });
      pose.turn += 0.3 * Math.sin(Math.PI * beat) * env;
      pose.headRoll += 0.15 * Math.sin(2 * Math.PI * beat) * env;
      face.eyes = "happy";
      face.mouth = "grin";
      pose.antenna = Math.max(pose.antenna, 0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * beat)));
      break;
    }
    case "giggle": // tap reaction: bounce, wiggle, ^^ and a grin
      pose.bob += 0.08 * Math.abs(Math.sin(4 * Math.PI * u)) * env;
      pose.headRoll += 0.2 * Math.sin(6 * Math.PI * u) * env;
      face.eyes = "happy";
      face.mouth = "grin";
      face.width = 1 + 0.1 * env;
      right.grip += 0.3 * env;
      left.grip += 0.3 * env;
      pose.antenna = 1;
      break;
  }
}

/**
 * Turn the body a little, the head more and the eyes most toward a point given in screen space relative to the
 * robot (−1..1 each way, +y down). `weight` fades the look in and out. Totals cancel the framing's 3/4 turn so a
 * centred pointer gets a straight-on look.
 */
function lookToward(pose: Pose, x: number, y: number, weight: number, baseYaw: number) {
  const blend = (value: number, look: number) => value + (look - value) * weight;
  pose.turn = blend(pose.turn, -0.25 * baseYaw - 0.25 * x);
  pose.headYaw = blend(pose.headYaw, Math.max(-1.2, Math.min(0.3, -0.75 * baseYaw - BASE.headYaw - 0.6 * x)));
  pose.headPitch = blend(pose.headPitch, -BASE.headPitch + 0.3 * y);
  pose.headRoll = blend(pose.headRoll, -BASE.headRoll - 0.06 * x);
  pose.face.lookX = blend(pose.face.lookX, 0.85 * x);
  pose.face.lookY = blend(pose.face.lookY, 0.8 * y);
}

// ---------- secondary motion (hero only) ----------

/**
 * Follow-through driven by how the body actually moved this frame: the antenna wobbles on a damped spring against
 * head rotation and sideways acceleration, and the head bounces on its coil against vertical acceleration (the coil
 * stretches with it) and jiggles sideways against sway. Purely visual: it never feeds back into the pose.
 */
function secondaryMotion(robot: Robot) {
  const state = { last: undefined as undefined | { pitch: number; roll: number; yaw: number; x: number; y: number; vPitch: number; vRoll: number; vYaw: number; vx: number; vy: number } };
  const antenna = { x: 0, vx: 0, z: 0, vz: 0 };
  const neck = { s: 0, v: 0, roll: 0, vRoll: 0 };
  const spring = (p: { pos: number; vel: number }, drive: number, omega: number, zeta: number, h: number) => {
    p.vel += (-omega * omega * p.pos - 2 * zeta * omega * p.vel + drive) * h;
    p.pos += p.vel * h;
  };
  return (pose: Pose, dt: number) => {
    if (dt <= 0) return;
    const pitch = pose.lean + pose.headPitch;
    const roll = pose.sway + pose.headRoll;
    const yaw = pose.turn + pose.headYaw;
    const prev = state.last;
    const vPitch = prev ? (pitch - prev.pitch) / dt : 0;
    const vRoll = prev ? (roll - prev.roll) / dt : 0;
    const vYaw = prev ? (yaw - prev.yaw) / dt : 0;
    const vx = prev ? (pose.x - prev.x) / dt : 0;
    const vy = prev ? (pose.bob - prev.y) / dt : 0;
    const aPitch = prev ? (vPitch - prev.vPitch) / dt : 0;
    const aRoll = prev ? (vRoll - prev.vRoll) / dt : 0;
    const aYaw = prev ? (vYaw - prev.vYaw) / dt : 0;
    const ax = prev ? (vx - prev.vx) / dt : 0;
    const ay = prev ? (vy - prev.vy) / dt : 0;
    state.last = { pitch, roll, yaw, x: pose.x, y: pose.bob, vPitch, vRoll, vYaw, vx, vy };
    const steps = Math.max(1, Math.ceil(dt * 120));
    const h = dt / steps;
    const ax_ = { pos: antenna.x, vel: antenna.vx };
    const az_ = { pos: antenna.z, vel: antenna.vz };
    const ns = { pos: neck.s, vel: neck.v };
    const nr = { pos: neck.roll, vel: neck.vRoll };
    for (let i = 0; i < steps; i++) {
      // The antenna lags head rotation; sideways and spin accelerations throw it to the side.
      spring(ax_, -aPitch * 1.1, 14, 0.18, h);
      spring(az_, -aRoll * 1.1 + ax * 0.35 - aYaw * 0.12, 14, 0.18, h);
      // The head sinks on its coil as the body is pushed up, and sways a beat behind the torso.
      spring(ns, -ay * 0.5, 16, 0.3, h);
      spring(nr, -aRoll * 0.25 + ax * 0.08, 11, 0.35, h);
    }
    const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
    antenna.x = ax_.pos = clamp(ax_.pos, 0.6); antenna.vx = ax_.vel;
    antenna.z = az_.pos = clamp(az_.pos, 0.6); antenna.vz = az_.vel;
    neck.s = ns.pos = clamp(ns.pos, 0.09); neck.v = ns.vel;
    neck.roll = nr.pos = clamp(nr.pos, 0.12); neck.vRoll = nr.vel;
    robot.antennaStem.rotation.set(antenna.x, 0, antenna.z);
    robot.headBody.position.y = robot.headRest + neck.s;
    robot.coil.scaling.y = 1 + neck.s / robot.coilLength;
    robot.head.rotation.z += neck.roll;
  };
}

// ---------- avatar sprites and sheets ----------

const AVATAR_PX = 128;
const SHEET_FRAMES = 16;
/** 36 frames over idle's 6 s look-around; its blinks sit exactly on frames (7, 21, 23) so none falls between. */
const IDLE_FRAMES = 36;

type Studio = { engine: Engine; scene: Scene; robot: Robot; canvas: HTMLCanvasElement };
let studio: Promise<Studio> | undefined;
let studioQueue: Promise<unknown> = Promise.resolve();
let studioTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * One offscreen engine renders every avatar still and sheet, one job at a time, and is disposed after a quiet
 * spell so idle webviews hold no WebGL context.
 */
function withStudio<T>(job: (studio: Studio) => Promise<T> | T): Promise<T> {
  const run = studioQueue.then(async () => {
    clearTimeout(studioTimer);
    studio ??= (async () => {
      const canvas = Object.assign(document.createElement("canvas"), { width: AVATAR_PX * 2, height: AVATAR_PX * 2 });
      const engine = new Engine(canvas, true, { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: false, powerPreference: "low-power" }, false);
      const { scene, robot } = createScene(engine, "avatar");
      // A render before shaders compile gives an empty frame.
      await scene.whenReadyAsync();
      return { engine, scene, robot, canvas };
    })();
    const s = await studio;
    try {
      return await job(s);
    } finally {
      studioTimer = setTimeout(() => {
        const done = studio;
        studio = undefined;
        void done?.then(({ scene, engine }) => { scene.dispose(); engine.dispose(); });
      }, 15000);
    }
  });
  studioQueue = run.catch(() => undefined);
  return run;
}

function renderFrame({ scene, robot }: Studio, state: RobotState, t: number) {
  const pose = poseAt(state, t);
  pose.face.bold = true;
  applyPose(robot, clonePose(pose), pose, 1);
  scene.render();
}

let spritePromise: Promise<string | undefined> | undefined;
let wantedSpritePromise: Promise<string | undefined> | undefined;
const sheets = new Map<RobotState, Promise<AvatarSheet | undefined>>();

const runtime: RobotRuntime = {
  getAvatarSprite(model = "default") {
    if (model === "wanted") {
      wantedSpritePromise ??= (async () => {
        const canvas = Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
        const engine = new Engine(canvas, true, { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: false, powerPreference: "low-power" }, false);
        try {
          const { scene } = createWantedScene(engine, "avatar");
          await scene.whenReadyAsync();
          scene.render();
          return canvas.toDataURL("image/png");
        } finally {
          engine.scenes[0]?.dispose();
          engine.dispose();
        }
      })().catch(() => undefined);
      return wantedSpritePromise;
    }
    spritePromise ??= withStudio(s => {
      renderFrame(s, "idle", 0);
      return s.canvas.toDataURL("image/png");
    }).catch(() => undefined);
    return spritePromise;
  },
  getAvatarSheet(state, model = "default") {
    if (model === "wanted") return runtime.getAvatarSprite("wanted").then(url => url ? { url, frames: 1, duration: 0 } : undefined);
    if (!PERIOD[state]) return Promise.resolve(undefined);
    let sheet = sheets.get(state);
    if (!sheet) {
      sheet = withStudio(async s => {
        // Idle gets a longer, gentler loop (blinks, a glance, slight sway) so resting avatars still look alive.
        const frames = state === "idle" ? IDLE_FRAMES : SHEET_FRAMES;
        const strip = Object.assign(document.createElement("canvas"), { width: AVATAR_PX * frames, height: AVATAR_PX });
        const ctx = strip.getContext("2d")!;
        // Downsample the 2× studio render, with a soft drop shadow so the white head separates from any background.
        ctx.imageSmoothingQuality = "high";
        ctx.shadowColor = "rgba(8, 20, 40, 0.35)";
        ctx.shadowBlur = AVATAR_PX * 0.04;
        ctx.shadowOffsetY = AVATAR_PX * 0.015;
        for (let i = 0; i < frames; i++) {
          renderFrame(s, state, (i / frames) * PERIOD[state]);
          ctx.drawImage(s.canvas, i * AVATAR_PX, 0, AVATAR_PX, AVATAR_PX);
          // Yield between frames so a sheet never blocks the webview for long.
          if (i % 4 === 3) await new Promise(resolve => setTimeout(resolve, 0));
        }
        return { url: strip.toDataURL("image/png"), frames, duration: Math.round(PERIOD[state] * 1000) };
      }).catch(() => undefined);
      sheets.set(state, sheet);
    }
    return sheet;
  },
  mount(canvas, model) {
    try {
      const engine = new Engine(canvas, true, { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false, stencil: false, powerPreference: "low-power" }, false);
      const selectedModel = model ?? (canvas.dataset.robotModel === "wanted" ? "wanted" : "default");
      if (selectedModel === "wanted") {
        const { scene, robot } = createWantedScene(engine, "hero", canvas.dataset.robotView);
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const start = performance.now();
        const roll = robot.head.rotation.z;
        scene.registerBeforeRender(() => {
          if (reducedMotion) return;
          const t = (performance.now() - start) / 1000;
          robot.root.position.y = 0.025 * Math.sin(t * 1.2);
          robot.waveArm.rotation.z = 0.12 * Math.sin(t * 3.2);
          robot.head.rotation.z = roll + 0.025 * Math.sin(t * 0.9);
        });
        engine.runRenderLoop(() => scene.render());
        const resize = () => engine.resize();
        const observer = new ResizeObserver(resize);
        observer.observe(canvas);
        return () => { observer.disconnect(); scene.dispose(); engine.dispose(); };
      }
      const framing: Framing = canvas.dataset.robotView === "head-front" ? "head-front" : "hero";
      const { scene, robot } = createScene(engine, framing);
      const cleanups: Array<() => void> = [];
      if (framing === "hero") {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const states = Object.keys(PERIOD) as RobotState[];
        const mountedAt = performance.now();
        const current = poseAt("idle", 0);
        const springs: Springs = { dt: 0, velocity: new Map() };
        const follow = secondaryMotion(robot);
        let last = mountedAt;
        // Play: one act at a time; idle picks a random one every 5–10 s, a tap starts "giggle".
        let play: { kind: Play; start: number } | undefined;
        let nextPlay = mountedAt + 5000 + Math.random() * 5000;
        // Pointer anywhere in the webview: the robot looks at it, fading back 2.5 s after it stops moving.
        let pointer: { x: number; y: number; at: number } | undefined;
        let lookWeight = 0;
        let press: { x: number; y: number; at: number } | undefined;
        const onMove = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY, at: performance.now() }; };
        const onDown = (event: PointerEvent) => { press = { x: event.clientX, y: event.clientY, at: performance.now() }; };
        const onUp = (event: PointerEvent) => {
          // A tap (not a camera drag) on the robot makes it giggle.
          if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 6 && performance.now() - press.at < 350) {
            play = { kind: "giggle", start: performance.now() };
          }
          press = undefined;
        };
        if (!reducedMotion) {
          window.addEventListener("pointermove", onMove, { passive: true });
          canvas.addEventListener("pointerdown", onDown);
          canvas.addEventListener("pointerup", onUp);
          cleanups.push(() => {
            window.removeEventListener("pointermove", onMove);
            canvas.removeEventListener("pointerdown", onDown);
            canvas.removeEventListener("pointerup", onUp);
          });
        }
        scene.registerBeforeRender(() => {
          const now = performance.now();
          const dt = Math.min(0.1, (now - last) / 1000);
          last = now;
          const requested = canvas.dataset.robotState as RobotState | undefined;
          // Greet with a wave on first appearance unless the host already asked for something else.
          let state: RobotState = requested && states.includes(requested) ? requested : "idle";
          if (state === "idle" && now - mountedAt < 2600) state = "happy";
          // Reduced motion: hold each state's first pose (expressions still change), no looping movement or play.
          const target = poseAt(state, reducedMotion ? 0 : (now - mountedAt) / 1000);
          if (!reducedMotion) {
            // Hosts and previews can request an act: data-robot-play="curious" (cleared once it starts).
            const asked = canvas.dataset.robotPlay as Play | undefined;
            if (asked && PLAY_LENGTH[asked]) {
              play = { kind: asked, start: now };
              delete canvas.dataset.robotPlay;
            }
            const tracking = pointer && now - pointer.at < 2500 && (state === "idle" || state === "listening");
            if (!play && state === "idle" && !tracking && now >= nextPlay) {
              play = { kind: IDLE_PLAYS[Math.floor(Math.random() * IDLE_PLAYS.length)], start: now };
            }
            if (play) {
              const u = (now - play.start) / (PLAY_LENGTH[play.kind] * 1000);
              if (u >= 1 || (state !== "idle" && play.kind !== "giggle")) {
                play = undefined;
                // A spin ends a full turn away; drop whole turns so easing doesn't unwind it backwards.
                current.turn -= 2 * Math.PI * Math.round(current.turn / (2 * Math.PI));
                nextPlay = now + 5000 + Math.random() * 5000;
              } else playOver(target, play.kind, u);
            }
            lookWeight += ((tracking && !play ? 1 : 0) - lookWeight) * (1 - Math.exp(-dt * 4));
            if (pointer && lookWeight > 0.01) {
              const box = canvas.getBoundingClientRect();
              // Aim at the head (upper fifth of the canvas), normalised by the window so far corners saturate.
              const x = (pointer.x - (box.left + box.width / 2)) / Math.max(200, window.innerWidth / 2);
              const y = (pointer.y - (box.top + box.height * 0.2)) / Math.max(200, window.innerHeight / 2);
              lookToward(target, Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)), lookWeight, robot.baseYaw);
            }
          }
          if (reducedMotion) applyPose(robot, current, target, 1);
          else {
            springs.dt = dt;
            applyPose(robot, current, target, 1 - Math.exp(-dt * 7), springs);
            follow(current, dt);
          }
        });
      }
      engine.runRenderLoop(() => scene.render());
      const resize = () => engine.resize();
      const observer = new ResizeObserver(resize);
      observer.observe(canvas);
      return () => {
        for (const cleanup of cleanups) cleanup();
        observer.disconnect();
        scene.dispose();
        engine.dispose();
      };
    } catch {
      return undefined;
    }
  }
};

window.AgentRobot3D = runtime;

// Exported for preview probes (.claude/skills/robot-3d/scripts) that render exact poses without the clock;
// the bundled IIFE only uses the window global above.
export { applyPose, clonePose, createScene, createWantedScene, lookToward, playOver, poseAt, PLAY_LENGTH };
