import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.pure";
// The decoder alone (the package root also pulls in the encoder and simplifier wasm, +140 KB). The file has no
// typings of its own, so it is typed from the package root's.
// @ts-expect-error TS7016: no declaration file for the decoder module.
import { MeshoptDecoder as meshoptDecoder } from "../../node_modules/meshoptimizer/meshopt_decoder.mjs";
import type { MeshoptDecoder as MeshoptDecoderType } from "meshoptimizer";
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
type RobotModel = "default" | "wanted" | BotName;
/** Meshy GLB bots, baked by scripts/bake-bots.ts into media/bots/ and skinned to the procedural robot's rig. */
type BotName = "jocy" | "ally" | "vally" | "meshy" | "buddy" | "jarvis";
const MeshoptDecoder = meshoptDecoder as typeof MeshoptDecoderType;
const BOT_NAMES: BotName[] = ["jocy", "ally", "vally", "meshy", "buddy", "jarvis"];
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
  /** Some GLB bots have a pearl rather than blue antenna lens in their source design. */
  antennaBlueBall?: Color3;
  /** The face rig's preset wiring (for previews; drawing applies it in setFace). */
  faceWire?: Partial<Record<Expression, Expression>>;
  /** Hero only: how far it can fly inside the frame (heroRoom). */
  room?: FlightRoom;
  /** On legs, hovering or both (default "walk"). */
  locomotion?: Locomotion;
  /** The hero's contact shadow: it stays on the floor and fades as the bot lifts off. */
  shadow?: Mesh;
  /** Per-arm cap on `raise` (rad) for bots whose rest pose already lifts an arm (Vally rests mid-wave). */
  raiseMax?: [number, number];
  /** Sculpted bots may need a shorter angular range so actions do not fold limbs through the torso. */
  armMotionScale?: number;
  headBody: TransformNode;
  coil: Mesh;
  coilLength: number;
  headRest: number;
  setFace(face: Face): void;
  /** Head-only portrait for avatars; without it, meshes outside the head are disabled. */
  portrait?(): void;
};

/** "wide": surprise (bigger, with a catch-light); "squint": laughing > <; "sleepy": heavy half lids. */
type Eyes = "open" | "happy" | "focus" | "sad" | "wide" | "squint" | "sleepy" | "heart" | "angry" | "cross";
/** "laugh": open D that opens with `open`; "smirk": one-sided smile; "o" also opens with `open` (gasp, yawn). */
type Mouth = "smile" | "grin" | "talk" | "o" | "flat" | "frown" | "dots" | "laugh" | "smirk" | "wavy";
/**
 * Screen face. `lid` is eye openness (1 open → 0.1 shut; blinks run through it), `scale` the eye size, `lookX/Y`
 * the gaze (−1..1, +Y looks down), `open`/`width` the mouth's opening and width (talk syllables, grin bounce).
 */
