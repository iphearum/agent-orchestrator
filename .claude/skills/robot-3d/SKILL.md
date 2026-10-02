---
name: robot-3d
description: Design, model, light, animate and verify the procedural Babylon.js 3D robot mascot (target/3d-robot.png) used for the chat welcome hero canvas and the cached agent-avatar sprites — webview-ui/src/robot-runtime.ts, the window.AgentRobot3D runtime (mount / getAvatarSprite), its IIFE bundle dist/webview/robot-runtime.js, the SVG RobotGlyph fallback, and headless WebGL screenshots. Use this whenever you touch robot-runtime.ts, the robot's shape/colours/lighting/materials/pose/idle animation, the agent avatar sprite, the welcome robot canvas in chatWindow.ts, Babylon imports or bundle size, or the user says "make the robot look like the image", "3D bot", "mascot", "avatar looks wrong", or mentions Babylon.
---

# 3D robot (Babylon.js)

The mascot is built **procedurally** from Babylon primitives, so there's no glTF file and no texture to fetch. The webview CSP blocks remote loads, and a code-built model stays tiny, themeable and easy to diff. The target look is `target/3d-robot-full.png` (full standing robot with legs; the head close-up is `target/3d-robot-head.png`, and `target/3d-robot.png` is an older legless concept). The original description, kept for context: a pearl-white toy robot with a deep rounded-cube head, a bezelled black visor with a big glowing face, low blue puck ears, a rounded-barrel torso, ribbed grey arms with big blue cuffs and open pincer claws, and **no legs**. The measured spec is in [references/design-spec.md](references/design-spec.md). Read it before changing geometry.

## Where things live

| Piece | File |
| --- | --- |
| Scene, robot builder, runtime API | `webview-ui/src/robot-runtime.ts` |
| Bundle (separate IIFE, not part of `main.js`) | `package.json` → `build:webview` → `dist/webview/robot-runtime.js` |
| Loaded in React webviews | `backend/src/vscode/webviews/webviewHost.ts` (classic `<script nonce>` before `main.js`) |
| Loaded in the chat window | `backend/src/vscode/chatWindow.ts` (`robotScript`, `#welcome-robot` canvas, hides it and shows the fallback if `mount` returns `undefined`) |
| Avatar consumer + SVG fallback | `webview-ui/src/icons.tsx` → `RobotGlyph` |
| Type of `window.AgentRobot3D` | `webview-ui/src/env.d.ts` (keep in sync with `RobotRuntime` in the runtime) |
| Dev page | `webview-ui/dev.html` |
| GLB bots: bake script, baked assets | `scripts/bake-bots.ts` → `media/bots/` (sources in `backend/src/bots/`); workflow in the glb-bot skill |

Runtime contract. Keep it stable, because three surfaces depend on it:

```ts
window.AgentRobot3D = {
  mount(canvas): (() => void) | undefined,          // live hero; returns dispose, or undefined when WebGL is unavailable
  getAvatarSprite(): Promise<string | undefined>,   // cached PNG still of the head
  getAvatarSheet(state): Promise<{ url, frames, duration } | undefined> // cached looping strip per state (idle = 1 frame)
};
// The hero follows `canvas.dataset.robotState` every frame: idle | listening | thinking | working | talking | happy | error.
```

## Animation

