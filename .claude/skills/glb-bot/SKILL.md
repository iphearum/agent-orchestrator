---
name: glb-bot
description: Convert a .glb model (Meshy, Tripo, Sketchfab, Blender export — any static or skinned glTF character) into a rigged bot that plays every animation of the Babylon.js robot runtime (idle/listening/thinking/working/talking/happy/error, wave, nod, walk, dance, pointer look, avatar sheets) — inspect the GLB, measure its joints on orthographic grids, add a CONFIG entry to scripts/bake-bots.ts, bake the bot into media/bots (.bin + WebP textures), register the bot in webview-ui/src/robot-runtime.ts and the agentOrchestrator.robotModel setting, and verify with exact-pose, label and relief (cracks / open edges / visor outline) renders. Also covers sourcing the model with Meshy (text/image → 3D in a bake-friendly A-pose, remesh, retexture, auto-rig) and reading an existing skeleton (Meshy/Mixamo auto-rig) into rig pivots or weights. Use this whenever the user drops a new .glb/.gltf into backend/src/bots or elsewhere and wants it as the mascot/agent avatar, says "convert this glb", "make this model animate like the robot", "add a new bot", "rig this", "use this 3D model in the chat", "generate a new bot/mascot", "make a bot with Meshy", or when an existing bot (jocy, ally) shows streaks, holes, cracks, seams, black patches, a ragged or misfit visor/face, wrong parts moving, or needs re-baking — even if they don't mention Babylon or skinning.
---

# GLB → robot-runtime bot

The robot runtime (`webview-ui/src/robot-runtime.ts`) animates one rig: pivot nodes for the upper body (at the hips), the neck, each shoulder and elbow, each hip, knee and ankle, plus an antenna stalk. `poseAt` / `playOver` / `applyPose` drive those nodes for every state and act. A GLB bot reuses all of that: an offline **bake** cuts the mesh into rig parts with smooth skin weights, and the runtime skins it to the same nodes. No glTF loader ships, and the webview only fetches a small binary plus textures.

jocy (upright toy, 10k triangles) and ally (mid-leap, 754k → 70k triangles) are the worked examples. Their `CONFIG` entries in `scripts/bake-bots.ts` are the best templates. Copy the one whose pose is closest.

## Where things live

| Piece | File |
| --- | --- |
| Source models (not packaged: `backend/src/**` is in `.vscodeignore`) | `backend/src/bots/<bot>.glb` |
| Bake: decode, normalise, decimate, label, weight, bridge removal, hole caps, paint scrub, textures | `scripts/bake-bots.ts` (`CONFIG[<bot>]`) |
| Baked assets (shipped) | `media/bots/<bot>.bin`, `media/bots/<bot>-{color,mr,normal,emissive}.webp` |
| Runtime: loader, rig, skinning, face patch, antenna glow, per-model studios | `robot-runtime.ts`: `BotName`, `BOT_NAMES`, `BOT_FACES`, `loadBotAsset`, `buildBot`, `createBotScene`, `mountBot` |
| Model choice | `agentOrchestrator.robotModel` (`package.json`) → `robotModelSetting()` (`backend/src/vscode/webviews/webviewHost.ts`) → `data-robot-model` on the runtime script tag (chat window + React webviews) |
| Window type | `webview-ui/src/env.d.ts` → `RobotModelName` |
| Tools (run from the repo root) | `.claude/skills/glb-bot/scripts/`: `glb-info.ts`, `skeleton.ts`, `grid.ts`, `probe.ts` (incl. `--stretch`), `relief.ts` |
| Generating or fixing the source model (Meshy MCP: generate, remesh, retexture, auto-rig) | [references/meshy.md](references/meshy.md) |
| Blender round trip | `scripts/export-rigged.ts <bot>` → `.ui-check/glb-bot/<bot>-rigged.glb`; an edited copy saved as `backend/src/bots/<bot>-rigged.glb` is baked instead of `<bot>.glb` |