type Face = {
  eyes: Eyes; lid: number; scale: number; lookX: number; lookY: number; mouth: Mouth; open: number; width: number; tone: "blue" | "red";
  /** Avatar rendering: bigger eyes, thicker strokes and a stronger glow so the face reads at 22–30 px. */
  bold?: boolean;
  /** Wink: the eye on the viewer's left (−1) or right (+1) closes to a happy arc, whatever `eyes` is. */
  wink?: -1 | 1;
  /** Eye squash and stretch (1 = rest, > 1 taller): set by the motion layer from the body's bounce and landings. */
  squash?: number;
  /** The preset this face plays (see EXPRESSIONS); a bot's FaceRig.wire can swap it for another at draw time. */
  expression?: Expression;
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
  /** Height of the whole bot off the floor (flying); legs come along, the contact shadow stays and fades. */
  lift: number;
  /** Depth offset of the whole bot (+ toward the viewer), for flight paths that swoop in and out. */
  z: number;
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

/** Eye drawing style: solid ovals, glowing rings with a catch-light, small round dots, or angular slits (Iron Man). */
type EyeStyle = "oval" | "ring" | "dot" | "slit";
/**
 * A face rig: where each feature layer sits on a bot's screen (0..1 across from the viewer's left, 0..1 down) and how
 * it is drawn. The screen itself is blank glass; the eyes and the mouth are separate layers drawn on these anchors,
 * so a bot only needs a head with a visor, and every expression preset plays on it.
 */
type FaceRig = {
  eyes: { left: [number, number]; right: [number, number]; size: number; style: EyeStyle; aspect?: number };
  mouth: { at: [number, number]; scale: number };
  palette: { eyes: typeof FACE_COLOR; mouth?: typeof FACE_COLOR.blue };
  /** Glow spread (1 = default): big features (Meshy) need a tighter halo, or it greys the whole screen. */
  glow?: number;
  /** Personality: re-wire presets for this bot, e.g. { happy: "love" } shows heart eyes wherever "happy" plays. */
  wire?: Partial<Record<Expression, Expression>>;
  /**
   * A faceplate rather than a screen (Jarvis): no glass and no mouth. The painted mask stays visible, dark sockets
   * cover the painted eyes, and only the live eyes glow on them.
   */
  mask?: boolean;
  /** The visor's facing yaw when its mean normal misleads (Jarvis's sculpted faceplate averages out to ~0). */
  faceYaw?: number;
};
/** Measured from target/3d-robot-head.png (the procedural robot). */
const DEFAULT_FACE_RIG: FaceRig = { eyes: { left: [0.252, 0.466], right: [0.748, 0.466], size: 0.118, style: "oval" }, mouth: { at: [0.5, 0.8], scale: 1 }, palette: { eyes: FACE_COLOR } };

/**
 * Expression presets: the eye and mouth shapes (and tone) for each emotion or action. States and acts tag their face
 * with one (`express`) and add motion on top (gaze, lids, talking, bounce); a bot's rig can re-wire any preset, and
 * hosts can force one with `data-robot-face="love"` on the canvas.
 */
const EXPRESSIONS = {
  neutral: { eyes: "open", mouth: "smile" },
  happy: { eyes: "happy", mouth: "smile" },
  joy: { eyes: "happy", mouth: "grin" },
  laugh: { eyes: "squint", mouth: "laugh" },
  love: { eyes: "heart", mouth: "grin" },
  surprised: { eyes: "wide", mouth: "o" },
  curious: { eyes: "wide", mouth: "o" },
  thinking: { eyes: "open", mouth: "dots" },
  focused: { eyes: "focus", mouth: "flat" },
  listening: { eyes: "open", mouth: "smile" },
  talking: { eyes: "open", mouth: "talk" },
  sleepy: { eyes: "sleepy", mouth: "flat" },
  yawn: { eyes: "sleepy", mouth: "o" },
  wink: { eyes: "open", mouth: "smirk", wink: 1 },
  smug: { eyes: "sleepy", mouth: "smirk" },
  shy: { eyes: "happy", mouth: "flat" },
  confused: { eyes: "open", mouth: "wavy" },
  sad: { eyes: "sad", mouth: "frown" },
  angry: { eyes: "angry", mouth: "frown" },
  dizzy: { eyes: "cross", mouth: "wavy" },
  error: { eyes: "sad", mouth: "frown", tone: "red" },
} satisfies Record<string, Pick<Face, "eyes" | "mouth"> & Partial<Pick<Face, "wink" | "tone">>>;
type Expression = keyof typeof EXPRESSIONS;
/** Apply a preset's shapes to a face (its gaze, lids and mouth opening are left to the state's motion). */
function express(face: Face, name: Expression) {
  const preset: Partial<Face> = EXPRESSIONS[name];
  face.eyes = preset.eyes!;
  face.mouth = preset.mouth!;
  face.wink = preset.wink;
  face.tone = preset.tone ?? face.tone;
  face.expression = name;
  return face;
}

/**
 * Draw a face in screen-relative units (0..1 across, 0..1 down) as two layers on the rig's anchors: eyes, then
 * mouth. Every expression keeps its proportions so it still reads at 24 px.
 */
function drawFace(ctx: CanvasRenderingContext2D, w: number, h: number, face: Face, glow: boolean, rig = DEFAULT_FACE_RIG) {
  const colors = rig.palette.eyes[face.tone];
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Glow passes: a wide soft halo first, then tighter brighter ones, then the crisp shape.
  const bold = face.bold ? 1.4 : 1;
  const passes: Array<[number, string]> = glow ? [[0.15 * bold, colors.glow[0]], [0.07 * bold, colors.glow[1]], [0.03 * bold, colors.glow[2]], [0, "transparent"]] : [[0, "transparent"]];
  for (const [passIndex, [blur, color]] of passes.entries()) {
    ctx.shadowColor = color;
    ctx.shadowBlur = h * blur * (rig.glow ?? 1);
    drawEyes(ctx, w, h, face, glow, rig, colors, bold);
    if (rig.mask) continue;
    // A separate mouth colour applies to the normal (blue) tone; on error the whole face turns red.
    const mouth = face.tone === "blue" ? rig.palette.mouth : undefined;
    ctx.shadowColor = mouth?.glow[Math.min(passIndex, 2)] ?? color;
    drawMouth(ctx, w, h, face, rig, mouth?.ink ?? colors.ink, bold);
  }
  ctx.restore();
}

/** Eye layer: one shape per eye anchor, following the gaze, lids, wink and squash. */
function drawEyes(ctx: CanvasRenderingContext2D, w: number, h: number, face: Face, glow: boolean, rig: FaceRig, colors: typeof FACE_COLOR.blue, bold: number) {
  ctx.fillStyle = colors.ink;
  ctx.strokeStyle = colors.ink;
  const r = h * rig.eyes.size * (face.bold ? 1.18 : 1) * (rig.eyes.style === "dot" ? 0.75 : 1);
  const dx = face.lookX * w * 0.035;
  const dy = face.lookY * h * 0.05;
  for (const [i, [ax, ay]] of [rig.eyes.left, rig.eyes.right].entries()) {
    const x = ax * w + dx;
    const y = ay * h + dy;
    const outward = i === 0 ? -1 : 1;
    // Turning: the eye on the side the face turns toward recedes (smaller), the other comes forward.
    const turn = face.lookX * 0.14 * outward;
    const size = r * face.scale * (1 - turn);
    // Closing lids squash the eye and widen it a touch, like a soft screen animation.
    const lid = Math.max(0.1, Math.min(1, face.lid));
    const squash = 1 + 0.12 * (1 - lid);
      ctx.beginPath();
    const eyes: Eyes = face.wink !== undefined && (face.wink < 0 ? i === 0 : i === 1) ? "happy" : face.eyes;
    // Squash and stretch keep the eye's area: taller is narrower.
    const sy = face.squash ?? 1, sx = 1 / Math.sqrt(sy);
    if ((eyes === "open" || eyes === "wide") && rig.eyes.style === "ring") {
      // Ring eye: a thick glowing outline (it squashes with the lid like the solid eye) and a small highlight.
      const ring = size * (eyes === "wide" ? 1.18 : 1);
      ctx.lineWidth = ring * 0.36;
      ctx.ellipse(x, y, ring * squash * 0.82 * sx, ring * lid * 0.82 * sy, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (!glow && lid > 0.45) {
      ctx.beginPath();
      ctx.fillStyle = "#FFFFFF";
      ctx.ellipse(x + ring * 0.28, y - ring * 0.28 * lid, ring * 0.16, ring * 0.16 * lid, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors.ink;
      }
      continue;
    }
    if ((eyes === "open" || eyes === "wide") && rig.eyes.style === "slit") {
      // Iron-Man slit: a pointed outer tip, a straight top edge sloping down toward the nose (the stern brow), a
      // blunt inner end and a curved lower edge back to the tip. "wide" opens it taller.
      const k = size * (eyes === "wide" ? 1.15 : 1), o = outward, open = eyes === "wide" ? 1.35 : 1;
      const at = (u: number, v: number): [number, number] => [x + u * k * squash * sx, y + v * k * lid * open * sy];
      ctx.moveTo(...at(o * 1.4, -0.3));
      ctx.lineTo(...at(-o * 1.0, 0.0));
      ctx.lineTo(...at(-o * 1.05, 0.32));
      ctx.quadraticCurveTo(...at(o * 0.55, 0.52), ...at(o * 1.4, -0.3));
      ctx.closePath();
      ctx.fill();
      continue;
    }
    const aspect = rig.eyes.style === "dot" ? 1 : rig.eyes.aspect ?? 1;
    if (eyes === "open") ctx.ellipse(x, y, size * squash * sx, size * lid * aspect * sy, 0, 0, Math.PI * 2);
    else if (eyes === "wide") {
      const big = size * 1.2;
      ctx.ellipse(x, y, big * squash * sx, big * lid * aspect * sy, 0, 0, Math.PI * 2);
      ctx.fill();
      // A catch-light makes the surprise read even on a light eye colour.
      if (!glow && lid > 0.45) {
      ctx.beginPath();
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.ellipse(x + big * 0.3 * sx, y - big * 0.32 * lid * aspect * sy, big * 0.2, big * 0.2 * lid, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors.ink;
      }
      continue;
    }
    else if (eyes === "focus") ctx.ellipse(x, y + size * 0.2, size * 1.05 * squash * sx, size * 0.42 * Math.max(0.3, lid) * sy, 0, 0, Math.PI * 2);
    else if (eyes === "sad") ctx.ellipse(x, y + size * 0.15, size * 0.95 * squash * sx, size * 0.95 * Math.max(0.2, lid) * sy, outward * 0.35, 0, Math.PI);
    else if (eyes === "angry") {
      // Lower half under a lid slanting down toward the nose.
      ctx.ellipse(x, y + size * 0.1, size * squash * sx, size * 0.8 * Math.max(0.25, lid) * aspect * sy, outward * -0.4, 0, Math.PI);
      ctx.closePath();
    }
    else if (eyes === "heart") {
      const k = size * 1.1;
      ctx.moveTo(x, y + k * 0.85 * sy);
      ctx.bezierCurveTo(x - k * 1.25 * sx, y - k * 0.05 * sy, x - k * 0.6 * sx, y - k * 1.05 * sy, x, y - k * 0.35 * sy);
      ctx.bezierCurveTo(x + k * 0.6 * sx, y - k * 1.05 * sy, x + k * 1.25 * sx, y - k * 0.05 * sy, x, y + k * 0.85 * sy);
      ctx.closePath();
    }
    else if (eyes === "sleepy") {
      // Heavy lids: only the lower half shows, under a flat lid line.
      ctx.ellipse(x, y + size * 0.1, size * squash * sx, size * 0.62 * Math.max(0.25, lid) * aspect * sy, 0, 0, Math.PI);
      ctx.closePath();
    }
    if (eyes === "happy") {
      ctx.lineWidth = h * 0.065 * bold;
      ctx.ellipse(x, y + size * 0.45, size * 0.85 * sx, size * 0.85 * sy, 0, Math.PI * 1.12, Math.PI * 1.88);
      ctx.stroke();
    } else if (eyes === "squint") {
      // Laughing > <: each chevron points toward the nose.
      const inward = -outward, r = size * 0.7;
      ctx.lineWidth = h * 0.065 * bold;
      ctx.moveTo(x - inward * r * 0.8, y - r * sy);
      ctx.lineTo(x + inward * r * 0.8, y);
      ctx.lineTo(x - inward * r * 0.8, y + r * sy);
      ctx.stroke();
    } else if (eyes === "cross") {
      // Dizzy or broken: an X.
      const r = size * 0.65;
      ctx.lineWidth = h * 0.06 * bold;
      ctx.moveTo(x - r, y - r * sy); ctx.lineTo(x + r, y + r * sy);
      ctx.moveTo(x + r, y - r * sy); ctx.lineTo(x - r, y + r * sy);
      ctx.stroke();
    } else ctx.fill();
    }
}

/** Mouth layer on its anchor: it follows the gaze a little less than the eyes and narrows as the face turns. */
function drawMouth(ctx: CanvasRenderingContext2D, w: number, h: number, face: Face, rig: FaceRig, ink: string, bold: number) {
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  const { at: [mx, my], scale } = rig.mouth;
  // Scaled mouths keep most of their stroke weight so a small mouth still reads.
  ctx.lineWidth = h * 0.055 * bold * (0.5 + 0.5 * scale) / scale;
  ctx.save();
  ctx.translate(face.lookX * w * 0.028 + (mx - 0.5) * w, face.lookY * h * 0.035 + (my - 0.8) * h);
  ctx.translate(0.5 * w, 0.8 * h);
  ctx.scale((1 - 0.12 * Math.abs(face.lookX)) * scale, (1 - 0.1 * Math.max(0, -face.lookY)) * scale);
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
      ctx.ellipse(0.5 * w, 0.8 * h, w * (0.04 + 0.025 * face.open), h * (0.055 + 0.06 * face.open), 0, 0, Math.PI * 2);
      if (face.open > 0.5) ctx.fill();
      else ctx.stroke();
      break;
    case "laugh":
      // Open D: a flat top lip and a jaw that drops with `open`.
      ctx.moveTo((0.5 - 0.24 * face.width) * w, 0.7 * h);
      ctx.lineTo((0.5 + 0.24 * face.width) * w, 0.7 * h);
      ctx.quadraticCurveTo(0.5 * w, (0.98 + 0.12 * face.open) * h, (0.5 - 0.24 * face.width) * w, 0.7 * h);
      ctx.fill();
      break;
    case "wavy":
      // Unsure: a little zigzag.
      ctx.moveTo(0.4 * w, 0.8 * h);
      for (let k = 1; k <= 4; k++) ctx.lineTo((0.4 + k * 0.05) * w, (0.8 + (k % 2 ? -0.03 : 0.03)) * h);
      ctx.stroke();
      break;
    case "smirk":
      ctx.moveTo((0.5 - 0.13 * face.width) * w, 0.8 * h);
      ctx.quadraticCurveTo((0.5 + 0.05 * face.width) * w, 0.87 * h, (0.5 + 0.17 * face.width) * w, 0.72 * h);
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

/** Quantise the continuous face values so eased motion redraws only when the change is visible on the screen. */
function faceKey(face: Face) {
  const q = (v: number, step: number) => Math.round(v / step) * step;
  return [face.eyes, q(face.lid, 0.1), q(face.scale, 0.05), q(face.lookX, 0.1), q(face.lookY, 0.1), face.mouth,
    q(face.open, 0.125), q(face.width, 0.1), face.tone, face.bold ? "bold" : "", face.wink ?? 0, q(face.squash ?? 1, 0.04)].map(v => (typeof v === "number" ? v.toFixed(2) : v)).join("|");
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
/** Torso and arm joints (root space; +X is the viewer's left), fitted to the front target and the clay turnaround. */
const WANTED_BODY = {
  torso: { width: 2.02, height: 2.12, taper: 0.09, squircle: 2.94, top: 2.43, depth: 1.09 },
  wave: { shoulder: [0.82, 1.98, 0.05], elbow: [1.31, 1.52, 0.37], wrist: [1.445, 1.94, 0.81] },
  rest: { shoulder: [-0.74, 1.94, 0.05], elbow: [-1.075, 1.6, 0.5], wrist: [-1.225, 1.05, 1.1] },
};

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
    edge.addColorStop(0, "rgba(40, 150, 255, 0.6)");
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
  const passes: Array<[number, string]> = glow ? [[0.09, "rgba(40, 200, 255, 1)"], [0.035, "rgba(120, 230, 255, 1)"], [0, "transparent"]] : [[0, "transparent"]];
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
  const mouth: Array<[number, string]> = glow ? [[0.08, "rgba(225, 60, 255, 1)"], [0.035, "rgba(255, 120, 230, 1)"], [0, "transparent"]] : [[0, "transparent"]];
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
  mat.emissiveIntensity = 1.0;
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
function eggTorso(scene: Scene, name: string, width: number, height: number, taper = 0.08, squircle = 2.6) {
  const shape: Vector3[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / 40;
    const s = Math.sin(t);
    const y = Math.sign(s) * Math.abs(s) ** (2 / squircle) * height / 2;
    const radius = Math.abs(Math.cos(t)) ** (2 / squircle) * width / 2 * (1 - taper * (y / (height / 2) + 1) / 2);
    shape.push(new Vector3(radius, y, 0));
  }
  return MeshBuilder.CreateLathe(name, { shape, tessellation: 48 }, scene);
}

type WantedParts = { scene: Scene; shell: PBRMaterial; metal: PBRMaterial; joint: PBRMaterial; dark: PBRMaterial };

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

/** Fan (finger spread, rad), finger curl toward the palm (rad), thumb angle out from the fingers (rad) and thumb curl. */
type WantedHandStyle = { fan: number; curl: number; thumbOut: number; thumbCurl: number };

/** Two-segment finger from `base` along `dir` (in the hand's XY plane), the outer segment bent toward +Z (the palm side). */
function wantedFinger(p: WantedParts, name: string, hand: TransformNode, base: Vector3, dir: Vector3, length: number, radius: number, curl: number) {
  const bend = (angle: number) => dir.scale(Math.cos(angle)).add(new Vector3(0, 0, Math.sin(angle)));
  const knuckle = base.add(bend(curl * 0.35).scale(length * 0.55));
  wantedCapsule(p, `${name}-1`, hand, base, knuckle, radius);
  wantedCapsule(p, `${name}-2`, hand, knuckle, knuckle.add(bend(curl).scale(length * 0.45)), radius, radius * 0.92);
}

/**
 * Soft cartoon hand from the target: a puffy palm with three short, fat fingers fanned along local +Y (the one next to
 * the thumb tilts toward it, the outer one is shortest) and a thumb on the `thumbSide` (±1 local X) edge angled up and
 * out. The palm faces local +Z; curl bends the fingers toward it.
 */
function wantedHand(p: WantedParts, name: string, parent: TransformNode, thumbSide: number, style: WantedHandStyle) {
  const hand = new TransformNode(name, p.scene);
  hand.parent = parent;
  place(roundedBox(p.scene, `${name}-palm`, new Vector3(0.58, 0.5, 0.32), 2.2, 2.2, 32), hand, p.shell);
  const fingers: Array<[number, number, number]> = [[1, 0.25, 1], [0, 0.28, 0], [-1, 0.22, -0.7]];
  for (const [slot, length, tilt] of fingers) {
    const angle = thumbSide * tilt * style.fan;
    const dir = new Vector3(Math.sin(angle), Math.cos(angle), 0);
    wantedFinger(p, `${name}-finger-${slot + 1}`, hand, new Vector3(thumbSide * slot * 0.18, 0.12, 0), dir, length, 0.112, style.curl);
  }
  const thumbDir = new Vector3(thumbSide * Math.sin(style.thumbOut), Math.cos(style.thumbOut), 0.25).normalize();
  wantedFinger(p, `${name}-thumb`, hand, new Vector3(thumbSide * 0.2, -0.06, 0.05), thumbDir, 0.24, 0.112, style.thumbCurl);
  return hand;
}

/**
 * Segmented arm from the parts sheet: shoulder cap with a grey socket ring toward the body, upper arm, grey elbow
 * ring, forearm, grey wrist ring. The forearm and hand hang from an elbow pivot so the hand can wave.
 */
function wantedArm(p: WantedParts, name: string, root: TransformNode, shoulder: Vector3, elbow: Vector3, wrist: Vector3, side: number) {
  // The socket faces the body and sits inside the torso edge, so only a grey seam shows at the shoulder.
  place(MeshBuilder.CreateSphere(`${name}-cap`, { diameter: 0.6, segments: 28 }, p.scene), root, p.shell, shoulder);
  wantedRing(p, `${name}-socket`, root, shoulder.add(new Vector3(-side * 0.24, 0, 0)), new Vector3(1, 0, 0), 0.4, 0.1, p.joint);
  wantedRing(p, `${name}-socket-hole`, root, shoulder.add(new Vector3(-side * 0.29, 0, 0)), new Vector3(1, 0, 0), 0.24, 0.02, p.dark);
  const upper = elbow.subtract(shoulder);
  const upperDir = upper.normalizeToNew();
  wantedCapsule(p, `${name}-upper`, root, shoulder.add(upperDir.scale(0.12)), elbow.subtract(upperDir.scale(0.3)), 0.24, 0.22);
  wantedRing(p, `${name}-elbow-ring`, root, elbow.subtract(upperDir.scale(0.06)), upper, 0.36, 0.16, p.joint);
  const forearm = new TransformNode(`${name}-forearm-pivot`, p.scene);
  forearm.parent = root;
  forearm.position.copyFrom(elbow);
  const wristLocal = wrist.subtract(elbow);
  const foreDir = wristLocal.normalizeToNew();
  // Elbow ball (white) carries the bend, then the forearm widens toward the grey wrist ring.
  place(MeshBuilder.CreateSphere(`${name}-elbow`, { diameter: 0.44, segments: 24 }, p.scene), forearm, p.shell, Vector3.Zero());
  // The forearm runs right up to the hand; the wrist is only a thin crease, as in the target.
  wantedCapsule(p, `${name}-forearm`, forearm, foreDir.scale(0.12), wristLocal.subtract(foreDir.scale(0.02)), 0.22, 0.25);
  wantedRing(p, `${name}-wrist-ring`, forearm, wristLocal.add(foreDir.scale(0.05)), wristLocal, 0.4, 0.05, p.joint);
  return { forearm, wristLocal: wristLocal.add(foreDir.scale(0.08)) };
}

/** Upper-body waving robot built from the parts sheet and posed/measured from target/wanted-robot.png (100 px ≈ 1 unit). */
function buildWantedRobot(scene: Scene): WantedRobot {
  const root = new TransformNode("wanted-robot", scene);
  const p: WantedParts = {
    scene,
    shell: plastic(scene, "wanted-pearl-shell", "#F2F4F8", 0.3),
    metal: plastic(scene, "wanted-metal", "#8E959F", 0.4, 0.35),
    // Arm joints read as soft seams in the target, not metal bands.
    joint: plastic(scene, "wanted-joint", "#BCC3CD", 0.4),
    dark: plastic(scene, "wanted-socket-dark", "#4A5058", 0.6),
  };

  // Head: near-spherical helmet facing a little toward the viewer's left and tipped ~6°, as in the target.
  const head = new TransformNode("wanted-head", scene);
  head.parent = root;
  // The clay side views put the head ~0.2 forward of the torso.
  head.position.set(0.04, WANTED_HEAD.y, 0.2);
  head.rotation.set(0, 0.24, 0.1);
  place(roundedBox(scene, "wanted-head-shell", new Vector3(WANTED_HEAD.width, WANTED_HEAD.height, WANTED_HEAD.depth), WANTED_HEAD.xy, WANTED_HEAD.z, 64), head, p.shell);
  buildWantedVisor(scene, head, p.shell);
  // Ear pods: discs with flat outer faces and a slightly raised inner plate.
  for (const side of [-1, 1]) {
    const pod = place(roundedBox(scene, `wanted-ear-${side}`, new Vector3(1.04, 1.06, 0.3), 2.1, 3.4, 32), head, p.shell, new Vector3(side * 1.26, -0.04, 0.08));
    pod.rotation.y = Math.PI / 2;
    const plate = place(roundedBox(scene, `wanted-ear-plate-${side}`, new Vector3(0.8, 0.82, 0.1), 2.1, 3, 24), head, p.shell, new Vector3(side * 1.42, -0.04, 0.08));
    plate.rotation.y = Math.PI / 2;
  }
  // Antenna: domed collar, thin grey metal stem leaning a little, white ball.
  const collar = place(MeshBuilder.CreateSphere("wanted-antenna-collar", { diameter: 0.56, segments: 24, slice: 0.5 }, scene), head, p.shell, new Vector3(0, 1.08, -0.18));
  collar.scaling.y = 0.55;
  const stemBase = new Vector3(0, 1.2, -0.18);
  const stemTop = new Vector3(-0.04, 1.6, -0.26);
  const stem = place(MeshBuilder.CreateCylinder("wanted-antenna-stem", { diameter: 0.075, height: stemTop.subtract(stemBase).length(), tessellation: 16 }, scene), head, p.metal, Vector3.Lerp(stemBase, stemTop, 0.5));
  stem.rotationQuaternion = alignY(stemTop.subtract(stemBase));
  place(MeshBuilder.CreateSphere("wanted-antenna-tip", { diameter: 0.36, segments: 28 }, scene), head, p.shell, new Vector3(-0.05, 1.75, -0.28));

  // Neck connector: a grey collar and a narrower post that plugs into the torso's grey socket.
  wantedRing(p, "wanted-neck-collar", root, new Vector3(0.02, 2.74, 0.1), Vector3.Up(), 0.78, 0.18);
  wantedRing(p, "wanted-neck-post", root, new Vector3(0.02, 2.6, 0.05), Vector3.Up(), 0.6, 0.18);
  const { torso: t, wave: w, rest: r } = WANTED_BODY;
  const v = (a: number[]) => new Vector3(a[0], a[1], a[2]);
  const torso = place(eggTorso(scene, "wanted-torso", t.width, t.height, t.taper, t.squircle), root, p.shell, new Vector3(0, t.top - t.height / 2, 0));
  torso.scaling.z = t.depth;
  wantedRing(p, "wanted-torso-socket", root, new Vector3(0, t.top - 0.02, 0), Vector3.Up(), 0.98, 0.06);

  // Waving arm (+X, the viewer's left): low elbow, forearm up, open mitten facing the viewer.
  const wave = wantedArm(p, "wanted-wave", root, v(w.shoulder), v(w.elbow), v(w.wrist), 1);
  const waveHand = wantedHand(p, "wanted-wave-hand", wave.forearm, 1, { fan: 0.34, curl: 0.12, thumbOut: 0.78, thumbCurl: 0.1 });
  waveHand.position.copyFrom(wave.wristLocal.add(new Vector3(0.1, 0.26, 0.02)));
  waveHand.rotation.set(0, 0, -0.22);
  waveHand.scaling.setAll(1.2);

  // Resting arm (−X): hangs at the side, mitten pointing down with the thumb toward the body.
  const rest = wantedArm(p, "wanted-rest", root, v(r.shoulder), v(r.elbow), v(r.wrist), -1);
  const restHand = wantedHand(p, "wanted-rest-hand", rest.forearm, 1, { fan: 0.16, curl: 0.3, thumbOut: 0.62, thumbCurl: 0.2 });
  restHand.position.copyFrom(rest.wristLocal.add(new Vector3(-0.02, -0.24, 0.02)));
  // Hanging relaxed with the palm turned toward the body and the thumb in front.
  restHand.rotation.set(0, 2.1, Math.PI + 0.25);
  restHand.scaling.setAll(1.15);

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
  const camera = new ArcRotateCamera("wanted-robot-camera", alpha, beta, avatar ? 7.0 : 12.4, new Vector3(0, avatar ? 4.05 : 2.85, 0), scene);
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
  return ground;
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
  const pose: Pose = { turn: 0, x: 0, lift: 0, z: 0, legs: [{ ...REST_LEG }, { ...REST_LEG }], lean: 0, sway: 0, bob: 0, headPitch: 0, headYaw: 0, headRoll: 0, arms: [{ ...REST_ARM }, { ...REST_ARM }], antenna: 0.15, face };
  const [right, left] = pose.arms; // index 0 is side −1, index 1 is side +1
  switch (state) {
    case "idle": {
      face.expression = "neutral";
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
      face.expression = "listening";
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
      face.expression = "thinking";
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
      face.expression = "focused";
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
      face.expression = "talking";
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
      face.expression = "joy";
      // Wave with the arm on +X, a little bounce, happy eyes and an open grin.
      pose.bob = 0.06 * Math.abs(sin(2));
      pose.headRoll = 0.12 * sin(1);
      left.raise = 2.5;
      left.bend = -0.2;
      left.wave = 0.5 * sin(2);
      left.grip = 0.35;
      right.swing = 0.05;
      face.eyes = "happy";
      // Grin, breaking into a laugh on every other wave.
      face.mouth = sin(1) > 0.35 ? "laugh" : "grin";
      face.open = Math.abs(sin(4));
      face.scale = 1 + 0.08 * Math.abs(sin(2));
      face.width = 1 + 0.08 * Math.abs(sin(2));
      pose.antenna = 1;
      break;
    case "error":
      face.expression = "error";
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
type Springs = {
  dt: number; velocity: Map<string, number>;
  /** Hero only: the face motion layer (faceMotion), applied to a copy of the eased face before it is drawn. */
  face?: (face: Face, pose: Pose, dt: number) => Face;
};

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
  current.z = follow("z", current.z, target.z, 6, 0.75);
  robot.root.position.z = current.z;
  current.lift = follow("lift", current.lift, target.lift, 6, 0.7);
  robot.root.position.y = current.lift;
  if (robot.shadow) {
    // Keep the shadow on the floor under a flying bot, softer and smaller the higher it goes.
    const up = Math.max(0, current.lift);
    robot.shadow.position.y = 0.004 - current.lift;
    robot.shadow.scaling.setAll(1 / (1 + 0.35 * up));
    robot.shadow.visibility = 1 / (1 + 0.9 * up);
  }
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
    const motionScale = robot.armMotionScale ?? 1;
    c.swing = follow(`swing${i}`, c.swing, g.swing * motionScale, 11);
    c.raise = follow(`raise${i}`, c.raise, g.raise * motionScale, 11);
    c.bend = follow(`bend${i}`, c.bend, g.bend * motionScale, 12);
    c.wave = follow(`wave${i}`, c.wave, g.wave * motionScale, 14);
    c.grip = follow(`grip${i}`, c.grip, g.grip, 16, 0.5);
    arm.rotation.set(c.swing, 0, side * Math.min(c.raise, robot.raiseMax?.[i] ?? Infinity));
    forearm.rotation.set(c.bend, 0, c.wave);
    // Opening swings each finger's tip outward about its palm hinge.
    for (const { node, sign } of fingers) node.rotation.z = sign * c.grip;
  });
  robot.antenna.emissiveColor = ANTENNA_GLOW[target.face.tone].scale(current.antenna * 0.9);
  robot.antenna.albedoColor = target.face.tone === "blue" && robot.antennaBlueBall ? robot.antennaBlueBall : ANTENNA_BALL[target.face.tone];
  const kf = Math.min(1, k * 2.2);
  const face = current.face;
  const ease = (a: number, b: number) => a + (b - a) * kf;
  face.eyes = target.face.eyes;
  face.mouth = target.face.mouth;
  face.wink = target.face.wink;
  face.tone = target.face.tone;
  face.lid = target.face.lid;
  face.lookX = ease(face.lookX, target.face.lookX);
  face.lookY = ease(face.lookY, target.face.lookY);
  face.scale = ease(face.scale, target.face.scale);
  face.width = ease(face.width, target.face.width);
  // Discrete mouth counters (the "…" dot index) must not be blended.
  face.open = target.face.mouth === "dots" ? target.face.open : ease(face.open, target.face.open);
  robot.setFace(springs?.face ? springs.face(face, current, springs.dt) : face);
}

/**
 * The face's own motion, on top of the pose's expression (hero only): the eyes lead head turns and nods, stretch as
 * the body rises and squash on landing, blink on a fast head turn, glance about in small saccades while still,
 * and a change of eye shape opens out of a blink (a mouth change squeezes in) instead of popping.
 */
function faceMotion() {
  let last: { yaw: number; pitch: number; bob: number; vBob: number } | undefined;
  const gaze = { x: 0, y: 0 }, glance = { x: 0, y: 0, tx: 0, ty: 0, next: 1.5 };
  const bounce = { pos: 0, vel: 0 };
  let t = 0, blinkAt = -9, eyeSwapAt = -9, mouthSwapAt = -9;
  let lastEyes: Eyes | undefined, lastMouth: Mouth | undefined, lastWink: number | undefined;
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  return (face: Face, pose: Pose, dt: number): Face => {
    if (dt <= 0) return face;
    t += dt;
    const yaw = pose.turn + pose.headYaw, pitch = pose.lean + pose.headPitch;
    const vYaw = last ? (yaw - last.yaw) / dt : 0, vPitch = last ? (pitch - last.pitch) / dt : 0;
    const height = pose.bob + pose.lift;
    const vBob = last ? (height - last.bob) / dt : 0, aBob = last ? (vBob - last.vBob) / dt : 0;
    last = { yaw, pitch, bob: height, vBob };
    // Eyes lead: they look where the head is heading (a turn to +yaw looks toward −x, a nod down looks down).
    const follow = 1 - Math.exp(-dt * 14);
    gaze.x += (clamp(-vYaw * 0.14, 0.4) - gaze.x) * follow;
    gaze.y += (clamp(vPitch * 0.18, 0.3) - gaze.y) * follow;
    // Bounce: an underdamped spring driven by the body's vertical acceleration (rise → stretch, landing → squash).
    const steps = Math.max(1, Math.ceil(dt * 120)), h = dt / steps;
    for (let i = 0; i < steps; i++) {
      bounce.vel += (-12 * 12 * bounce.pos - 2 * 0.35 * 12 * bounce.vel + aBob * 1.4) * h;
      bounce.pos += bounce.vel * h;
    }
    bounce.pos = clamp(bounce.pos, 0.2);
    // Reflex blink on a fast head turn.
    if (Math.abs(vYaw) > 2.2 && t - blinkAt > 0.9) blinkAt = t;
    // Saccades: small glances held for 0.8–2.4 s while the head is still and the eyes are open.
    if (t >= glance.next) {
      const still = Math.abs(vYaw) < 0.3 && face.eyes === "open";
      glance.tx = still ? (Math.random() * 2 - 1) * 0.14 : 0;
      glance.ty = still ? (Math.random() * 2 - 1) * 0.07 : 0;
      glance.next = t + 0.8 + Math.random() * 1.6;
    }
    const snap = 1 - Math.exp(-dt * 30);
    glance.x += (glance.tx - glance.x) * snap;
    glance.y += (glance.ty - glance.y) * snap;
    if (lastEyes !== undefined && (face.eyes !== lastEyes || (face.wink ?? 0) !== lastWink)) eyeSwapAt = t;
    if (lastMouth !== undefined && face.mouth !== lastMouth) mouthSwapAt = t;
    lastEyes = face.eyes; lastMouth = face.mouth; lastWink = face.wink ?? 0;

    const out = { ...face };
    out.lookX = clamp(face.lookX + gaze.x + glance.x, 1);
    out.lookY = clamp(face.lookY + gaze.y + glance.y, 1);
    let squash = 1 + bounce.pos;
    // Blink: lid down and up over 0.16 s.
    const b = (t - blinkAt) / 0.16;
    if (b < 1) out.lid = Math.min(out.lid, 0.1 + 0.9 * (2 * b - 1) ** 2);
    // A new eye shape opens out of a closed lid (and a squashed shape) over 0.14 s.
    const e = (t - eyeSwapAt) / 0.14;
    if (e < 1) { out.lid = Math.min(out.lid, 0.1 + 0.9 * e * e); squash *= 0.55 + 0.45 * e; }
    out.squash = squash;
    // A new mouth shape squeezes in from narrow over 0.12 s.
    const m = (t - mouthSwapAt) / 0.12;
    if (m < 1) out.width *= 0.55 + 0.45 * m;
    return out;
  };
}

function clonePose(pose: Pose): Pose {
  return { ...pose, arms: [{ ...pose.arms[0] }, { ...pose.arms[1] }], legs: [{ ...pose.legs[0] }, { ...pose.legs[1] }], face: { ...pose.face } };
}

/** Scene, camera and studio lights shared by the procedural robot and the GLB bots. */
function createStage(engine: Engine, framing: Framing, fit?: BotFit) {
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
      ? new ArcRotateCamera("robot-camera", Math.PI / 2, fit?.avatarBeta ?? 1.47, fit ? fit.avatarRadius : 5.7 * HEAD.scale, new Vector3(fit?.avatarX ?? 0, fit ? fit.avatarY : HEAD.y + 0.26 * HEAD.scale, fit?.avatarZ ?? 0), scene)
      // Hero framing reproduces the full standing reference.
      : new ArcRotateCamera("robot-camera", Math.PI / 2, 1.42, fit?.heroRadius ?? 18.5, new Vector3(fit?.heroX ?? 0, fit?.heroY ?? BODY.height / 2 - 0.08, 0), scene);
  camera.fov = 0.5;
  // Depth precision is set by the near plane: at hero distance (14+ units) a 0.1 near plane let the painted face
  // z-fight through the live face patch (Jocy's and Meshy's painted rings showed as broken lines).
  camera.minZ = framing === "hero" ? 2 : 0.1;
  // Far plane past the furthest the camera can sit (wide bots frame from far away; Ally once vanished at 43.6 > 40).
  camera.maxZ = Math.max(40, camera.radius + 5.5 + 15);
  if (framing === "hero") {
    camera.panningSensibility = 0;
    camera.wheelPrecision = 60;
    camera.lowerRadiusLimit = camera.radius - 4.5;
    camera.upperRadiusLimit = camera.radius + 5.5;
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

  return { scene, camera };
}

/** Put a built robot on the stage: contact shadow, framing yaw, avatar portrait attitude and the first pose. */
function stageRobot(scene: Scene, robot: Robot, framing: Framing, fit?: BotFit) {
  const avatar = framing === "avatar";
  const headFront = framing === "head-front";
  if (framing === "hero") robot.shadow = contactShadow(scene, robot.root);
  // The reference is a gentle three-quarter view: face turned toward the viewer's left.
  // Avatars nearly face the camera so the expression reads at 24 px.
  robot.baseYaw = headFront ? 0 : avatar ? 0 : BASE.yaw;
  robot.root.rotation.y = robot.baseYaw;
  if (avatar) {
    // Portrait: a slight 3/4 for depth, half-strength head motion so droops and tilts never hide the face,
    // and only the head rendered (shoulders and neck are noise at 22 px).
    // A bot whose visor is modelled turned (Ally, mid-leap) is turned back to face the camera first.
    robot.attitude = { pitch: -0.05, yaw: 0.16 - (fit?.faceYaw ?? 0), roll: -0.04, motion: 0.75 };
    if (robot.portrait) robot.portrait();
    else for (const mesh of robot.root.getChildMeshes(false)) if (!mesh.isDescendantOf(robot.head)) mesh.setEnabled(false);
  }
  const pose = poseAt("idle", 0);
  applyPose(robot, clonePose(pose), pose, 1);
  if (headFront) robot.head.rotation.set(0, 0, 0);
}

function createScene(engine: Engine, framing: Framing) {
  const { scene, camera } = createStage(engine, framing);
  const robot = buildRobot(scene);
  stageRobot(scene, robot, framing);
  return { scene, camera, robot };
}

// ---------- play: idle acts, tap reaction, pointer look (hero only) ----------

type Play = "curious" | "look-around" | "check-hand" | "nod" | "wiggle" | "stretch" | "peek" | "giggle" | "turn-around" | "walk" | "dance" | "fly";
/** How long each act lasts (s). "giggle" is the tap reaction; the rest are picked at random while idle. */
const PLAY_LENGTH: Record<Play, number> = {
  curious: 2.2, "look-around": 3, "check-hand": 2.4, nod: 1.4, wiggle: 1.4, stretch: 2.8, peek: 2, giggle: 1.4,
  "turn-around": 3, walk: 7, dance: 3.2, fly: 5.5
};
const IDLE_PLAYS: Play[] = ["curious", "look-around", "check-hand", "nod", "wiggle", "stretch", "peek", "turn-around", "walk", "dance", "fly"];
/** Idle acts a bot can do: walkers don't fly; fliers swoop instead of strolling. */
function playsFor(mode: Locomotion = "walk"): Play[] {
  return IDLE_PLAYS.filter(play => !(mode === "walk" && play === "fly") && !(mode === "fly" && play === "walk"));
}

/** Seeded random numbers (mulberry32), so a flight's path is fixed once it starts and probes can replay it. */
function seededRandom(seed: number) {
  // Scramble the seed first: consecutive small seeds otherwise give correlated first draws (seeds 1–12 were
  // mostly the same shape).
  let a = Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x85ebca6b) >>> 0;
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FLIGHT_SHAPES = ["wander", "loop", "figure-8", "zigzag"] as const;
type FlightShape = (typeof FLIGHT_SHAPES)[number];
/**
 * A flight path for one `fly` act: offsets [x (+ viewer's left), y (up), z (+ toward the viewer)] over s = 0..1,
 * starting and ending at the bot's spot. The seed picks the shape and its direction, size and waypoints:
 *   wander   — a smooth line through 3–4 random waypoints (Catmull-Rom)
 *   loop     — a loop-the-loop up and over to one side
 *   figure-8 — side to side while swooping in toward the camera and back out
 *   zigzag   — three quick diagonal legs
 * Sizes stay inside the hero frame: fliers already hover, so they get less height and width.
 */
/**
 * How far a bot can travel inside its hero frame (units): sideways from its spot, and up above its standing
 * height. Measured per bot from the camera's view and the bot's extent (heroRoom); the default suits the
 * procedural robot.
 */
type FlightRoom = { side: number; up: number };
const DEFAULT_ROOM: FlightRoom = { side: 0.5, up: 0.65 };

function flightPath(seed: number, grounded: boolean, room: FlightRoom = DEFAULT_ROOM): { shape: FlightShape; at: (s: number) => V3 } {
  const random = seededRandom(seed);
  const shape = FLIGHT_SHAPES[Math.floor(random() * FLIGHT_SHAPES.length)];
  const side = random() < 0.5 ? -1 : 1;
  // Fliers already hover at hoverHeight(room), so they climb from there.
  const W = room.side * (0.75 + 0.25 * random()), H = Math.max(0, room.up - (grounded ? 0 : hoverHeight(room))), D = 0.8;
  // Ease out of and back into the start, so take-off and landing are gentle whatever the shape.
  const ends = (s: number) => smooth(s / 0.18) * (1 - smooth((s - 0.82) / 0.18));
  let curve: (s: number) => V3;
  if (shape === "wander") {
    const n = 3 + Math.floor(random() * 2);
    const points: V3[] = [[0, 0, 0]];
    // Alternate sides so the line actually travels (independent draws often bunched near the start).
    for (let k = 0; k < n; k++) points.push([side * W * (k % 2 ? -1 : 1) * (0.55 + 0.45 * random()), H * (0.4 + 0.6 * random()), D * (2 * random() - 1)]);
    points.push([0, 0, 0]);
    const ext = [points[0], ...points, points[points.length - 1]];
    curve = s => {
      const f = s * (points.length - 1), i = Math.min(points.length - 2, Math.floor(f)), t = f - i;
      const [p0, p1, p2, p3] = [ext[i], ext[i + 1], ext[i + 2], ext[i + 3]];
      return [0, 1, 2].map(c => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t * t + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t * t * t)) as V3;
    };
  } else if (shape === "loop") {
    // Out to one side, up and over in a circle, back.
    curve = s => {
      const a = 2 * Math.PI * smooth((s - 0.2) / 0.6);
      return [side * W * (Math.sin(Math.PI * s) * 0.6 + 0.4 * Math.sin(a)), H * (0.5 * Math.sin(Math.PI * s) + 0.5 * (1 - Math.cos(a)) * 0.9), 0.2 * D * Math.sin(Math.PI * s)];
    };
  } else if (shape === "figure-8") {
    curve = s => [side * W * Math.sin(2 * Math.PI * s), H * 0.6 * Math.sin(Math.PI * s), D * Math.sin(4 * Math.PI * s)];
  } else {
    // Three diagonal legs: out-up, across-down, back-up, home.
    const legs: V3[] = [[0, 0, 0], [side * W, H * 0.8, -0.3 * D], [-side * W * 0.8, H * 0.4, 0.4 * D], [side * W * 0.5, H, 0], [0, 0, 0]];
    curve = s => {
      const f = s * (legs.length - 1), i = Math.min(legs.length - 2, Math.floor(f)), t = smooth(f - i);
      return [0, 1, 2].map(c => legs[i][c] + (legs[i + 1][c] - legs[i][c]) * t) as V3;
    };
  }
  return { shape, at: s => { const e = ends(s), p = curve(Math.min(1, Math.max(0, s))); return [p[0] * e, p[1] * e, p[2] * e]; } };
}

/** Hovering: the whole bot floats and drifts, legs (if any) dangle and swing a beat behind. */
/** A flier's resting hover height: half a unit, less when the frame has little headroom. */
function hoverHeight(room: FlightRoom) {
  return Math.max(0.15, Math.min(0.5, 0.4 * room.up));
}

function hover(pose: Pose, t: number, weight = 1, height = 0.5) {
  const s = Math.sin(2 * Math.PI * t / 2.4);
  pose.lift += height * (1 + 0.2 * s) * weight;
  pose.lean += 0.03 * weight;
  pose.sway += 0.02 * Math.sin(2 * Math.PI * t / 4.8) * weight;
  pose.legs.forEach((leg, i) => {
    leg.hip += -0.15 * weight;
    leg.knee += (0.35 + 0.08 * Math.sin(2 * Math.PI * t / 2.4 + 1.2 + i)) * weight;
    leg.foot += 0.3 * weight;
  });
}

/** The bot's own way of being: fliers hover all the time (avatars stay grounded so the head stays framed). */
function locomote(pose: Pose, mode: Locomotion = "walk", t = 0, room: FlightRoom = DEFAULT_ROOM) {
  if (mode === "fly") hover(pose, t, 1, hoverHeight(room));
}

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
function playOver(pose: Pose, play: Play, u: number, mode: Locomotion = "walk", seed = 1, room: FlightRoom = DEFAULT_ROOM) {
  const env = Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
  // Fliers glide instead of stepping.
  const gait = (phase: number, stride: number, lift: number, weight: number) => { if (mode !== "fly") step(pose, phase, stride, lift, weight); };
  const face = pose.face;
  const [right, left] = pose.arms;
  switch (play) {
    case "curious": // head cocked, eyes big and up, a little "o"
      face.expression = "curious";
      pose.headRoll += 0.35 * env;
      pose.headPitch -= 0.1 * env;
      face.scale = 1 + 0.15 * env;
      face.lookX = 0.5 * env;
      face.lookY = -0.4 * env;
      if (env > 0.3) face.eyes = "wide";
      if (env > 0.5) { face.mouth = "o"; face.open = 0.4 * env; }
      break;
    case "look-around": // head sweeps to one side then the other, eyes leading
      pose.headYaw += 0.7 * Math.sin(2 * Math.PI * u) * env;
      pose.turn += 0.15 * Math.sin(2 * Math.PI * u) * env;
      face.lookX = -0.9 * Math.sin(2 * Math.PI * u + 0.4);
      break;
    case "check-hand": // lifts a hand and inspects it
      // Inspect the fist first, then bring the pointing hand around to compare it. Bots with articulated
      // fingers open and close them below; a fixed sculpted hand keeps its authored gesture while the arm moves.
      {
        const inspectLeft = smooth((u - 0.12) / 0.38);
        const inspectRight = 1 - 0.72 * inspectLeft;
        right.swing += -1.0 * env * inspectRight;
        right.bend += -1.2 * env * inspectRight;
        right.raise += -0.2 * env * inspectRight;
        left.swing += -0.82 * env * inspectLeft;
        left.bend += -0.72 * env * inspectLeft;
        left.raise += -0.14 * env * inspectLeft;
        right.grip += 0.4 * Math.max(0, Math.sin(4 * Math.PI * u)) * env;
        left.grip += 0.35 * Math.max(0, Math.sin(4 * Math.PI * u - Math.PI)) * env;
      }
      pose.headPitch += 0.25 * env;
      pose.headYaw += -0.35 * env;
      face.lookX = 0.6 * env;
      face.lookY = 0.6 * env;
      if (env > 0.6) face.mouth = "o";
      break;
    case "nod":
      pose.headPitch += 0.18 * Math.sin(4 * Math.PI * u) * env;
      face.width = 1.1;
      break;
    case "wiggle": // happy head wiggle, antenna lit
      face.expression = "happy";
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
      // A yawn: heavy lids and a wide-open "o".
      if (env > 0.6) {
        face.expression = "yawn";
        face.eyes = "sleepy";
        face.lid = 0.6;
        face.mouth = "o";
        face.open = (env - 0.6) / 0.4;
      }
      break;
    case "peek": // leans to one side and peers past something
      pose.sway += 0.12 * env;
      pose.headRoll += -0.2 * env;
      pose.headYaw += 0.4 * env;
      face.lookX = -0.9 * env;
      face.scale = 1 + 0.08 * env;
      // Caught peeking: a wink and a smirk on the way back.
      if (u > 0.7 && u < 0.95) { face.wink = 1; face.mouth = "smirk"; face.expression = "wink"; }
      break;
    case "turn-around": { // wind-up, then a full spin in place, stepping round, arms a little out
      // Anticipation: crouch and twist the other way for the first ~15%, then spin.
      const windup = u < 0.15 ? smooth(u / 0.15) : 1 - smooth((u - 0.15) / 0.1);
      pose.turn += -0.3 * windup + 2 * Math.PI * smooth((u - 0.12) / 0.78);
      pose.bob -= 0.08 * windup;
      for (const leg of pose.legs) leg.knee += 0.25 * windup;
      gait(u * 3, 0.16, 0.7, u > 0.2 ? env : 0);
      pose.arms[0].raise += 0.25 * env;
      pose.arms[1].raise += 0.25 * env;
      if (u > 0.3 && u < 0.7) { face.eyes = "happy"; face.expression = "happy"; }
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
      if (walking) gait(walkPhase, 0.32, 0.75, 1);
      if (walking && mode === "fly") { pose.lean += 0.15; pose.lift += 0.2 * Math.sin(Math.PI * (walkPhase % 1)); }
      face.lookX = turn > 0.3 ? -0.6 : turn < -0.3 ? 0.6 : face.lookX;
      face.width = 1.1;
      break;
    }
    case "dance": { // march in place, pumping arms, bobbing head, swaying the hips
      face.expression = "laugh";
      const beat = u * 4;
      gait(beat, 0.1, 1.0, env);
      if (mode === "fly") pose.lift += 0.15 * Math.abs(Math.sin(2 * Math.PI * beat)) * env;
      pose.arms.forEach((arm, i) => {
        const pump = Math.sin(2 * Math.PI * (beat + i * 0.5));
        arm.swing += (-0.7 + 0.5 * pump) * env;
        arm.bend += -1.1 * env;
        arm.raise += 0.15 * env;
      });
      pose.turn += 0.3 * Math.sin(Math.PI * beat) * env;
      pose.headRoll += 0.15 * Math.sin(2 * Math.PI * beat) * env;
      face.eyes = "happy";
      // Laughing along, winking on alternate beats.
      face.mouth = "laugh";
      face.open = Math.abs(Math.sin(2 * Math.PI * beat));
      const half = beat % 1;
      if (half > 0.35 && half < 0.6) face.wink = Math.floor(beat) % 2 ? 1 : -1;
      pose.antenna = Math.max(pose.antenna, 0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * beat)));
      break;
    }
    case "fly": { // take off, fly a random path (seeded), land; fliers are already airborne and just fly it
      const grounded = mode !== "fly";
      const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
      // Anticipation and landing: a crouch before take-off and a squash on touchdown.
      const crouch = grounded ? Math.max(Math.sin(Math.PI * clamp01(u / 0.1)), Math.sin(Math.PI * clamp01((u - 0.9) / 0.1))) : 0;
      pose.bob -= 0.1 * crouch;
      for (const leg of pose.legs) leg.knee += 0.35 * crouch;
      const up = grounded ? smooth((u - 0.08) / 0.1) * (1 - smooth((u - 0.82) / 0.1)) : 1;
      if (grounded) hover(pose, u * PLAY_LENGTH.fly, up, hoverHeight(room));
      const flight = flightPath(seed, grounded, room);
      const s = clamp01((u - 0.12) / 0.76), e = 0.004;
      const p = flight.at(s), q0 = flight.at(s - e), q1 = flight.at(s + e);
      const v = [0, 1, 2].map(c => (q1[c] - q0[c]) / (2 * e)), acc = [0, 1, 2].map(c => (q1[c] - 2 * p[c] + q0[c]) / (e * e));
      pose.x += p[0] * up;
      pose.lift += p[1] * up;
      pose.z += p[2] * up;
      // Face the way it flies (sideways travel turns the body; flying at the camera or away doesn't), bank into the
      // curve's sideways acceleration, lean back while climbing and forward while diving.
      const speed = Math.hypot(v[0], v[1], v[2]) || 1;
      pose.turn += 0.75 * (v[0] / speed) * Math.min(1, speed / 1.5) * up;
      pose.sway += Math.max(-0.3, Math.min(0.3, -0.012 * acc[0])) * up;
      pose.lean += (0.12 - Math.max(-0.12, Math.min(0.12, 0.06 * v[1]))) * up;
      for (const arm of pose.arms) { arm.raise += 0.6 * up; arm.bend += -0.25 * up; }
      pose.antenna = Math.max(pose.antenna, up);
      express(face, up < 0.5 ? "surprised" : flight.shape === "loop" && s > 0.3 && s < 0.7 ? "laugh" : "joy");
      if (face.mouth === "laugh") face.open = 0.6;
      face.lookX = -0.6 * (v[0] / speed) * up;
      face.lookY = -0.3 * (v[1] / speed) * up;
      break;
    }
    case "giggle": // tap reaction: bounce, wiggle, ^^ and a grin
      face.expression = "laugh";
      pose.bob += 0.08 * Math.abs(Math.sin(4 * Math.PI * u)) * env;
      pose.headRoll += 0.2 * Math.sin(6 * Math.PI * u) * env;
      face.eyes = "squint";
      face.mouth = "laugh";
      face.open = Math.abs(Math.sin(4 * Math.PI * u));
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
    const vy = prev ? (pose.bob + pose.lift - prev.y) / dt : 0;
    const aPitch = prev ? (vPitch - prev.vPitch) / dt : 0;
    const aRoll = prev ? (vRoll - prev.vRoll) / dt : 0;
    const aYaw = prev ? (vYaw - prev.vYaw) / dt : 0;
    const ax = prev ? (vx - prev.vx) / dt : 0;
    const ay = prev ? (vy - prev.vy) / dt : 0;
    state.last = { pitch, roll, yaw, x: pose.x, y: pose.bob + pose.lift, vPitch, vRoll, vYaw, vx, vy };
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

// ---------- GLB bots (baked by scripts/bake-bots.ts, skinned to the procedural rig) ----------

type V3 = [number, number, number];
type BotHeader = {
  name: string; version: number; height: number; bones: string[]; vertexCount: number; indexCount: number; index32: boolean;
  /** Version 2: interleaved vertex stride and the meshopt-compressed stream lengths. */
  stride: number; vertexBytes: number; indexBytes: number;
  position: { min: number[]; max: number[] }; uv: { min: number[]; max: number[] };
  rig: {
    hip: V3; neck: V3; antenna: V3; antennaBall: { at: V3; radius: number };
    shoulder: [V3, V3]; elbow: [V3, V3]; wrist: [V3, V3]; hipJoint: [V3, V3]; knee: [V3, V3]; ankle: [V3, V3];
  };
  /** Visor rectangle on the head's front, in baked units. */
  face: { centre: [number, number]; width: number; height: number; squircle: number; inset: number; outline?: number[]; rim?: number[] };
  textures: Partial<Record<"color" | "mr" | "normal" | "emissive", string>>;
  emissive: number[] | null;
};
type BotAsset = {
  header: BotHeader; base: string;
  positions: Float32Array; normals: Float32Array; uvs: Float32Array; joints: Float32Array; weights: Float32Array; indices: Uint16Array | Uint32Array;
};
/** Hero and avatar camera distances for a bot (its proportions differ from the procedural robot's). */
type BotFit = {
  heroRadius: number; avatarRadius: number; avatarY: number;
  /** Hero aim height: the middle of the framed envelope (floor to raised hands or flight ceiling). */
  heroY?: number;
  heroX?: number;
  /** Portrait aim point off the body's centre line (Ally's head sits to the side) and the visor's facing yaw. */
  avatarX?: number; avatarZ?: number; faceYaw?: number;
  /** Portrait camera elevation (ArcRotate beta): lower for a visor that faces down (Jarvis's tucked chin). */
  avatarBeta?: number;
};

/** The live face drawn over each bot's visor, lined up with its painted eyes and mouth. */
const BOT_FACES: Record<BotName, FaceRig> = {
  jocy: {
    eyes: { left: [0.262, 0.39], right: [0.738, 0.39], size: 0.2, style: "ring" }, mouth: { at: [0.5, 0.84], scale: 0.4 },
    palette: { eyes: { blue: { ink: "#8CEEFF", glow: ["rgba(30, 190, 255, 1)", "rgba(80, 215, 255, 1)", "rgba(170, 240, 255, 1)"] }, red: FACE_COLOR.red } },
    wire: { surprised: "love" },
  },
  ally: {
    eyes: { left: [0.332, 0.42], right: [0.74, 0.42], size: 0.169, style: "ring" }, mouth: { at: [0.536, 0.696], scale: 0.355 },
    palette: { eyes: { blue: { ink: "#7DF3F0", glow: ["rgba(20, 210, 220, 1)", "rgba(70, 230, 235, 1)", "rgba(160, 245, 245, 1)"] }, red: FACE_COLOR.red } },
    wire: { joy: "laugh" },
  },
  vally: {
    eyes: { left: [0.3, 0.43], right: [0.7, 0.43], size: 0.08, style: "oval", aspect: 1.3 }, mouth: { at: [0.5, 0.7], scale: 0.7 },
    palette: {
      eyes: { blue: { ink: "#7DE6F2", glow: ["rgba(30, 170, 230, 1)", "rgba(60, 195, 240, 1)", "rgba(100, 215, 245, 1)"] }, red: FACE_COLOR.red },
      mouth: { ink: "#F25AE6", glow: ["rgba(235, 60, 225, 1)", "rgba(240, 90, 230, 1)", "rgba(245, 130, 235, 1)"] },
    },
    wire: { happy: "love" },
  },
  meshy: {
    // Measured from the painted face (base colour sampled across the screen): solid round eyes at 22% / 78% across
    // and 53% down, a thin smile from 18% to 82% wide sitting 81–92% down; soft white with a cool glow.
    eyes: { left: [0.22, 0.53], right: [0.78, 0.53], size: 0.14, style: "oval" }, mouth: { at: [0.5, 0.9], scale: 1.3 }, glow: 0.4,
    palette: { eyes: { blue: { ink: "#EEF8FF", glow: ["rgba(90, 170, 255, 1)", "rgba(150, 205, 255, 1)", "rgba(215, 238, 255, 1)"] }, red: FACE_COLOR.red } },
    wire: { thinking: "confused" },
  },
  buddy: {
    eyes: { left: [0.31, 0.45], right: [0.69, 0.45], size: 0.13, style: "oval", aspect: 1.35 },
    mouth: { at: [0.5, 0.79], scale: 0.78 },
    palette: { eyes: { blue: { ink: "#68F4E8", glow: ["rgba(0, 205, 190, 1)", "rgba(40, 225, 210, 1)", "rgba(125, 250, 235, 1)"] }, red: FACE_COLOR.red } },
    wire: { happy: "joy" },
  },
  jarvis: {
    // Iron-Man faceplate: slit eyes on the painted cyan slits (vertex colour samples: 19% / 81% across, mid-height),
    // no mouth; arc-reactor cyan.
    // Reference: white-hot slits in a cyan-blue halo.
    eyes: { left: [0.21, 0.43], right: [0.78, 0.45], size: 0.3, style: "slit" }, mouth: { at: [0.5, 0.8], scale: 1 }, glow: 0.8,
    palette: { eyes: { blue: { ink: "#F4FFFF", glow: ["rgba(30, 150, 255, 1)", "rgba(80, 200, 255, 1)", "rgba(185, 240, 255, 1)"] }, red: FACE_COLOR.red } },
    mask: true,
    // Measured from the two painted eye slits (the helmet looks toward the pointing hand).
    faceYaw: 0.44,
  },
};

/** How a bot gets around: on its legs, hovering (Vally has none), or both (Ally walks, takes off and lands). */
type Locomotion = "walk" | "fly" | "both";
const BOT_LOCOMOTION: Record<BotName, Locomotion> = { jocy: "walk", ally: "both", vally: "fly", meshy: "walk", buddy: "walk", jarvis: "both" };

/** media/bots/ next to the extension; resolved from this script's own URL (dist/webview/robot-runtime.js). */
const BOTS_BASE = (() => {
  try {
    const src = (document.currentScript as HTMLScriptElement | null)?.src;
    return src ? new URL("../../media/bots/", src).href : undefined;
  } catch {
    return undefined;
  }
})();

/** The host's choice (agentOrchestrator.robotModel), from `data-robot-model` on this script tag; used when a call names none. */
const HOST_MODEL: RobotModel = (() => {
  const asked = (document.currentScript as HTMLScriptElement | null)?.dataset.robotModel;
  return asked && (asked === "wanted" || BOT_NAMES.includes(asked as BotName)) ? asked as RobotModel : "default";
})();

/** Explicit asWebviewUri mappings supplied by the extension host; the URL-relative path remains a preview fallback. */
const ROBOT_ASSET_URLS: Record<string, string> = (() => {
  try {
    const raw = (document.currentScript as HTMLScriptElement | null)?.dataset.robotAssets;
    return raw ? JSON.parse(raw) as Record<string, string> : {};
  } catch {
    return {};
  }
})();

function robotAssetUrl(file: string, base: string) {
  return ROBOT_ASSET_URLS[file] ?? new URL(file, new URL(base, location.href)).href;
}

const botAssets = new Map<BotName, Promise<BotAsset>>();
function loadBotAsset(name: BotName): Promise<BotAsset> {
  let asset = botAssets.get(name);
  if (!asset) {
    asset = (async () => {
      const base = (window as { AgentRobot3DBotsBase?: string }).AgentRobot3DBotsBase ?? BOTS_BASE ?? "media/bots/";
      const response = await fetch(robotAssetUrl(`${name}.bin`, base));
      if (!response.ok) throw new Error(`bot ${name}: ${response.status}`);
      const buffer = await response.arrayBuffer();
      const view = new DataView(buffer);
      const headerLength = view.getUint32(0, true);
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))) as BotHeader;
      if (header.version !== 2) throw new Error(`bot ${name}: unsupported .bin version ${header.version}; re-run scripts/bake-bots.ts`);
      const n = header.vertexCount;
      // Version 2: meshopt-compressed interleaved vertices (see scripts/bake-bots.ts) and indices.
      await MeshoptDecoder.ready;
      const at = (4 + headerLength + 3) & ~3;
      const vertexData = new Uint8Array(n * header.stride);
      MeshoptDecoder.decodeVertexBuffer(vertexData, n, header.stride, new Uint8Array(buffer, at, header.vertexBytes));
      const indexData = new Uint32Array(header.indexCount);
      MeshoptDecoder.decodeIndexBuffer(new Uint8Array(indexData.buffer), header.indexCount, 4, new Uint8Array(buffer, (at + header.vertexBytes + 3) & ~3, header.indexBytes));
      const indices = header.index32 ? indexData : Uint16Array.from(indexData);
      const v = new DataView(vertexData.buffer);
      const qPos = new Uint16Array(n * 3), qNrm = new Int8Array(n * 4), qUv = new Uint16Array(n * 2), qJoints = new Uint8Array(n * 4), qWeights = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const o = i * header.stride;
        for (let c = 0; c < 3; c++) qPos[3 * i + c] = v.getUint16(o + 2 * c, true);
        for (let c = 0; c < 3; c++) qNrm[4 * i + c] = v.getInt8(o + 6 + c);
        for (let c = 0; c < 2; c++) qUv[2 * i + c] = v.getUint16(o + 10 + 2 * c, true);
        for (let c = 0; c < 3; c++) { qJoints[4 * i + c] = vertexData[o + 14 + c]; qWeights[4 * i + c] = vertexData[o + 17 + c]; }
      }
      const { min, max } = header.position;
      const positions = new Float32Array(n * 3);
      for (let i = 0; i < n * 3; i++) positions[i] = min[i % 3] + (qPos[i] / 65535) * (max[i % 3] - min[i % 3]);
      const normals = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) normals[3 * i + c] = qNrm[4 * i + c] / 127;
      const uvs = new Float32Array(n * 2);
      for (let i = 0; i < n * 2; i++) uvs[i] = header.uv.min[i % 2] + (qUv[i] / 65535) * (header.uv.max[i % 2] - header.uv.min[i % 2]);
      const joints = Float32Array.from(qJoints);
      const weights = new Float32Array(n * 4);
      for (let i = 0; i < n * 4; i++) weights[i] = qWeights[i] / 255;
      return { header, base: new URL(base, location.href).href, positions, normals, uvs, joints, weights, indices };
    })();
    botAssets.set(name, asset);
    // A failed load can be retried by a later mount.
    asset.catch(() => botAssets.delete(name));
  }
  return asset;
}

/** The chat window's hero canvas is 170×300 (narrow layouts keep the shape). */
const HERO_ASPECT = 220 / 340;
/** Room a bot that flies should have in its hero frame (units): sideways travel and climb above standing height. */
const FLY_ROOM: Record<Locomotion, FlightRoom> = { walk: { side: 0, up: 0 }, fly: { side: 0.35, up: 0.9 }, both: { side: 0.45, up: 1.1 } };

/**
 * Hero framing: the camera distance and aim that keep everything the bot does inside the 170×300 canvas: its body
 * turned any way (radius around its axis), its hands at full reach (raised in a wave or stretch, swung in a dance:
 * shoulder + arm length), the floor, and for fliers their flight room on top. Measured on the chat-size canvas by
 * `probe.ts <bot> --fit`.
 */
function heroFrame({ header, positions, joints }: BotAsset, mode: Locomotion): { radius: number; x: number; y: number } {
  // Jarvis's arm points out level, so turns and banked flights swing its whole length past the 85% turn allowance.
  const MARGIN = header.name === "jarvis" ? 0.75 : 0.35;
  const rig = header.rig;
  const armBones = ["arm-1", "forearm-1", "arm+1", "forearm+1"].map(b => header.bones.indexOf(b));
  // Per side (index 0 = −X, viewer's right; 1 = +X, viewer's left): how far the body and the arm reach.
  const body = [0, 0], arm = [0, 0];
  let reach = 0, top = 0;
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    reach = Math.max(reach, Math.hypot(x, z));
    top = Math.max(top, y);
    body[x < 0 ? 0 : 1] = Math.max(body[x < 0 ? 0 : 1], Math.abs(x));
    const k = armBones.indexOf(joints[4 * i]);
    if (k >= 0) {
      const sh = rig.shoulder[k < 2 ? 0 : 1];
      arm[k < 2 ? 0 : 1] = Math.max(arm[k < 2 ? 0 : 1], Math.hypot(x - sh[0], y - sh[1], z - sh[2]));
    }
  }
  // Sideways, a stretch swings the hands out at full length (95% still touched the edge); upward about 75%.
  // Turns swing depth into width, but the big turns (spin, walk) pass quickly: most of the turned radius covers them.
  const extent = [0, 1].map(s => Math.max(body[s], 0.85 * reach, Math.abs(rig.shoulder[s][0]) + arm[s]));
  const room = FLY_ROOM[mode];
  const halfWidth = (extent[0] + extent[1]) / 2 + room.side + MARGIN;
  const shoulderY = Math.max(rig.shoulder[0][1], rig.shoulder[1][1]);
  const ceiling = Math.max(top, shoulderY + 0.75 * Math.max(arm[0], arm[1])) + room.up + MARGIN, floor = -0.25;
  const halfHeight = Math.max((ceiling - floor) / 2, halfWidth / HERO_ASPECT);
  // Aim at the middle of the bot's own left-right extent (Ally's leaping body sits off the centre line).
  return { radius: halfHeight / Math.tan(0.25), x: (extent[1] - extent[0]) / 2, y: (ceiling + floor) / 2 };
}

