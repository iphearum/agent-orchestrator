# GLB bot pipeline: conventions and internals

## Contents
1. Space and units
2. Bones and the rig
3. What the bake does, in order
4. `.bin` layout
5. Runtime side
6. How poses read on a bot
7. Label palette

## 1. Space and units

- **Babylon is left-handed and glTF right-handed.** Babylon's glTF loader mirrors X, so the bake does the same (negates x and normals, flips triangle winding). The bot then faces +Z, toward the default camera at `alpha = π/2`, exactly as it looks in the loader-based `grid.ts` renders.
- **+X is the viewer's left** in the front view. A bot facing the viewer has its **right** hand at +X.
- **Units:** the bot is scaled to **8.7 units tall** (`HEIGHT`, the procedural robot's standing height), with feet at y = 0 and the bounding box centred in X and Z. Hero framing, walk offsets (±0.5) and bob amplitudes are tuned for that height.
- **Sides:** arrays like `rig.shoulder` hold `[side −1, side +1]`, so index 0 is −X (viewer's right) and index 1 is +X. `Pose.arms[0]` and `Pose.legs[0]` drive side −1.

## 2. Bones and the rig

The bone order is fixed (`BONES` in `scripts/bake-bots.ts`, carried in the `.bin` header):

```
0 root  1 upper  2 head  3 antenna  4 arm-1  5 forearm-1  6 arm+1  7 forearm+1
8 thigh-1  9 shin-1  10 foot-1  11 thigh+1  12 shin+1  13 foot+1
```

`buildBot` builds the same pivot hierarchy as `buildRobot`:

```
root ─ upper (pivot rig.hip) ─ neck (pivot rig.neck) ─ head ─ antenna (pivot rig.antenna)
     │                       └ arm±1 (pivot shoulder) ─ forearm±1 (pivot elbow)
     └ thigh±1 (pivot hipJoint) ─ shin±1 (pivot knee) ─ foot±1 (pivot ankle)
```

- **Rest pose:** every node sits at the origin with a pivot point, so its rest matrix is identity. The skin's bind pose is therefore the baked mesh itself, and nothing needs an inverse bind.
- **Bones:** one parentless Babylon `Bone` per bone name. In `scene.onBeforeRenderObservable`, each bone's local matrix becomes its node's world matrix × the inverse of the root's world matrix. The nodes are computed parent-first, then each bone is marked dirty.
- **Why not `linkTransformNode`:** Babylon's linked bones copy the node's local position and rotation and ignore pivot points, so the hierarchy would rotate about the wrong places.
- **Wrist and hand:** there is no wrist bone. The hand is part of the forearm, which is enough for the runtime's poses because the procedural robot's claws only add finger detail.

## 3. What the bake does, in order

1. **Decode** the first mesh node's first primitive. Dequantise POSITION, NORMAL and TEXCOORD_0 (any component type, normalised or not, any byte stride), apply the node chain's translation and scale, mirror X and flip the winding.
2. **Normalise** to `HEIGHT` and apply `KHR_texture_transform` (offset + scale) to the UVs.
3. **Merge** vertices that share a position (and UV when textured) with normals within ~25°, averaging the normals. Exporters split vertices on tiny normal differences (Vally: 124k vertices on 60k positions), and split vertices are locked seams to the simplifier. Then **simplify** when `triangles` is set: meshoptimizer `simplifyWithAttributes` (normals as attributes, seams kept), then compact unused vertices.
4. **Classify** each vertex with `classify(p, rig, lum)`, where `lum` comes from sampling the base-colour texture at its UV.
5. **Blend joints.** For each joint (parent → child, pivot, axis from the pivot into the child, lateral reach), a vertex labelled with either part that lies within `band` of the pivot along the axis, and within `reach` of it sideways, gets `smoothstep` weights between the two parts. At most two influences per vertex.
5b. **Smooth skinning** (`smooth`): Laplacian diffusion of the weights on the position+label-merged vertex graph. A vertex only takes weight from its own part and parts it shares a joint with. Edges between parts only carry weight within `max(0.9, 1.5 × reach)` of their joint's pivot. Iterations = (width / mean edge)², capped at 400. Three strongest influences are kept. Nodes are merged by label too: brightness-based labels can differ across a UV seam, and merging them gave a thigh vertex forearm weights (Jocy's streak).
6. **Drop bridges.** Meshy and other remeshers weld touching parts into one surface (hands into thighs, boot to boot). A triangle whose corners belong to parts with no joint between them would stretch into a streak, so it is removed. The bake prints these as `bridges dropped: A × B count @ position`.
   - **With `strictSeams`**, nothing is dropped (unless `dropBridges`). The weld test is geometric: a cross-part edge is a joint seam only if the parts share a joint and the edge midpoint is within the smoothing limit of its pivot. Smoothed weights can't be used (every vertex carries small tails of neighbouring bones). Each weld triangle goes to its most-parent part. Every triangle whose corners share no bone through a joint blend (this covers bridges, and welds between linked parts away from their joint) goes wholly to the part owning most of its corners (the most-parent part, lowest `BONES` index, on a three-way tie). The other corners are duplicated with pure skinning on that bone. The bake prints `welds reassigned: N`. The elbow blend's axis also becomes the bisector of the elbow angle, matching a classify that splits arm from forearm on that plane.
7. **Cap holes** (with `strictSeams` there should be none). Vertices are welded by position (so UV seams don't count as borders), the open boundary loops are found, and each loop is split into runs of a single part, so a gap between two parts closes on both sides separately. Each run is closed with a fan on duplicated vertices. Those vertices keep the run's skinning and all share one UV (the loop vertex of median brightness), so a cap is a flat patch of the surrounding colour.
8. **Scrub hidden paint.** Inside the triangles `scrub` selects, texels darker than 0.4 luminance are repainted with the average light colour of the same triangle (or a neutral shell white).
9. **Textures:** colour, metallic-roughness, normal and emissive are resized to 1024² WebP (quality 88) with sharp.
10. **Pack** the `.bin` (below).
11. **Trace the visor** when `face.recess` is set: rasterise a front depth map around the rough face rectangle, high-pass it (depth minus the 17×17-cell neighbourhood mean), flood-fill the flat region from the centre, grow it 1 cell into the groove, and cast 180 rays from its centroid. The ray radii are smoothed (rolling max over 9, then mean over 9) to fill dents from decimated-rim noise. The header's `face` gets the recess bounds and `outline` (canvas fractions: 0..1 from the viewer's left, 0..1 down), plus `rim`: per ray, a point 0.05 outside the glass edge, at the highest surface from 0.04 inside to 0.16 outside it (the lip's top) + 0.03. Lip heights take a rolling max, then a mean, so the tube clears every decimated spike. The runtime runs a 0.11-radius bezel tube along it, in a clone of the shell material with `zOffset −4` (over the glass's −2), parented to the head. The glass is drawn 0.06 inside the outline, so it ends at the tube's inner side: glass tucked under the tube wins the slope-scaled depth bias in spots and dots the edge.
12. **Rigged input**: if `backend/src/bots/<bot>-rigged.glb` exists and its skin's joints are all named after BONES, it is read instead. Weights (top three) and joint positions (full TRS chain, normalised like the mesh) come from the file; merging, simplification, classify, bands, smoothing, seams and scrub are skipped.

## 4. `.bin` layout (version 2)

`[u32 header length][UTF-8 JSON header][pad to 4]`, then two meshopt-compressed streams (`meshoptimizer` encoder, after `reorderMesh` for cache and fetch order), the second at the next 4-byte boundary:

| Stream | Decoded | Bytes |
| --- | --- | --- |
| vertices | `header.stride` (20) bytes per vertex: position u16×3 (mapped to `header.position.min/max`), normal i8×4 (xyz/127), uv u16×2 (mapped to `header.uv.min/max`), joints u8×3 (BONES indices), weights u8×3 (/255) | `header.vertexBytes` |
| indices | u32 per index (`index32` says whether the runtime keeps them 32-bit) | `header.indexBytes` |

The header also carries `name`, `version`, `height`, `bones`, `vertexCount`, `indexCount`, `rig`, `face` (with `outline`/`rim` for a traced visor), `textures` and `emissive`. The runtime imports only the decoder file (`node_modules/meshoptimizer/meshopt_decoder.mjs`, ≈ 20 KB; the package root would add the encoder and simplifier wasm, +140 KB). If the layout changes, bump `version` and update `loadBotAsset`, `relief.ts` and `export-rigged.ts`.

Sizes after version 2 and the vertex merge: vally 4.18 → 0.97 MB, meshy 1.56 → 0.75, ally 1.53 → 0.75, jocy 0.32 → 0.17.

## 5. Runtime side

- **Where assets load from:** `BOTS_BASE` is `../../media/bots/` resolved against the runtime script's own URL (`dist/webview/robot-runtime.js`). Previews override it with `window.AgentRobot3DBotsBase`. Loading uses `fetch`, so the webview CSP needs `connect-src ${cspSource}`. The React webviews' `localResourceRoots` include `media/bots`; the chat window's root is the whole extension.
- **Material:** PBR with albedo; metallic-roughness (glTF packing: roughness in G, metalness in B); a normal map (`invertNormalMapX`, because of the X mirror); emissive; double-sided; ambient 0.25. There is no environment light, as with the procedural robot.
- **Face:** head triangles inside the `face` rectangle that face +Z (normal z > 0.25) are copied 0.02 along their normals and planar-mapped: u = 0.5 − (x − cx)/width, v = 0.5 + (y − cy)/height. The patch is textured like the procedural visor: a black glass albedo with a feathered alpha edge plus `drawFace(…, layout)`, and a cached emissive glow layer. It is parented to the head node. With a traced `face.outline` (Vally), the cut is the rectangle padded ×1.18 as a box, keeps groove walls (normal z > −0.3, z > 0), lifts 0.035, and the glass is the outline filled in the padded texture (no feathering). The face is drawn into the inner region, and `zOffset −2` keeps the decimated rim lip from showing through. `Robot.raiseMax` caps each arm's `raise` for bots whose rest pose already lifts an arm.
- **Antenna:** a plastic sphere slightly larger than `antennaBall`, parented to the antenna node. `applyPose` sets its colour and glow per state (red on error).
- **Framing:** `botFit` sets the hero camera distance so the bot's width fits a 0.56-aspect canvas, and the avatar camera so head + 40% of the antenna fill ~84% of the square. Avatars call `robot.portrait()`, which collapses every non-head bone to a point at the neck so only the head renders.
- **Failure handling:** if the asset fails to load, `mountBot` shows the procedural robot instead. `withStudio(model, …)` keeps one offscreen engine per model and disposes it after 15 s idle.
- **Model choice:** `HOST_MODEL` comes from `data-robot-model` on the script tag. `mount(canvas)`, `getAvatarSprite()` and `getAvatarSheet(state)` use it when no model is passed.

## 6. How poses read on a bot

- **Poses are offsets from the sculpted pose.** Joint rotations start from the bot's sculpted pose, not from a T-pose or arms-down pose. A bot modelled with an arm raised (ally) keeps it raised in idle, and the wave adds to it.
- **Leaving the sculpted pose:** rotating a limb more than ~90° away from it pinches the joint with two-bone linear blend skinning. If a bot must rest differently, change the model (re-pose it in Blender) rather than counter-rotating in code.
- **Head motion:** pitch, yaw and roll rotate about `rig.neck`. A huge head on a low neck (jocy) swings wide, which reads as cute. Raise the neck pivot if it clips the torso.
- **Legs:** they stay planted while `upper` leans. `walk` and `dance` move the thigh, shin and foot pivots; boots that are one rigid piece belong to the shin.

## 7. Label palette (`probe.ts <bot> labels`)

| Bone | Colour |
| --- | --- |
| root | mid grey |
| upper | white |
| head | yellow |
| antenna | magenta |
| arm-1 / forearm-1 | red / pink |
| arm+1 / forearm+1 | blue / light blue |
| thigh-1 / shin-1 / foot-1 | green / light green / dark green |
| thigh+1 / shin+1 / foot+1 | purple / lilac / dark purple |
| caps (added by the bake) | the colour of their part |

The four panels are front, from −X (the bot's left side), back, and from +X (its right side).