Conventions (axes, sides, bone order, `.bin` layout, runtime details) are in [references/pipeline.md](references/pipeline.md). Read it before writing a `classify` or changing the runtime side. When a render looks wrong, look the symptom up in [references/troubleshooting.md](references/troubleshooting.md) before guessing. When there is no model yet, or it is cheaper to regenerate than to fix, read [references/meshy.md](references/meshy.md) first: the right generation settings avoid most of the bake fixes below.

## Workflow

0. **Source** (only with no model, or one cheaper to regenerate than to fix): generate it with Meshy using [references/meshy.md](references/meshy.md): A-pose (not T-pose: the runtime idles in the sculpted pose), a blank visor, ~70k triangles, de-lit PBR textures. Every Meshy call costs credits, so confirm the cost with the user first. Save the GLB as `backend/src/bots/<bot>.glb`.
1. **Inspect** the model: `bun .claude/skills/glb-bot/scripts/glb-info.ts backend/src/bots/<bot>.glb`. It prints compression, primitive layout, the node chain, materials, texture sizes, skins and animations, the baked size, and warnings for anything the bake can't decode. Deal with the `!` lines first:
   - **Unsupported compression:** Draco or meshopt (`EXT_meshopt_compression`). Decompress with gltf-transform first.
   - **Several meshes or primitives:** the bake reads one. Merge them first.
   - **Node rotations or matrices:** the bake handles translation and scale only.
   - **Over ~120k triangles:** set `triangles`.
   - **A skin** (Meshy auto-rig, Mixamo, a Blender armature): run `bun .claude/skills/glb-bot/scripts/skeleton.ts <file>.glb [--yaw=…]`. It maps the joints onto the runtime's parts, prints their pivots as a draft `rig` in baked units, and prints the sculpted arm angle (a T-pose idles with its arms out). `--rigged=<bot>` also bakes the skin's own weights instead of `classify` (references/meshy.md §4). Animations are ignored, because the runtime's poses are what must play.