function botFit({ header, positions, normals, joints }: BotAsset): BotFit {
  const head = header.bones.indexOf("head");
  const antenna = header.bones.indexOf("antenna");
  const { centre: [fx, fy], width: fw, height: fh } = header.face;
  const headPoints: number[] = [];
  let width = 0, headTop = 0, antennaTop = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    width = Math.max(width, Math.abs(x) * 2);
    if (joints[4 * i] === head) {
      headTop = Math.max(headTop, y);
      headPoints.push(x, z);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      // The visor's facing: mean normal of the head's front faces inside the face rectangle.
      if (Math.abs(x - fx) < fw / 2 && Math.abs(y - fy) < fh / 2 && normals[3 * i + 2] > 0.25) { nx += normals[3 * i]; ny += normals[3 * i + 1]; nz += normals[3 * i + 2]; }
    }
    if (joints[4 * i] === antenna) antennaTop = Math.max(antennaTop, y);
  }
  const neckY = header.rig.neck[1];
  const top = Math.max(headTop, headTop + 0.4 * (antennaTop - headTop));
  // Portrait: head (+ part of the antenna) fills ~84% of the square, measured on the head's own extent (not its
  // distance from the body's centre line); hero: the whole bot fits a 0.56-aspect canvas.
  const faceYaw = BOT_FACES[header.name as BotName]?.faceYaw ?? Math.atan2(nx, nz);
  // A visor tilted down past ~9° gets a camera from below by the excess, so the portrait looks into the face.
  const facePitch = Math.atan2(-ny, Math.hypot(nx, nz));
  // Width as the camera sees it once the portrait turns the head by faceYaw.
  let u0 = Infinity, u1 = -Infinity;
  for (let k = 0; k < headPoints.length; k += 2) {
    const u = headPoints[k] * Math.cos(faceYaw) - headPoints[k + 1] * Math.sin(faceYaw);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u);
  }
  const size = Math.max(top - neckY, u1 - u0) / 0.84;
  return {
    heroRadius: Math.max(18.5, (width + 0.8) / 0.56 / (2 * Math.tan(0.25))),
    avatarRadius: size / (2 * Math.tan(0.25)),
    avatarY: (top + neckY) / 2,
    avatarX: (x0 + x1) / 2,
    avatarZ: (z0 + z1) / 2,
    faceYaw,
    avatarBeta: 1.47 + Math.max(0, facePitch - 0.15),
  };
}

