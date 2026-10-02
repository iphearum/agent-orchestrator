---
name: robot-3d
description: Design, model, light, animate and verify the procedural Babylon.js 3D robot mascot (target/3d-robot.png) used for the chat welcome hero canvas and the cached agent-avatar sprites — webview-ui/src/robot-runtime.ts, the window.AgentRobot3D runtime (mount / getAvatarSprite), its IIFE bundle dist/webview/robot-runtime.js, the SVG RobotGlyph fallback, and headless WebGL screenshots. Use this whenever you touch robot-runtime.ts, the robot's shape/colours/lighting/materials/pose/idle animation, the agent avatar sprite, the welcome robot canvas in chatWindow.ts, Babylon imports or bundle size, or the user says "make the robot look like the image", "3D bot", "mascot", "avatar looks wrong", or mentions Babylon.
---

# 3D robot (Babylon.js)

The mascot is built **procedurally** from Babylon primitives, so there's no glTF file and no texture to fetch. The webview CSP blocks remote loads, and a code-built model stays tiny, themeable and easy to diff. The target look is `target/3d-robot.png`: a pearl-white toy robot with a deep rounded-cube head, a bezelled black visor with a big glowing face, low blue puck ears, a rounded-barrel torso, ribbed grey arms with big blue cuffs and open pincer claws, and **no legs**. The measured spec is in [references/design-spec.md](references/design-spec.md). Read it before changing geometry.

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
  mount(canvas): (() => void) | undefined,   // live hero; returns dispose, or undefined when WebGL is unavailable
  getAvatarSprite(): Promise<string | undefined> // one cached PNG data URL of the head, shared by every avatar
};
```

`mount` must never throw. Callers treat `undefined` as "show the SVG fallback". The sprite is rendered once per webview and memoised, so don't create one engine per avatar.

## GLB bots (jocy, ally, vally, meshy)

GLB models in `backend/src/bots/` are baked by `scripts/bake-bots.ts` into `media/bots/` and skinned to this robot's rig, so they play every state and act. Users pick one with `agentOrchestrator.robotModel` (`default` | `jocy` | `ally` | `vally` | `meshy`). For converting a new GLB or fixing a bot's rigging, face or textures, use the **glb-bot** skill (`.codex/skills/glb-bot/`). When changing the runtime here, keep three things working for the bots:
- `Robot.portrait()`: avatars collapse a bot's body instead of disabling meshes.
- The face layers: `drawFace(ctx, w, h, face, glow, rig)` draws `drawEyes` then `drawMouth` on a `FaceRig`'s anchors (`DEFAULT_FACE_RIG` for this robot). Faces come from `EXPRESSIONS` presets (tag with `face.expression` / `express`), so new emotions belong there, not in ad-hoc eye and mouth assignments.
- `Pose.lift` and `robot.locomotion` ("walk" | "fly" | "both"): `locomote` and the `fly` act. This robot walks.
- The shared `animateHero` / `stageRobot` / `createStage`.

## Workflow

1. **Look at the target.** Read `target/3d-robot.png` and `references/design-spec.md`. Name the 2–3 biggest differences between them and the current render before you edit anything.
2. **Start from the current runtime.** `robot-runtime.ts` already has the tuned helpers (`roundedBox`, `barrel`, `segment`/`alignY`, `ribs`, `clawFinger`, `plastic`/`glow`) and the measured build. [references/recipes.ts](references/recipes.ts) keeps standalone versions plus extras (`eggTorso`, `earDisc`, `addGlow`) for experiments. Copy code from it; never import from `.codex/`.
3. **Build and render outside VS Code:**
   ```bash
   bun run build:webview
   bun .codex/skills/robot-3d/scripts/preview.ts --compare   # → robot-preview.png + robot-compare.png in .ui-check/; prints script errors
   ```
   `robot-preview.png` shows the hero on a light and a dark ground plus the avatar sprite at 96/48/24 px. `robot-compare.png` puts the target and the render **side by side at the same size**. Use it to judge proportions. Judging the render alone missed a too-wide head, an egg torso and undersized claws, which were obvious side by side. A clean build verifies nothing about how it looks.
4. **Iterate**: measure the reference in pixels (head ≈ 160 px ≈ 2.0 units), change a few numbers, re-run `--compare`, look. Then fix lighting and pose; proportions come first. The avatar must still read at 24 px.
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