- **One pose function drives everything.** `poseAt(state, t)` returns the targets: upper-body lean, sway and bob; head pitch, yaw and roll; per-arm swing, raise, bend and wave; antenna glow; and the face (eyes, look, mouth, tone). Every motion is periodic in `PERIOD[state]`, so avatar sheets loop seamlessly. The hero eases toward the targets (`applyPose` with k = 1 − e^(−7·dt)); sheets snap.
- **The rig is pivots, not bones:** `upper` pivots at the hips (legs stay planted), the neck pivot nods the head, `arm` pivots at the shoulder, `forearm` at the elbow. Signs (camera on +Z, +X = viewer's left): swing/bend < 0 is forward, raise = side × angle outward-up, lean > 0 tips forward, head pitch < 0 looks up.
- **Face layer.** `Face` = eye shape (open/happy/focus/sad) + `lid` (openness; blinks squash and widen the eye), `scale`, gaze `lookX/lookY`, mouth (smile/grin/talk/o/flat/frown/dots) + `open`/`width`, tone (blue/red).
  - Per state: idle looks around in held glances (`glance`) with a blink and later a double blink; listening has bigger eyes and a slow blink; thinking's narrowed eyes drift up-right while the "…" dots cycle; working's focus eyes sweep along lines like reading; talking has syllables of varying height and width with lips closing between words and eyes widening on stress; happy's ^^ eyes and grin bounce; error has heavy red lids, one slow blink and a trembling frown.
  - The hero eases gaze, size and mouth about twice as fast as the body; lids switch at once so blinks stay crisp, and the dot counter is never blended.
  - Faces are quantised (`faceKey`). Only the glow layer is cached, in a 16-entry LRU at 640 px; caching both layers at 768 px could hold ~165 MB.
- **States:** idle (breathing, looking around, blink); listening (leans in, head tilted); thinking (looks up, hand to chin, "…" dots, pulsing antenna); working (hunched, hands typing, scanning eyes); talking (mouth syllables, gesture); happy (wave, grin, bounce; also the greeting for the first 2.6 s); error (droop, sad red face).
- **Avatars:** one shared offscreen "studio" engine renders stills and 12-frame × 128 px sheets on demand, one job at a time, yielding between frames; it disposes itself after 15 s idle. Consumers play a sheet with `.robot-sheet` (`steps(var(--frames), jump-none)` from 0% to 100% background position), which is off under `prefers-reduced-motion`. A keyframe to `calc(frames × −100%)` is wrong: percentage positions are relative to (box − image).
- **Wiring:** React `Avatar` maps the agent's run state to an animation (thinking→thinking, running→working, delegating→talking, waiting→listening, failed→error). In the chat, the reply's robot shows at the start of the "Working for…" line: thinking on start, working on tool activity, talking on chunks, happy or error when finished, then idle. The welcome hero goes to listening while the user types.
- **Play (hero only, off under reduced motion).**
  - **Pointer look:** the robot looks at the pointer anywhere in the webview (`lookToward`). The body turns a little, the head more, the eyes most, cancelling the 3/4 framing so a centred pointer gets a straight-on look. It fades back 2.5 s after the pointer stops, and only applies in idle and listening.
  - **Idle acts** (`playOver`, every 5–10 s): curious, look-around, check-hand, nod, wiggle, stretch, peek. A tap on the canvas (not a camera drag) plays `giggle`.
  - A host can request an act with `canvas.dataset.robotPlay = "nod"`.
- **Locomotion.** The legs are rigged like the arms: `thigh` pivots at the hip, `shin` at the knee, `foot` (the ankle joint, carrying the shoe and its brackets) at the ankle. `LegPose` = hip (< 0 forward), knee (> 0 bends back), foot (pitch).
  - `step()` is the gait: two steps per cycle, with a bent knee on the forward swing, a level shoe, arms swinging against the legs, and the body bobbing twice per cycle.
  - Acts: `turn-around` is a 360° spin while stepping. When an act ends, whole turns are subtracted from the eased turn so it doesn't unwind backwards.
  - `walk` turns to the viewer's left, strolls 0.5 units (`Pose.x` → `root.position.x`), turns through front-facing to the right, walks back, then faces front. The welcome canvas is narrow, so keep walks within about ±0.5.
  - `dance` marches in place with pumping arms.
  - Feet slide slightly while the root translates (no foot-planting IK); that's acceptable at this size.
  - Avatars wave (happy sheet) while hovered, but only when idle.
- **Follow-through (hero only).**
  - Body, head, turn, walk offset and arm channels follow their targets as damped springs (`Springs` in `applyPose`, ζ ≈ 0.55–0.7), so stops overshoot slightly and settle. Sheets and snaps still use plain `mix`.
  - `secondaryMotion()` runs after each frame from the actual pose change. The antenna stalk (`antennaStem`, pivot at the collar) wobbles against head pitch/roll acceleration and sideways acceleration. The head bounces on its coil (`headBody.position.y`, coil `scaling.y` from its base) against vertical acceleration and lags sideways against sway. It is visual only and never feeds back into the pose.
  - Claws have a hinge per finger. `ArmPose.grip` > 0 opens and < 0 closes: they tap while typing, open while waving, gesturing and giggling, curl while thinking, go limp on error, and snap during check-hand.
  - Anticipation: turn-around winds up (crouch and counter-twist) before spinning, and walk crouches before setting off.
- **Avatar portrait.**
  - Framing: the avatar studio renders the head only (other meshes disabled) and nearly faces the camera (`attitude` yaw 0.16, pitch −0.05, roll −0.04). State head motion runs at 75% (`attitude.motion`) so droops and tilts keep the face in frame. Head + ears + antenna fill about 80% of the square. Frames are framed tight, so consumers show them at 100% with no zoom.
  - Face: frames use `face.bold` (eyes ×1.18, strokes and glow ×1.4) so expressions read at 22–30 px. The strip is composited with a soft drop shadow so the white head separates from tinted or light backgrounds.
  - Idle: idle is a 36-frame, 6 s look-around (`glanceSmooth`): centre → left → centre → right → up (with an "o" mouth) → down → centre, with the head turning with the gaze and blinks placed exactly on frames 7, 21 and 23. It replaces the old still. Each avatar starts at a random `animation-delay`, so lists don't blink together.
  - Check at real size with a page showing every state at 24, 30 and 48 px on light and dark.
- **Screen-face turning.** `drawFace` shifts the mouth with the gaze (a little less than the eyes), narrows it as the face turns or tips back, and shrinks the eye on the side the face turns toward. A flat screen then reads as a face turning left, right, up or down, in the hero and in the avatars. Talking turns the head between listeners with the gaze leading. On error the antenna ball turns red, not just its glow.
- **Testing motion headlessly:** virtual time runs few `requestAnimationFrame`s, so the eased hero never reaches its targets in a screenshot. Either drive rAF from timers (`window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 16)`, already in `--states`) or render exact poses with `scripts/pose-probe.ts`, which imports the runtime's exported `poseAt` / `playOver` / `lookToward` and writes `.ui-check/robot-probe.png`.
- Check with `preview.ts --states` (a hero per state plus every sheet, frame by frame) and the chat feeds `working` / `streaming` / `finished`.

`mount` must never throw. Callers treat `undefined` as "show the SVG fallback". The sprite is rendered once per webview and memoised, so don't create one engine per avatar.

## GLB bots (jocy, ally, vally, meshy)

GLB models in `backend/src/bots/` are baked by `scripts/bake-bots.ts` into `media/bots/` and skinned to this robot's rig, so they play every state and act. Users pick one with `agentOrchestrator.robotModel` (`default` | `jocy` | `ally` | `vally` | `meshy`). For converting a new GLB or fixing a bot's rigging, face or textures, use the **glb-bot** skill (`.claude/skills/glb-bot/`). When changing the runtime here, keep three things working for the bots:
- `Robot.portrait()`: avatars collapse a bot's body instead of disabling meshes.
- The face layers: `drawFace(ctx, w, h, face, glow, rig)` draws `drawEyes` then `drawMouth` on a `FaceRig`'s anchors (`DEFAULT_FACE_RIG` for this robot). Faces come from `EXPRESSIONS` presets (tag with `face.expression` / `express`), so new emotions belong there, not in ad-hoc eye and mouth assignments.
- `Pose.lift` and `robot.locomotion` ("walk" | "fly" | "both"): `locomote` and the `fly` act. This robot walks.
- The shared `animateHero` / `stageRobot` / `createStage`.

## Workflow

1. **Look at the target.** Read `target/3d-robot.png` and `references/design-spec.md`. Name the 2–3 biggest differences between them and the current render before you edit anything.
2. **Start from the current runtime.** `robot-runtime.ts` already has the tuned helpers (`roundedBox`, `barrel`, `segment`/`alignY`, `ribs`, `clawFinger`, `plastic`/`glow`) and the measured build. [references/recipes.ts](references/recipes.ts) keeps standalone versions plus extras (`eggTorso`, `earDisc`, `addGlow`) for experiments. Copy code from it; never import from `.claude/`.
3. **Build and render outside VS Code:**
   ```bash
   bun run build:webview
   bun .claude/skills/robot-3d/scripts/preview.ts --compare   # → robot-preview.png, robot-compare.png and parts/*.png in .ui-check/; prints script errors
   ```
   `robot-preview.png` shows the hero on a light and a dark ground plus the avatar sprite at 96/48/24 px. `robot-compare.png` puts the target and the render **side by side at the same size**. Use it to judge proportions. Judging the render alone missed a too-wide head, an egg torso and undersized claws, which were obvious side by side. A clean build verifies nothing about how it looks.
4. **Iterate part by part** (head → face → ears/antenna → body/arms → claws) on the `parts/` crops, and finish one part before starting the next. Measure the reference in pixels (head ≈ 160 px ≈ 2.0 units), change a few numbers, re-run `--compare`, look. Then fix lighting and pose; proportions come first. The avatar must still read at 24 px.
5. **Check the surroundings** with the `ui-verify` skill (chat welcome, sidebar avatars, light/dark/HC), then `bun run typecheck`. `render-chat.ts` maps every `asWebviewUri` to `markdown-it.min.js`, so in the rendered chat page point the second `<script src>` at `../dist/webview/robot-runtime.js` before shooting, and shoot with the SwiftShader flags (see Headless WebGL).
6. Add a progress note to `docs/progress.md` (newest first, local time with offset).

## Modelling rules

- **Orientation.** +Y is up. The default camera (`ArcRotateCamera`, `alpha = π/2`) sits on **+Z**, so the face goes on +Z, and **+X is the viewer's left**. In an early recipe test the visor was placed on −Z and disappeared inside the head. The key light was also placed on the wrong side until the X sign was flipped.
- **Group under one `TransformNode` root** (`agent-robot`) so idle motion and framing move one node. Put sub-parts (head, each arm) under their own nodes when you'll animate them.
- **Cylinders are built along +Y.** Aim them with `Quaternion.FromUnitVectorsToRef(Vector3.Up(), dir, …)` (`alignY`). `lookAt` + Euler fix-ups produced tilted ribs in testing.
- **Rounded shapes.** A scaled sphere reads as an egg, not a box. Use `roundedBox` (exponent ≈ 3–3.3) for the head, visor, ears and cuffs, and a superellipse lathe (`barrel` in the runtime) for the torso. Keep the visor's front just proud of the head surface rather than bulging out.
- **Keep segment counts modest**: 20–32 for spheres, 16–32 tessellation for cylinders. At these sizes more triangles add nothing visible.

## Materials and light

- No environment texture is possible (CSP + no network), so PBR has no IBL. Compensate: set `scene.ambientColor` to white, give each `PBRMaterial` an `ambientColor` around 0.25, and enable **ACES tone mapping** (exposure ≈ 1.1). Without tone mapping the white shell clips to a flat silhouette. Use a hemispheric fill ≈ 0.5 with a cool ground colour and a directional key ≈ 2.6 from the viewer's upper left-front (negative X). Exact values are in the design spec.
- The runtime uses `PBRMaterial` + `GlowLayer`, which look much closer to the reference than `StandardMaterial` but cost about **0.5 MB** of minified bundle (1.67 MB → 2.17 MB). Don't switch back without comparing.
- Eyes/mouth: unlit emissive `#BFEFFF`. If you use a `GlowLayer`, register only the glowing meshes with `addIncludedOnlyMesh`, or the white shell blooms. Skip the glow for the avatar sprite, where it smears at 24 px.
- The clear colour is transparent (`Color4(0,0,0,0)`) so the robot sits on any VS Code theme. Check it on dark and light grounds. Use `premultipliedAlpha: true` to avoid dark fringes.

## Rendering modes

- **Hero (`mount`)**: render loop, `ResizeObserver` → `engine.resize()`, and idle bob/yaw via `registerBeforeRender`. Skip animation for `prefers-reduced-motion`. The dispose function must disconnect the observer and dispose the scene, then the engine.
- **Avatar sprite (`getAvatarSprite`)**: an offscreen 256² canvas with `preserveDrawingBuffer: true` and camera framed on the head. **Render only after `await scene.whenReadyAsync()`**: a single `scene.render()` straight after creation can run before shaders compile and give an empty frame. Then `toDataURL`, then dispose the scene and engine. Before this was fixed, the sprite came out empty: the blue avatar background with no robot.
- Use `powerPreference: "low-power"` and `stencil: false`, and only one live engine per canvas.

## Imports and bundle

- Import from deep paths (`@babylonjs/core/Meshes/meshBuilder.pure`, `…/Cameras/arcRotateCamera`) rather than the `@babylonjs/core` barrel, which pulls in the whole engine.
- `MeshBuilder.Create*` from `meshBuilder.pure` only works after the builder's side-effect import, e.g. `import "@babylonjs/core/Meshes/Builders/latheBuilder";`. A missing one fails at **runtime** (`CreateLathe is not a function`), not at typecheck, so add one per new builder.
- Report bundle-size changes: `ls -la dist/webview/robot-runtime.js` before and after.

## Headless WebGL

`preview.ts` launches Chrome with `--use-angle=swiftshader --enable-unsafe-swiftshader`. The `ui-verify` `shoot.ts` uses `--disable-gpu`, which can leave Babylon without a WebGL context, so the canvas goes blank and the fallback shows. If a ui-verify screenshot shows the SVG fallback where you expected 3D, re-shoot with the SwiftShader flags before assuming the runtime broke. SwiftShader output is a little softer than a GPU render, but proportions and colours are faithful.

## Done means

- `.ui-check/robot-compare.png` was opened: silhouette, proportions, palette, face, shading side and claws match the target, and there are no legs.
- The avatar sprite is visible and recognisable at 24 px.
- `preview.ts --shot` reports `errors: none`. `bun run typecheck` passes. The fallback still appears when `AgentRobot3D` is absent.
- The bundle-size delta is reported and a progress note is added.