/** Screen patch cut from the bot's own visor triangles, showing the live face (cached glow layers, like the visor). */
function buildBotFace(scene: Scene, asset: BotAsset, rig: FaceRig, parent: TransformNode) {
  const { header, positions, normals, joints, weights, indices } = asset;
  const { centre: [cx, cy], width, height, squircle: k } = header.face;
  const head = header.bones.indexOf("head");
  // Vally's visor sits in a sculpted recess: cut the patch past the rim and draw the visor outline in the texture,
  // so the edge is a smooth curve rather than the decimated triangles' sawtooth.
  const pad = header.name === "vally" ? 1.18 : 1;
  const reach = pad > 1 ? pad : 1.04;
  // Mostly head (smooth skinning leaves small neck or antenna tails; the patch itself rides the head node), facing
  // the viewer at all: a curved, turned visor (Ally) has its painted eye where the surface already turns away.
  // Painted features modelled as raised ridges (Jocy's ring eyes) have walls facing sideways; leaving them out cut
  // ring-shaped holes the paint showed through, so only surfaces facing away are excluded.
  const front = (i: number) => joints[4 * i] === head && weights[4 * i] > 0.9 && normals[3 * i + 2] > (header.face.outline ? 0.05 : -0.4);
  // A triangle is in when its centre is inside the visor shape: a flat screen made of a few large triangles (Meshy)
  // has corners out on the bezel, and an all-corners test left holes. The texture is clear outside the shape.
  const inside = (a: number, b: number, c: number) => {
    const u = Math.abs((positions[3 * a] + positions[3 * b] + positions[3 * c]) / 3 - cx) / (width / 2 * reach);
    const v = Math.abs((positions[3 * a + 1] + positions[3 * b + 1] + positions[3 * c + 1]) / 3 - cy) / (height / 2 * reach);
    return front(a) && front(b) && front(c) && (header.face.outline ? u < 1 && v < 1 : u ** k + v ** k < 1);
  };
  const remap = new Map<number, number>();
  const patchPositions: number[] = [], patchUvs: number[] = [], patchNormals: number[] = [], patchIndices: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    if (!inside(indices[t], indices[t + 1], indices[t + 2])) continue;
    for (let c = 0; c < 3; c++) {
      const i = indices[t + c];
      let j = remap.get(i);
      if (j === undefined) {
        j = remap.size;
        remap.set(i, j);
        // Vally's visor is recessed behind a sculpted rim: sit just above the glass so the rim hides the edge.
        const lift = header.name === "vally" ? 0.035 : 0.04;
        // Lift toward the viewer (not along the normal, which would pull ridge walls sideways and open gaps); the
        // recessed Vally visor keeps its normal lift.
        const [lx, ly, lz] = header.face.outline ? [normals[3 * i], normals[3 * i + 1], normals[3 * i + 2]] : [0, 0, 1];
        patchPositions.push(positions[3 * i] + lx * lift, positions[3 * i + 1] + ly * lift, positions[3 * i + 2] + lz * lift);
        patchNormals.push(normals[3 * i], normals[3 * i + 1], normals[3 * i + 2]);
        // +X is the viewer's left, so u runs right-to-left in model space (as on the procedural visor).
        patchUvs.push(0.5 - (positions[3 * i] - cx) / (width * pad), 0.5 + (positions[3 * i + 1] - cy) / (height * pad));
      }
      patchIndices.push(j);
    }
  }
  const data = new VertexData();
  data.positions = patchPositions;
  data.normals = patchNormals;
  data.uvs = patchUvs;
  data.indices = patchIndices;
  const screen = new Mesh(`${header.name}-face`, scene);
  data.applyToMesh(screen);
  screen.parent = parent;

  const W = 640;
  const H = Math.round(W * height / width);
  // No mipmaps: the face is redrawn on every expression change, but the smaller mip levels kept the first face drawn,
  // so at hero distance the old ring eyes showed through the live ones (Jocy, Meshy).
  const mips = false;
  const albedo = new DynamicTexture(`${header.name}-face-albedo`, { width: W, height: H }, scene, mips);
  const emissive = new DynamicTexture(`${header.name}-face-emissive`, { width: W, height: H }, scene, mips);
  albedo.hasAlpha = true;
  // Corners past the visor shape map outside 0..1: clamp to the canvas's clear edge instead of repeating the glass.
  for (const tex of [albedo, emissive]) { tex.wrapU = Texture.CLAMP_ADDRESSMODE; tex.wrapV = Texture.CLAMP_ADDRESSMODE; }
  const canvas = () => Object.assign(document.createElement("canvas"), { width: W, height: H });
  const drawPaddedFace = (ctx: CanvasRenderingContext2D, face: Face, glow: boolean) => {
    ctx.save();
    ctx.translate(W * (1 - 1 / pad) / 2, H * (1 - 1 / pad) / 2);
    ctx.scale(1 / pad, 1 / pad);
    drawFace(ctx, W, H, face, glow, rig);
    ctx.restore();
  };
  // Black glass with a feathered edge, so the painted visor rim shows around it.
  const glassCanvas = canvas();
  // The recess outline traced by the bake (or a superellipse), inside the padded canvas.
  const visorPath = (a: CanvasRenderingContext2D) => {
    const ox = (u: number) => W * ((1 - 1 / pad) / 2 + u / pad), oy = (v: number) => H * ((1 - 1 / pad) / 2 + v / pad);
    const outline = header.face.outline;
    // With a bezel along the rim, end the glass 0.06 units inside the traced edge, at the bezel's inner side:
    // glass that reaches under the tube wins the depth test there in spots (dotted edge).
    const inset = header.face.rim ? 0.06 : 0;
    a.beginPath();
    if (outline) for (let i = 0; i < outline.length; i += 2) {
      const du = (outline[i] - 0.5) * width, dv = (outline[i + 1] - 0.5) * height, d = Math.hypot(du, dv) || 1;
      const k = Math.max(0, d - inset) / d;
      a.lineTo(ox(0.5 + (outline[i] - 0.5) * k), oy(0.5 + (outline[i + 1] - 0.5) * k));
    }
    else for (let i = 0; i <= 160; i++) {
      const t = (i / 160) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t), n = header.face.squircle;
      a.lineTo(ox(0.5 + 0.5 * Math.sign(c) * Math.abs(c) ** (2 / n)), oy(0.5 - 0.5 * Math.sign(s) * Math.abs(s) ** (2 / n)));
    }
    a.closePath();
  };
  {
    const a = glassCanvas.getContext("2d")!;
    if (header.name === "vally") {
      // target/wanted-robot.png: indigo-violet glass, a lighter blue reflection down the left edge, and a dark bezel
      // just inside the rim.
      const inner = W / pad, x0 = W * (1 - 1 / pad) / 2;
      visorPath(a);
      a.save();
      a.clip();
      const body = a.createRadialGradient(W * 0.56, H * 0.48, H * 0.05, W * 0.5, H * 0.5, W * 0.5);
      body.addColorStop(0, "#2A1F78");
      body.addColorStop(0.6, "#22237A");
      body.addColorStop(1, "#1B2C8C");
      a.fillStyle = body;
      a.fillRect(0, 0, W, H);
      const reflection = a.createLinearGradient(x0, 0, x0 + inner * 0.3, 0);
      reflection.addColorStop(0, "rgba(70, 140, 255, 0.85)");
      reflection.addColorStop(0.45, "rgba(60, 110, 235, 0.35)");
      reflection.addColorStop(1, "rgba(60, 110, 235, 0)");
      a.fillStyle = reflection;
      a.fillRect(0, 0, W, H);
      a.lineWidth = H * 0.07;
      a.strokeStyle = "rgba(8, 8, 40, 0.75)";
      a.filter = `blur(${Math.round(H * 0.025)}px)`;
      visorPath(a);
      a.stroke();
      a.restore();
    } else if (rig.mask) {
      // Dark sockets over the painted eye slits, so a blink or a happy squint closes onto the faceplate.
      drawEyes(a, W, H, { ...NEUTRAL_FACE, scale: 1.1 }, false, rig, { ink: "#101317", glow: FACE_COLOR.blue.glow }, 1);
    } else {
      a.filter = `blur(${Math.round(H * 0.02)}px)`;
      a.fillStyle = "#04060B";
      squircle(a, W, H, H * 0.05);
      a.fill();
    }
    a.filter = "none";
    if (!rig.mask) {
      const sheen = a.createLinearGradient(0, 0, 0, H * 0.3);
      sheen.addColorStop(0, "rgba(150, 170, 210, 0.16)");
      sheen.addColorStop(1, "rgba(150, 170, 210, 0)");
      a.save();
      if (header.name === "vally") visorPath(a);
      else squircle(a, W, H, H * 0.08);
      a.clip();
      a.fillStyle = sheen;
      a.fillRect(0, 0, W, H * 0.3);
      a.restore();
    }
  }
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
      ec.fillStyle = "#000";
      ec.fillRect(0, 0, W, H);
      drawPaddedFace(ec, face, true);
      if (glows.size >= 16) glows.delete(glows.keys().next().value!);
    }
    glows.set(key, glow);
    const ac = albedo.getContext() as CanvasRenderingContext2D;
    ac.clearRect(0, 0, W, H);
    ac.drawImage(glassCanvas, 0, 0);
    drawPaddedFace(ac, face, false);
    albedo.update();
    const ec = emissive.getContext() as CanvasRenderingContext2D;
    ec.drawImage(glow, 0, 0);
    emissive.update();
  };
  setFace(NEUTRAL_FACE);
  const mat = new PBRMaterial(`${header.name}-face-screen`, scene);
  mat.albedoTexture = albedo;
  mat.useAlphaFromAlbedoTexture = true;
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  mat.emissiveTexture = emissive;
  mat.emissiveColor = Color3.White();
  // Vally's eyes are coloured cyan, not white-hot: a lower glow keeps the ink's hue.
  mat.emissiveIntensity = header.name === "vally" ? 1 : 1.6;
  mat.roughness = header.name === "vally" ? 0.42 : 0.3;
  // Black screens (Jocy, Ally, Meshy) read as near-black glass in the originals; full environment reflection made
  // them dark grey.
  if (header.name !== "vally") mat.environmentIntensity = 0.35;
  mat.metallic = 0;
  mat.ambientColor = new Color3(0.2, 0.2, 0.22);
  // Drawn over the decimated rim lip so the traced outline, not the rim triangles, is the visible edge.
  // The patch copies the body's triangles, and the body is drawn double-sided (its winding isn't guaranteed), so
  // the patch must be too, or it is culled and only the painted face shows.
  mat.backFaceCulling = false;
  // Lifted only 0.02 off a curved visor, the patch would z-fight the painted face under it; draw it on top.
  mat.zOffset = -2;
  screen.material = mat;
  return setFace;
}