2. **Measure** on orthographic grids normalised exactly like the bake (8.7 units tall, floor at 0, centred, X mirrored like Babylon's loader):
   ```bash
   bun .claude/skills/glb-bot/scripts/grid.ts backend/src/bots/<bot>.glb    # → .ui-check/glb-bot/grid-<bot>-{front-side,back-side}.png
   ```
   With a skin, start from `skeleton.ts`'s draft rig and use the grids only to check it and to measure what a skeleton lacks: the antenna, the visor, and the wrist at the cuff's centre. Otherwise read off the hip centre, neck, antenna base and ball, and each shoulder, elbow, wrist, hip joint, knee and ankle, plus the visor rectangle. Each panel's caption says which axis the ruler shows and which way it grows. Read every limb in at least two views, because a part hidden in one side view is visible from the other. Only use these grids for measuring: a perspective render misplaces depth by tenths of a unit, and ally's legs were wrong until the −X and back views were read.
3. **Write `CONFIG[<bot>]`** in `scripts/bake-bots.ts`: `rig`, `face`, `band`, `classify`, plus `triangles` and `scrub` when needed. See "Writing the config" below.
4. **Bake**: `bun scripts/bake-bots.ts <bot>`. Check its report:
   - **parts:** every bone should have vertices, and none suspiciously few (ally's foot had 0, which meant wrong leg depths).
   - **bridges dropped:** pairs like `forearm × thigh` are expected where parts touched. `antenna × upper` or `head × arm` near the shoulder mean a misclassification.
   - **capped holes** and **scrubbed texels:** informational.
5. **Check the segmentation**: `bun .claude/skills/glb-bot/scripts/probe.ts <bot> labels` renders four views with one flat colour per bone (palette in pipeline.md). Every colour should stay inside its part: no torso white on the boots, no head yellow on the shoulder pads or fingertips. Fix `classify` and re-bake until clean. This is the cheapest place to catch problems.
6. **Check the surface**: `bun .claude/skills/glb-bot/scripts/relief.ts <bot>` (add `head` for a close-up) renders a high-passed depth map of the baked mesh in four views. Flat grey is smooth surface, white is raised, black is recessed. Red lines are open edges, and the cyan line is the visor outline the runtime fills. It also prints the open-edge count and where the edges cluster. Shaded renders hide hairline cracks and caps at rest; the relief doesn't. Aim for `open edges: 0` and no jagged black lines or sharp-edged grey or white polygons. Fix them with "Fixing cracks" below, then re-bake.
7. **Check the motion numerically**: `bun .claude/skills/glb-bot/scripts/probe.ts <bot> --stretch` poses the real runtime mesh in every state and act and prints, per shot, the worst triangle stretch against rest and where. Over ×3 is a tear (crack, sliver, flap, streak) and fails the run; ×2–3 (`~`) is the outside of a hard bend. It catches what renders hide (inside the helmet, under an arm). Use the printed coordinates with "Fixing cracks".
8. **Register the bot** (only for a new name; re-bakes need none of this):
   - `robot-runtime.ts`: add the name to `BotName` and `BOT_NAMES`, and give it a `BOT_FACES` entry (see "Face" below).
   - `env.d.ts`: add it to `RobotModelName`.
   - `package.json`: add it to the `agentOrchestrator.robotModel` enum and enumDescriptions.
   - `webviewHost.ts`: add it to the `robotModelSetting()` allowlist.
9. **Verify the motion** (for cracks, `probe.ts <bot> --zoom <shot> [y] [scale] [x]` renders one shot close up from four square-on sides, aimed at height y and the bot's x):
   - `bun .claude/skills/glb-bot/scripts/probe.ts <bot>` renders every state mid-loop, every act, and four avatar faces.
   - Look closely at the poses that move limbs far from rest: `happy` (wave), `working` (arms forward), `stretch`, `check-hand`, `walk 0.3`, `dance 0.3`. Render one large with `probe.ts <bot> working`.
   - At thumbnail size, streaks and holes look like texture noise, so judge from the large render.
10. **Build and check**:
   - Run `bun run build:webview && bun run typecheck`.
   - Report `ls -la media/bots` and the bundle size.
   - Run the procedural robot preview so it doesn't regress: `CHROME=... bun .claude/skills/robot-3d/scripts/preview.ts --shot`.
11. **Log it**: add a note to `docs/progress.md` (newest first, local time with offset), with sizes before and after.

## Writing the config

- **`rig`**: joint pivots in baked units. `shoulder`, `elbow`, `wrist`, `hipJoint`, `knee` and `ankle` are `[side −1 (−X, viewer's right), side +1 (+X, viewer's left)]`. Pivots are where the part rotates, so put the elbow at the centre of the elbow joint, not at the surface. `hip` is where the whole upper body leans (the pelvis). `antenna` is the stalk's base and `antennaBall` is the ball's centre and radius (a glow cap is drawn over it).
- **`classify(p, rig, lum)`**: hard part label per vertex; the bake adds joint blending afterwards. Pick the style that matches the pose:
  - *Upright, limbs apart* (jocy): axis-aligned rules. Antenna by distance to its axis above the head. Head by `y > neck`. Arms by `|x|` outside the torso's width. Legs below the pelvis, split by the sign of x, with thigh, shin and foot by knee and ankle height. Boots that touch in the middle need splitting by side alone below the knee.
  - *Dynamic pose* (ally): an ellipsoid for the head, then `nearestPart` (each part as a polyline capsule with a radius; lowest distance/radius wins). Exclude the torso below the pelvis so thigh backs don't go to it.
  - `lum` (base-colour luminance 0..1 at the vertex) separates parts that touch but differ in colour, such as black hands against white thighs.
- **`band`**: blend half-width across each joint (0.14–0.16). Wider means softer bends but more torso pulled along by the shoulder.
- **`smooth`** (0.45 on every bot): smooth skinning. After the hard labels and joint bands, weights diffuse over the surface between parts that share a joint, within 1.5× the joint's reach of its pivot, keeping the three strongest bones per vertex. Label boundaries then bend gradually instead of tearing. Wider (0.6) measures smoother but softens the shape (torso corners follow the arms).
- **`triangles`**: decimation target for big meshes (≈ 60–80k keeps silhouettes and keeps the `.bin` ≈ 1.5 MB). meshoptimizer keeps UV seams and normals.
- **`scrub(centroid, part)`**: which triangles carry paint from a part that used to rest on them. Meshy bakes a hand's black onto the thigh under it, and it shows once the arm moves. Keep the region tight (a box around where the hand rested) so legitimate dark details like knee rings and hip joints survive.
- **`face`**: the visor rectangle on the head's front (centre x/y, width, height, squircle exponent), measured on the front grid. The face patch is cut from head triangles inside it that face +Z.
  - If the visor is a **sculpted recess** (a raised rim around a dip, as on Vally), set `recess: true` and give a rough centre and size. The bake traces the recess from the mesh's relief and writes its exact bounds and `outline` into the header. The runtime then cuts a padded patch and draws the glass to that outline in the texture, so the edge is a smooth curve rather than the decimated triangles' sawtooth. The bake also stores the rim lip as a 3D path (`face.rim`), and the runtime runs a smooth bezel tube in the shell's material along it. That gives the glass a clean edge line and hides the decimated lip, whose jagged silhouette otherwise speckles the glass edge where the lip overhangs it. Check the cyan line in `relief.ts <bot> head`, and the bottom edge in a head-down pose (`error`).
- **`strictSeams`**: set it for meshes where a limb is sculpted welded to the body away from its joint (arms pressed into the torso, a hand on the hip). Without it, those welds stretch into sheets when the limb swings. See "Fixing cracks".
  - **`dropBridges`**: with `strictSeams`, still drop bridges (triangles between unlinked parts) instead of reassigning them. Use it when the bridges span gaps rather than contact (Meshy's claw tips beside the thighs), or they ride along with the limb as slivers.
- **`shoulderAxis`**: the shoulder blend's axis for side +1 (mirrored for −1), when the arm leaves the torso in a different direction than it hangs (Meshy: `[1, -0.25, 0]`, sideways). With the default (shoulder → elbow), the torso side below the shoulder blends onto the arm and peels off as white flaps when it lifts.
- **`mirror`** `{ from, plane }`: make the bot symmetric when one limb is sculpted mid-action (Jarvis: `{ from: -1, plane: -1.05 }`, its finger-gun arm and set-back leg replaced by the mirrored fist arm and planted leg). It runs last, after `headPose`, on the skinned mesh: side `from` is copied across x = `plane` (measured units) with skin, labels and pivots, head included, so a turned head is levelled first and no seam is left between a mirrored collar and an unmirrored helmet. The bake prints the levelled helmet's centre line; the face centre moves to the plane. Pick the side whose pose is closest to arms down, legs planted. Afterwards a per-arm `raiseMax` can be symmetric.
- **`dropHands`** + **`handTransplant`** `{ from, roll, fingers: { palm, radius, tips } }`: when one sculpted hand is a fused fist and the other has real fingers (Jarvis: −X fist, +X open pointing hand), cut both hands off at the wrist plane (crossing triangles clipped, so the rims are planar) and copy side `from`'s hand, mirrored, onto the other wrist; `mirror` then copies it back, so both hands are the original sculpt and texture. Its extended fingers get bones (`index`, `middle`, `thumb` ±1, children of `hand±1`): the mesh pieces farther than `radius` from `palm` (the repulsor's centre), matched to the nearest `tips`. Measure them with `DUMP_HAND=hand+1 bun scripts/bake-bots.ts <bot>` (writes `.ui-check/hand-dump.json`: hand vertices and triangles). The bake prints each finger's knuckle; the runtime turns each about its baked axis by `FINGER_CURL` (`rest − gain × grip`, clamped to `FINGER_RANGE`: Jarvis's fingers stay spread, only flexing slightly). `cut` moves the source cut past that gauntlet's rim shards and `sink` tucks the placed wrist up under the cover; the wrist cut rims are left uncapped (the double-sided shell shows its own inside instead of a pale flat cap). Check `idle`, `thinking` (fist), `working` and `happy` large, and the wrist with `--zoom idle <wrist y> 0.17 <wrist x>` (packed x). To take the hand from **another model** (Jarvis: `ironman.glb`'s open four-digit hand), set `handTransplant.donor` `{ file, keep: { axis, at }, wrist, toward, triangles, repulsor }`, measured in that model's `grid.ts` frame (`DUMP_DONOR=<file>:x0,y0,z0,x1,y1,z1 bun scripts/bake-bots.ts <bot>` dumps a box of its vertices). The hand in front of the `keep` plane is clipped out, its back closed with a domed plate, decimated, and painted with two texels of the bot's own texture (`pickPaint`: shell colour, cyan repulsor). It is laid along the target forearm by its own axis (`wrist` → `toward`), so a hand bent back at the wrist still hangs straight; tune `roll` so the palm faces the thigh. When the fist's gauntlet flares down past the wrist, add **`cover`** `{ side, y, x }`: that side's fist is cut out from under the cover (split at the cover's level rim `y` and its outer side plate `x`) instead of at the wrist plane, so the original cover stays over the new hand (compare with `grid.ts … --cx=<wrist x>` back/side views).
- **Untextured models** (Ironman): **`paint`** `{ swatches: { name: { rgb, rough, metal } }, region(point, normal) → name }` paints by position. The bake splits triangles exactly where a region boundary crosses them (bisection), so colour edges are clean even on a decimated mesh; it writes a tiny palette texture (`<bot>-color/mr.webp`) and a `glow` rule lights the glowing swatches. Write regions as position tests (front half of a capsule, a box on the faceplate), not per-triangle normals, which speckle on a bumpy sculpt. A quantized source (8-bit normals) may need `weldDot: -1` and `simplifyError` to reach `triangles`. **`paint.project`** `{ image, camera: { matrix, eye }, minFacing, keep }` paints from the art the model was generated from (Ironman: `backend/src/bots/ironman-ref.png`) wherever that image sees the surface: fit the camera with `bun .claude/skills/glb-bot/scripts/project-fit.ts backend/src/bots/<bot>.glb <ref.png>` (perspective, silhouette IoU; aim for ≥ 0.93 and check the green/red/blue overlay), paste its `camera`, and the bake projects UVs into the cropped image (background filled from the nearest character colour) with the palette in a strip below. Unseen and edge-on surfaces keep the region swatches, so tune those to the art's mid-tones; `minFacing` 0.5 stops grazing surfaces smearing highlights into streaks; `keep: ["glow"]` leaves glow discs flat. The bot is drawn without ACES tone mapping (`project.exposure`, header `art`), which crushed the art's reds to crimson. **`project.blocks`** `{ classify(r, g, b) → swatch, fallback, spread, smooth }` paints block by block instead: the art's clearly seen pixels seed a swatch per triangle, a least-cost fill where crossing a sculpted groove (relief depth) is expensive spreads them so colours meet at the plates' seams and hidden sides take their plate's colour, `spread` caps small parts (Ironman: gold 0.45, steel 0.45, glow 0.15), and `smooth` snaps fringes to seams. Classify only true colours (white highlights are not glow). **`fingers`** `{ side, palm, radius, tips }` rigs a model's own open hand in place (pieces beyond `radius` from the palm, matched to `tips`).
- **`yaw`** (degrees): for a source turned away from +Z (Jarvis: 50). The bake turns the model about Y before normalising. Measure with `grid.ts --yaw=<same>`; `--cx/--cz` centre a zoomed `--y0/--y1` window off the centre line, and `--beta=110` looks up from below (e.g. at a tucked-chin face).
- **`origin`** `[x, z]`: the body's vertical axis in the measured frame, when one flung-out arm drags the bounding-box centre off the body (Jarvis: `[-1.05, -0.2]`). Only the packed mesh, rig and face are shifted, so keep measuring in grid units. Without it, turns orbit empty space and the hero `--fit` clips.
- **`headPose`** `{ pitch, yaw, pivot? }`: re-sculpt a head that looks down or aside (Jarvis: −0.36, −0.36 about a pivot under the helmet's back rim) instead of counter-rotating it at runtime. Vertices move by head weight, welded copies move together (otherwise expect open edges at the collar), and the face spec follows the head.
- **`glow(r, g, b)`**: an emissive map derived from base-colour texels, for a model without one (Jarvis's arc reactor and palm repulsors). `glowOff: { parts, ink }` switches it off on some parts and repaints that paint in `ink`. Jarvis's painted eye slits sit deep under the brow and glowed like a grin, so they are repainted as dark slots and the live eyes glow in them.
- **Faceplate faces** (Iron-Man style, Jarvis): `FaceRig.mask: true` drops the glass and the mouth and draws dark sockets under the live eyes. `cover` paints painted features over in the plate's colour; Jarvis's painted slits sat low on the mask and read as a grin, its live eyes sit in the sculpt's eye slots under the brow ridge; higher, on the brow's curved lip, they squashed into flat bars. Use `style: "slit"` eyes, and set `faceYaw` when the visor's mean normal misleads. A visor tilted down more than ~9° automatically gets a lower avatar camera (`avatarBeta`); set `FaceRig.avatarBeta` when the estimate misses (Ironman: 1.85, its flying head tips forward).
- **Measure the arm path, not just the joints.** Slice the baked arm vertices by height (mean x/z per 0.2 in y) and put `wrist` at the cuff's real centre. Meshy's wrist was 0.6 too far out, so the forearm swung on the wrong axis and the waving claw pointed sideways. For curved or hose arms, label with capsules along the measured polyline, and gate them by |x| in the gap between the thigh's outer shell and the claw.

## Fixing cracks

Cracks are hairline black lines or open (red) edges in the relief. They happen when a triangle spans two labels that the bake treats as unrelated, and the triangle gets removed or capped. Work through these in order, re-baking and re-running `relief.ts` after each:

1. **Turn on `smooth` and `strictSeams`** (all four bots have both). A cross-part edge is a *joint seam* if the parts share a joint and it lies near the pivot; there weights blend. Every other cross-part triangle (a weld or bridge: parts that merely touch) goes wholly to its most-parent part (the torso over an arm), and its other corners are duplicated onto that bone. The surface stays closed at rest, nothing is dropped or capped, and in motion the triangle moves rigidly instead of stretching. The bake prints `welds reassigned: N` and should cap 0 holes.
2. **A crack inside one limb** (a jagged line across an upper arm): two labels meet away from the joint, usually because capsule radii decide arm vs forearm. Pick the side by nearest capsule, then split upper arm from forearm by the elbow's bisector plane (`dot(p − elbow, toWrist − toShoulder) > 0`). With `strictSeams`, the elbow blend uses that same bisector axis, so the boundary always sits inside the blend, even on a sharply folded elbow.
3. **A crack across the head or ears**: the head shape (an ellipsoid) stops short of the real helmet, so its underside or the ear bottoms get the torso label. Label everything above the neck collar as head (minus any hand that reaches up there). Don't add an "outside the torso shell" rule below the collar: on Vally it split the collar and shoulder tops into patches that tore into a fringe when the head tipped (`error`).
4. **A crack where a limb touches the body**: a "keep it on the torso" rule (a shell or socket test) is grabbing the limb's own surface. Require clearance from the limb axis bigger than the thickest joint ball (≈ 0.55 on Vally), and drop socket rules that cut through the limb.
5. **Locate a stubborn crack**: the printed clusters give coordinates. List the labels and blend state of vertices in that box (read the `.bin`: joints, then weights). Two pure labels meeting with no blend is the crack.

Then verify with `probe.ts <bot> --stretch` and the large renders. Reassigned welds can leave a small opening on a limb's inner face when it swings well away from the body, mostly hidden. If a sculpted-raised limb swings into the head, cap that arm's lift with the runtime's `raiseMax` (Vally: `[1.2, 0.35]`).

## Correcting in Blender

When rules can't get a part right (a fused sculpt, an odd pose), correct it by hand:

1. `bun scripts/export-rigged.ts <bot>` writes `.ui-check/glb-bot/<bot>-rigged.glb`. It's a standard skinned glTF (Khronos-validated): the baked mesh, an armature whose bones are the runtime parts (`upper`, `head`, `antenna`, `arm±1`, `forearm±1`, legs when used) with joints at the rig pivots, the smoothed weights, and the textures as PNG.
2. In Blender, import it (File → Import → glTF), fix weights in Weight Paint, move a bone's head to move its pivot, or edit the mesh (e.g. add edge loops). Keep the bone names. Export glTF Binary to `backend/src/bots/<bot>-rigged.glb`. FBX export is also possible from there for other tools.
3. `bun scripts/bake-bots.ts <bot>`. It prints `rigged input: …` and takes weights and joint positions from the file. It skips merging, simplification, labelling, smoothing, seams and paint scrub, and keeps `face`, `antennaBall`, `wrist` and the textures pipeline. Delete the `-rigged.glb` file to go back to the rule-based bake.

Re-baking an unedited export reproduces the bot (same vertices, pivots within 0.001), so the round trip is safe.

## Face

A bot's face is three layers. The model provides only the head and a blank screen (the `face` rectangle in the bake config, or a traced recess). The runtime draws the eye layer and the mouth layer on anchors from the bot's `FaceRig` (`BOT_FACES` in `robot-runtime.ts`), and the glass covers any painted features.

**`FaceRig`** (all positions are screen fractions: 0..1 across from the viewer's left, 0..1 down):
- `eyes: { left: [x, y], right: [x, y], size, style: "oval" | "ring" | "dot", aspect? }`. Each eye has its own anchor, so a turned or tilted visor works. Place them over the painted eyes; size is the radius as a fraction of screen height.
- `mouth: { at: [x, y], scale }`.
- `palette: { eyes: { blue, red }, mouth? }`. `mouth` is a separate colour for the normal tone only; error turns everything red.
- `wire?: { <preset>: <preset> }` is the bot's personality: wherever one preset plays, another's shapes show (gaze, lids and motion stay). Current wiring: Vally `happy → love`, Ally `joy → laugh`, Jocy `surprised → love`, Meshy `thinking → confused`.

**Expression presets** (`EXPRESSIONS`):
- **The list:** neutral, happy, joy, laugh, love, surprised, curious, thinking, focused, listening, talking, sleepy, yawn, wink, smug, shy, confused, sad, angry, dizzy, error.
- **What a preset is:** an eye shape, a mouth shape, and optionally a wink or a tone.
- **Eye shapes:** open, wide, happy, squint, focus, sleepy, sad, heart, angry, cross.
- **Mouth shapes:** smile, grin, laugh, o, talk, dots, flat, smirk, wavy, frown.
- **How states and acts use them:** each state and act tags its face (`face.expression = "joy"`, or `express(face, "joy")` to apply the shapes too) and adds motion on top: gaze, blinks, talking, laugh opening.
- **Forcing one from a host:** `data-robot-face="love"` on the hero canvas.
- **Adding a preset:** add an `EXPRESSIONS` entry. A new shape also needs a case in `drawEyes` or `drawMouth`.

**Face motion** (`faceMotion`, hero only) runs over whatever preset plays:
- the eyes lead head turns and nods;
- squash and stretch follow the body's height, so flying and landing count;
- a reflex blink on fast turns, and saccade glances while still;
- a blink-through when the eye shape changes, and a squeeze-in when the mouth changes.

**Checking:**
- `probe.ts <bot> --faces` renders every preset through the bot's rig, marking wired ones `a → b`.
- `probe.ts <bot> --motion <act>` plays an act at 30 fps with all the springs.
- If the live face doesn't show at all, the patch is culled or under the paint; it is double-sided with `zOffset −2`.
- If a painted eye still shows beside a live one, widen `face` and move the anchors.

## Locomotion: walk, fly or both

`BOT_LOCOMOTION` in `robot-runtime.ts` (copied to `robot.locomotion`) says how a bot moves:
- **`"walk"` (Jocy, Meshy, the procedural robot):** legs step. The idle acts never include `fly`.
- **`"fly"` (Vally, no legs):**
  - always hovers via `locomote`/`hover`: `pose.lift` ≈ 0.5 with a slow drift, legs dangle if there are any;
  - the walk act is dropped, and `dance` and `turn-around` glide instead of stepping;
  - `fly` is a swoop that climbs a little, banks into the turns and faces the way it flies.
- **`"both"` (Ally):** stands and walks; the `fly` act crouches, takes off, flies a path, and lands with a squash.

**Flight paths** (`flightPath(seed, grounded)`): each `fly` act draws a fresh seed (never the same shape twice in a row) and follows a random path that starts and ends at the bot's spot.
- **The shapes:**
  - *wander*: a smooth line through 3–4 random waypoints, alternating sides;
  - *loop*: a loop-the-loop to one side;
  - *figure-8*: side to side while swooping toward the camera and back (`pose.z`);
  - *zigzag*: three diagonal legs.
- **What the seed varies:** the direction (left or right), the size, and the waypoints.
- **How the bot flies it:** it turns to face sideways travel, banks into the curve's sideways acceleration, leans back when climbing and forward when diving, and its eyes look where it's going.
- **Fitting the frame:** sizes keep the bot in the hero frame; fliers get about 60% of the width and half the height.
- **Checking:**
  - `probe.ts <bot> --paths` plots three seeds of each shape, front and top;
  - `probe.ts <bot> --motion fly <seed>` replays one flight.
  - `probe.ts <bot> --fit` plays every state, act and 12 flights on the chat window's real 170×300 hero canvas and reports each run's smallest margin to every edge; it exits 1 if anything is clipped. Framing (`heroFrame`: arm reach, floor, `FLY_ROOM`) and flight size (`heroRoom`) are what keep it inside.

`pose.lift` raises the whole root. The hero's contact shadow stays on the floor and shrinks and fades with height, and the neck and face springs feel the take-off and landing. Avatars never fly, so the head stays framed. A legless bot must still park its unused leg pivots below the floor in the bake config, so that no body vertex is skinned to a leg.

## Done means

- The label view is clean, the bake reports no unexpected bridges, and every bone has vertices.
- The relief shows `open edges: 0` (or only expected ones), with no cracks or cap patches, and the visor outline hugs the rim.
- `probe.ts <bot> --stretch` reports no tears, or only hard bends you have looked at in the large renders.
- The large `working`, `happy` and `stretch` renders show no streaks, black shards or floating fragments. The face sits on the visor and blinks, talks and turns red on error, and the antenna glows.
- Avatars show the head with a readable face at 48 px.
- Typecheck passes, the procedural preview reports `errors: none`, sizes are reported, and the progress note is added.