/**
 * A GLB bot on the procedural robot's rig: the same pivot nodes (upper body at the hips, neck, shoulders, elbows,
 * hips, knees, ankles), and one parentless bone per node whose matrix is the node's transform relative to the root,
 * copied every frame. At rest every node is identity, so the bind pose is the baked mesh as is.
 */
function buildBot(scene: Scene, asset: BotAsset): Robot {
  const { header } = asset;
  const rig = header.rig;
  const v = (p: V3) => new Vector3(p[0], p[1], p[2]);
  const node = (name: string, parent: TransformNode, pivot?: V3) => {
    const n = new TransformNode(`${header.name}-${name}`, scene);
    n.parent = parent;
    if (pivot) n.setPivotPoint(v(pivot));
    return n;
  };
  const root = new TransformNode(`bot-${header.name}`, scene);
  const upper = node("upper", root, rig.hip);
  const neck = node("neck", upper, rig.neck);
  const headBody = node("head", neck);
  const antennaStem = node("antenna", headBody, rig.antenna);
  const arms: Arm[] = [];
  const legs: Leg[] = [];
  for (const [i, side] of [[0, -1], [1, 1]] as const) {
    const arm = node(`arm${side}`, upper, rig.shoulder[i]);
    arms.push({ arm, forearm: node(`forearm${side}`, arm, rig.elbow[i]), side, fingers: [] });
    const thigh = node(`thigh${side}`, root, rig.hipJoint[i]);
    const shin = node(`shin${side}`, thigh, rig.knee[i]);
    legs.push({ thigh, shin, foot: node(`foot${side}`, shin, rig.ankle[i]), side });
  }
  const bones: Record<string, TransformNode> = {
    root, upper, head: headBody, antenna: antennaStem,
    "arm-1": arms[0].arm, "forearm-1": arms[0].forearm, "arm+1": arms[1].arm, "forearm+1": arms[1].forearm,
    "thigh-1": legs[0].thigh, "shin-1": legs[0].shin, "foot-1": legs[0].foot, "thigh+1": legs[1].thigh, "shin+1": legs[1].shin, "foot+1": legs[1].foot,
  };

  const mesh = new Mesh(`bot-${header.name}-body`, scene);
  const data = new VertexData();
  data.positions = asset.positions;
  data.normals = asset.normals;
  data.uvs = asset.uvs;
  data.indices = asset.indices;
  data.matricesIndices = asset.joints;
  data.matricesWeights = asset.weights;
  data.applyToMesh(mesh);
  mesh.parent = root;
  mesh.numBoneInfluencers = 2;
  // Skinned bounds are the bind pose's; walking and waving would otherwise get culled at the frame edge.
  mesh.alwaysSelectAsActiveMesh = true;

  const texture = (slot: keyof BotHeader["textures"]) => {
    const file = header.textures[slot];
    return file ? new Texture(robotAssetUrl(file, asset.base), scene, { invertY: false }) : null;
  };
  const mat = new PBRMaterial(`bot-${header.name}-material`, scene);
  mat.albedoTexture = texture("color");
  const mr = texture("mr");
  if (mr) {
    // glTF packing: roughness in G, metalness in B.
    mat.metallicTexture = mr;
    mat.useRoughnessFromMetallicTextureGreen = true;
    mat.useMetallnessFromMetallicTextureBlue = true;
    mat.useAmbientOcclusionFromMetallicTextureRed = false;
    mat.metallic = 1;
    mat.roughness = 1;
  } else {
    mat.metallic = 0;
    mat.roughness = 0.4;
  }
  const normal = texture("normal");
  if (normal) { mat.bumpTexture = normal; mat.invertNormalMapX = true; }
  const glow = texture("emissive");
  if (glow) { mat.emissiveTexture = glow; mat.emissiveColor = Color3.White(); }
  mat.backFaceCulling = false;
  mat.ambientColor = new Color3(0.25, 0.25, 0.25);
  mesh.material = mat;
  // A smooth bezel along the visor rim's lip (traced by the bake), in the shell's material: it gives the glass a clean
  // edge line and hides the decimated lip's jagged silhouette.
  const rim = header.face.rim;
  if (rim) {
    const path = Array.from({ length: rim.length / 3 + 1 }, (_, k) => { const i = (k % (rim.length / 3)) * 3; return new Vector3(rim[i], rim[i + 1], rim[i + 2]); });
    const bezel = MeshBuilder.CreateTube(`${header.name}-visor-bezel`, { path, radius: 0.11, tessellation: 16, cap: 0 }, scene);
    bezel.parent = headBody;
    // Drawn over the glass patch (which itself has zOffset −2 over the rim), so the glass's edge can't peek through.
    const bezelMat = mat.clone(`${header.name}-visor-bezel`);
    bezelMat.zOffset = -4;
    bezel.material = bezelMat;
    bezel.isPickable = false;
  }

  const skeleton = new Skeleton(`bot-${header.name}-skeleton`, `bot-${header.name}`, scene);
  const links = header.bones.map(name => ({ bone: new Bone(name, skeleton, null, Matrix.Identity()), node: bones[name], keep: name === "head" || name === "antenna" }));
  mesh.skeleton = skeleton;
  // Nodes in parent-first order, so each world matrix is computed from an up-to-date parent.
  const order = [root, upper, neck, headBody, antennaStem, ...arms.flatMap(a => [a.arm, a.forearm]), ...legs.flatMap(l => [l.thigh, l.shin, l.foot])];
  const rootInverse = new Matrix();
  const relative = new Matrix();
  const collapsed = Matrix.Scaling(0, 0, 0).multiply(Matrix.Translation(rig.neck[0], rig.neck[1], rig.neck[2]));
  let portrait = false;
  scene.onBeforeRenderObservable.add(() => {
    for (const n of order) n.computeWorldMatrix(true);
    root.getWorldMatrix().invertToRef(rootInverse);
    for (const { bone, node: n, keep } of links) {
      if (portrait && !keep) relative.copyFrom(collapsed);
      else n.getWorldMatrix().multiplyToRef(rootInverse, relative);
      bone.getLocalMatrix().copyFrom(relative);
      bone.markAsDirty();
    }
  });

  // Antenna ball: a glow cap over the painted ball carries the state glow and turns red on error.
  const antenna = plastic(scene, `${header.name}-antenna-ball`, "#2F7BEA", 0.28);
  const antennaBlueBall = header.name === "vally" ? Color3.FromHexString("#E5EDF9").toLinearSpace() : undefined;
  // A bot without an antenna (Jarvis) bakes a zero radius: no cap.
  if (rig.antennaBall.radius > 0) {
    const ball = place(MeshBuilder.CreateSphere(`${header.name}-antenna-glow`, { diameter: rig.antennaBall.radius * 2.16, segments: 20 }, scene), antennaStem, antenna, v(rig.antennaBall.at));
    ball.isPickable = false;
  }
  const faceRig = BOT_FACES[header.name as BotName] ?? DEFAULT_FACE_RIG;
  const drawRigFace = buildBotFace(scene, asset, faceRig, headBody);
  // The rig's wiring swaps a preset's shapes for another's; gaze, lids and motion stay.
  const setFace = (face: Face) => {
    const wired = face.expression && faceRig.wire?.[face.expression];
    drawRigFace(wired ? express({ ...face }, wired) : face);
  };
  // secondaryMotion stretches a neck coil; the bots have none, so it drives an empty stand-in.
  const coil = new Mesh(`${header.name}-coil`, scene);
  coil.parent = root;
  return {
    // Jarvis's sculpted helmet is pitched down; lift it slightly so the painted eye slits and live face read from chat.
    root, baseYaw: 0, attitude: {
      pitch: header.name === "jarvis" ? -0.22 : 0,
      // Counter Jarvis's sculpted look toward its pointing hand, keeping both eye slits visible from the chat camera.
      yaw: header.name === "jarvis" ? -0.3 : 0.08, roll: 0, motion: 1,
    }, upper, head: neck, arms, legs, antenna,
    antennaStem, antennaBlueBall, headBody, coil, coilLength: 1, headRest: 0, setFace,
    // Vally's +X arm is sculpted mid-wave and Jarvis's points out level; Buddy's hard-shell shoulders need gentler swings.
    raiseMax: header.name === "vally" ? [1.2, 0.35] : header.name === "jarvis" ? [1.2, 0.3] : undefined,
    armMotionScale: header.name === "vally" ? 0.6 : header.name === "buddy" ? 0.82 : header.name === "jarvis" ? 0.7 : undefined,
    faceWire: faceRig.wire,
    locomotion: BOT_LOCOMOTION[header.name as BotName] ?? "walk",
    portrait: () => { portrait = true; },
  };
}

async function createBotScene(engine: Engine, framing: Framing, name: BotName) {
  const asset = await loadBotAsset(name);
  const fit = botFit(asset);
  const frame = heroFrame(asset, BOT_LOCOMOTION[name] ?? "walk");
  fit.heroRadius = frame.radius;
  fit.heroX = frame.x;
  fit.heroY = frame.y;
  const { scene, camera } = createStage(engine, framing, fit);
  const robot = buildBot(scene, asset);
  stageRobot(scene, robot, framing, fit);
  if (framing === "hero") robot.room = heroRoom(asset, camera);
  return { scene, camera, robot };
}

/**
 * The bot's flight room in the hero frame. The chat window's hero canvas is 170×300 (narrower layouts keep that
 * shape), so the view is the camera's vertical fov at that aspect. A bot may move until its widest point (its
 * reach, plus a little for turning and banking) or its top (antenna included) is a margin inside the frame.
 */
function heroRoom({ header, positions }: BotAsset, camera: ArcRotateCamera): FlightRoom {
  // Jarvis banks and faces its travel with one arm pointing out level: keep its sideways flight tighter.
  const ASPECT = HERO_ASPECT, MARGIN = header.name === "jarvis" ? 1.1 : 0.45;
  let reach = 0, top = 0;
  for (let i = 0; i < positions.length / 3; i++) {
    // Turning swings depth into width: use the bot's radius around its vertical axis.
    reach = Math.max(reach, Math.hypot(positions[3 * i], positions[3 * i + 2]));
    top = Math.max(top, positions[3 * i + 1]);
  }
  const halfHeight = camera.radius * Math.tan(camera.fov / 2);
  return {
    side: Math.max(0, Math.min(0.6, halfHeight * ASPECT - reach - MARGIN)),
    up: Math.max(0, Math.min(1.2, camera.target.y + halfHeight - top - MARGIN)),
  };
}

/**
 * Hero loop shared by the procedural robot and the GLB bots: state from `canvas.dataset.robotState`, idle acts,
 * tap giggle, pointer look, spring-eased pose and secondary motion. Listeners it adds are removed via `cleanups`.
 */
function animateHero(canvas: HTMLCanvasElement, scene: Scene, robot: Robot, cleanups: Array<() => void>) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const states = Object.keys(PERIOD) as RobotState[];
  const mountedAt = performance.now();
  const current = poseAt("idle", 0);
  const springs: Springs = { dt: 0, velocity: new Map(), face: faceMotion() };
  const follow = secondaryMotion(robot);
  let last = mountedAt;
  // Play: one act at a time; idle picks a random one every 5–10 s, a tap starts "giggle".
  let play: { kind: Play; start: number; seed: number } | undefined;
  // A fresh flight path per act, never the same shape twice in a row.
  let lastFlight: FlightShape | undefined;
  const newSeed = () => {
    let seed: number;
    do seed = Math.floor(Math.random() * 2 ** 31); while (flightPath(seed, true).shape === lastFlight);
    lastFlight = flightPath(seed, true).shape;
    return seed;
  };
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
      play = { kind: "giggle", start: performance.now(), seed: newSeed() };
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
      if (asked && PLAY_LENGTH[asked] && (asked === "giggle" || playsFor(robot.locomotion).includes(asked))) {
        play = { kind: asked, start: now, seed: newSeed() };
        delete canvas.dataset.robotPlay;
      }
      const tracking = pointer && now - pointer.at < 2500 && (state === "idle" || state === "listening");
      if (!play && state === "idle" && !tracking && now >= nextPlay) {
        const plays = playsFor(robot.locomotion);
        play = { kind: plays[Math.floor(Math.random() * plays.length)], start: now, seed: newSeed() };
      }
      if (play) {
        const u = (now - play.start) / (PLAY_LENGTH[play.kind] * 1000);
        if (u >= 1 || (state !== "idle" && play.kind !== "giggle")) {
          play = undefined;
          // A spin ends a full turn away; drop whole turns so easing doesn't unwind it backwards.
          current.turn -= 2 * Math.PI * Math.round(current.turn / (2 * Math.PI));
          nextPlay = now + 5000 + Math.random() * 5000;
        } else playOver(target, play.kind, u, robot.locomotion, play.seed, robot.room);
      }
      locomote(target, robot.locomotion, (now - mountedAt) / 1000, robot.room);
      // Hosts can force an expression preset: data-robot-face="love" (removed by deleting the attribute).
      const forced = canvas.dataset.robotFace as Expression | undefined;
      if (forced && forced in EXPRESSIONS) express(target.face, forced);
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

// ---------- avatar sprites and sheets ----------

const AVATAR_PX = 128;
const SHEET_FRAMES = 16;
/** 36 frames over idle's 6 s look-around; its blinks sit exactly on frames (7, 21, 23) so none falls between. */
const IDLE_FRAMES = 36;

/** Models with a rigged avatar studio (the wanted model is a single still). */
type StudioModel = "default" | BotName;
type Studio = { engine: Engine; scene: Scene; robot: Robot; canvas: HTMLCanvasElement };
const studios = new Map<StudioModel, Promise<Studio>>();
let studioQueue: Promise<unknown> = Promise.resolve();
const studioTimers = new Map<StudioModel, ReturnType<typeof setTimeout>>();

/**
 * One offscreen engine per model renders every avatar still and sheet, one job at a time across all models, and
 * is disposed after a quiet spell so idle webviews hold no WebGL context.
 */
function withStudio<T>(model: StudioModel, job: (studio: Studio) => Promise<T> | T): Promise<T> {
  const run = studioQueue.then(async () => {
    clearTimeout(studioTimers.get(model));
    let studio = studios.get(model);
    if (!studio) {
      studio = (async () => {
        const canvas = Object.assign(document.createElement("canvas"), { width: AVATAR_PX * 2, height: AVATAR_PX * 2 });
        const engine = new Engine(canvas, true, { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: false, powerPreference: "low-power" }, false);
        try {
          const { scene, robot } = model === "default" ? createScene(engine, "avatar") : await createBotScene(engine, "avatar", model);
          // A render before shaders (and bot textures) are ready gives an empty frame.
          await scene.whenReadyAsync();
          return { engine, scene, robot, canvas };
        } catch (error) {
          engine.dispose();
          throw error;
        }
      })();
      studios.set(model, studio);
      studio.catch(() => studios.delete(model));
    }
    const s = await studio;
    try {
      return await job(s);
    } finally {
      studioTimers.set(model, setTimeout(() => {
        const done = studios.get(model);
        studios.delete(model);
        void done?.then(({ scene, engine }) => { scene.dispose(); engine.dispose(); });
      }, 15000));
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

const sprites = new Map<StudioModel, Promise<string | undefined>>();
let wantedSpritePromise: Promise<string | undefined> | undefined;
const sheets = new Map<string, Promise<AvatarSheet | undefined>>();

const runtime: RobotRuntime = {
  getAvatarSprite(model = HOST_MODEL) {
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
    let sprite = sprites.get(model);
    if (!sprite) {
      sprite = withStudio(model, s => {
        renderFrame(s, "idle", 0);
        return s.canvas.toDataURL("image/png");
      }).catch(() => undefined);
      sprites.set(model, sprite);
    }
    return sprite;
  },
  getAvatarSheet(state, model = HOST_MODEL) {
    if (model === "wanted") return runtime.getAvatarSprite("wanted").then(url => url ? { url, frames: 1, duration: 0 } : undefined);
    if (!PERIOD[state]) return Promise.resolve(undefined);
    const key = `${model}:${state}`;
    let sheet = sheets.get(key);
    if (!sheet) {
      sheet = withStudio(model, async s => {
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
      sheets.set(key, sheet);
    }
    return sheet;
  },
  mount(canvas, model) {
    try {
      const engine = new Engine(canvas, true, { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false, stencil: false, powerPreference: "low-power" }, false);
      const asked = model ?? canvas.dataset.robotModel ?? HOST_MODEL;
      const selectedModel: RobotModel = asked === "wanted" || BOT_NAMES.includes(asked as BotName) ? asked as RobotModel : "default";
      if (selectedModel !== "default" && selectedModel !== "wanted") return mountBot(canvas, engine, selectedModel);
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
      if (framing === "hero") animateHero(canvas, scene, robot, cleanups);
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

/**
 * Hero for a GLB bot: the engine renders nothing until the baked asset has loaded, then runs the shared hero loop.
 * If the asset can't be loaded, the procedural robot takes its place.
 */
function mountBot(canvas: HTMLCanvasElement, engine: Engine, name: BotName) {
  const cleanups: Array<() => void> = [];
  let scene: Scene | undefined;
  let disposed = false;
  const show = (built: { scene: Scene; robot: Robot }) => {
    if (disposed) { built.scene.dispose(); return; }
    scene = built.scene;
    animateHero(canvas, built.scene, built.robot, cleanups);
  };
  createBotScene(engine, "hero", name).then(built => {
    canvas.dataset.robotLoaded = name;
    show(built);
  }, error => {
    // Recorded on the canvas too, so devtools and tests can see which robot is showing and why.
    canvas.dataset.robotLoaded = "fallback";
    canvas.dataset.robotError = String((error as Error)?.message ?? error);
    console.warn(`[AgentRobot3D] Could not load the selected robot "${name}"; showing the procedural fallback.`, error);
    if (!disposed) show(createScene(engine, "hero"));
  });
  engine.runRenderLoop(() => scene?.render());
  const observer = new ResizeObserver(() => engine.resize());
  observer.observe(canvas);
  return () => {
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    observer.disconnect();
    scene?.dispose();
    engine.dispose();
  };
}

window.AgentRobot3D = runtime;

// Exported for preview probes (.claude/skills/robot-3d/scripts) that render exact poses without the clock;
// the bundled IIFE only uses the window global above.
export { flightPath, heroRoom, applyPose, clonePose, createBotScene, createScene, createWantedScene, express, EXPRESSIONS, faceMotion, locomote, lookToward, playOver, playsFor, poseAt, PLAY_LENGTH, WANTED_BODY };
