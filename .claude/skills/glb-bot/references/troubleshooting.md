# GLB bot troubleshooting

Match what you see, then fix the cause, not the symptom. All of these happened while converting jocy and ally.

## Geometry while moving

| Symptom | Cause | Fix |
| --- | --- | --- |
| Long thin streaks from a moving hand down to the hip or boot | A triangle joins two parts that no joint connects. Either the remesher welded the hand to the thigh (a bridge), or fingertips were labelled as thigh and stay behind | Check the bake's `bridges dropped`. If the pair is real contact, removal is correct. If fingertips were mislabelled, widen the arm rule (outside the leg's width, below the hip) or use `lum` (dark hand against a light leg) |
| Black jagged shards on the thigh or torso once the arm moves | Holes where a fused hand was, showing the dark inside of the mesh | Hole caps (automatic). If shards remain, the loop crossed several parts and was split; make sure both sides are labelled cleanly in the label view |
| Black hand-shaped *paint* on the thigh (smooth edges, no hole) | The model's texture painted the hand's colour onto the leg underneath | Add or widen `scrub` around where the hand rested |
| White jagged fragments flapping beside the torso | The forearm's inner face and the torso side are mixed (the cutoff sits on the boundary) | Move the cutoff to where the limb really starts (jocy: `|x| > 1.12` below the shoulder pads, not 1.03) |
| A thin sheet stretched from one part to another | A cap fan spans a loop touching two parts | Already handled (loops are split per part); if it persists, a part label is wrong at the loop's border |
| The torso bends with the shoulder | `band` too wide, or the shoulder pivot is inside the torso | Narrow `band`, or move `rig.shoulder` out to the joint centre |
| A limb bends at the wrong place | Pivot misplaced, usually in depth (z) | Re-measure on the grids, reading two views |
| The whole leg or boot doesn't move | Labelled `upper` (the torso swallowed it) | Exclude the torso below the pelvis (`y > 2.2` for ally) and check the part counts |
| A part has 0 vertices in the bake report | Its capsule or rule never wins | Wrong joint coordinates (ally's feet were behind the body, not in front) |

## Stretch report (`probe.ts <bot> --stretch`)

| Report | Cause | Fix |
| --- | --- | --- |
| Tears (×5 and up) at one spot in many shots, even `idle` | A label boundary far from any joint, or a part labelled wrongly (Ally's helmet back as torso) | Fix `classify` there; with `smooth`, boundaries near the pivot blend by themselves |
| A long streak from a limb to the body in one pose | One vertex weighted to a part it isn't on. Check its label and weights at the printed spot | Before the label-aware merge: a UV seam split labels. Otherwise a wrong `classify` rule |
| ×3–5 on the outside of elbows and shoulders in `stretch`, `happy` | A hard bend, not a tear | Larger `smooth`, or accept it if the large render is clean |
| Contacts stretch like rubber after turning on `smooth` | Weight crossed where parts only touch | Keep the near-pivot limit and `strictSeams` (welds stay rigid) |
| Vertices share three bones (shoulder top under the head) and pull apart | Only two influences kept | Three are kept now; check the stride if it changes |

## Surface at rest (relief view)

Run `relief.ts <bot>` (add `head` for a close-up). These show there, often before they're visible in a shaded render. All of them happened on Vally.

| Symptom in the relief | Cause | Fix |
| --- | --- | --- |
| Jagged black line across a limb, no red | Two labels meet mid-limb, and the welds between them were dropped and capped | Split the limb at its joint plane (elbow bisector), not by capsule radii; turn on `strictSeams` so welds are reassigned rather than dropped |
| Jagged crack across the lower head or through an ear disc | The head ellipsoid is smaller than the helmet, so those parts are labelled torso | Head = everything above the neck collar (minus hands), plus the helmet underside outside the torso shell |
| Red open edges along a limb/torso contact | Weld or bridge triangles dropped and the cap loop failed (too long, or several parts) | `strictSeams` (reassign instead of drop) |
| Sharp-edged white or grey polygon on the body | A cap fan over a dropped bridge region | `strictSeams`; otherwise clean up the labels at that spot |
| Crack where an arm meets the torso, on the arm side | A torso-shell or socket rule claims the arm's own surface | Raise the limb-clearance distance above the joint ball radius; remove socket rules |
| Cyan visor outline cuts into the rim or leaves a gap | The face rectangle or squircle doesn't match the recess | `face.recess: true` (traced outline) |
| `open edges` in the hundreds near one joint | A label boundary sits outside that joint's blend band | Move the boundary into the band (same-plane split), or widen `band` |

## Face and antenna

| Symptom | Cause | Fix |
| --- | --- | --- |
| Painted face only, expressions never change | The face patch was back-face culled (the body is double-sided; the patch copies its triangles), or it z-fights the paint | The patch is double-sided with `zOffset −2` for every bot |
| Holes in the live face on a flat screen made of a few big triangles (Meshy) | An all-corners-inside test drops triangles whose corners sit on the bezel | The patch takes triangles by centroid; textures clamp, so corners outside show clear |
| One painted eye still shows beside the live one (turned visor, Ally) | The face rectangle is narrower than the painted eyes, or the surface there faces away (normal z < 0.25) | Widen `face` and rescale `BOT_FACES` to keep the eyes in place; the patch accepts normals down to z 0.05 |
| Two sets of eyes | The live face isn't over the painted face | Fix `BOT_FACES` `eyeX`/`eyeY`/`eyeR`, or the `face` rectangle in the config |
| No live face at all | No head triangles inside `face` face +Z (wrong centre, or the visor isn't labelled head) | Measure the visor on the front grid. Check the head colour covers the visor in the label view |
| Face patch flickers or z-fights | The visor is concave or deep | Raise `lift` in `buildBotFace` slightly (0.02 → 0.04) |
| Visor edge is a sawtooth, or the glass doesn't reach the rim | The patch edge follows decimated triangles, or a hand-fitted squircle doesn't match the recess | `face.recess: true`: a traced outline drawn in the texture on a padded patch. If the edge is still ragged with the depth test off, the trace is noisy (it is smoothed with a rolling max, then a moving average) |
| Glass hides under a ragged rim lip | The decimated rim overhangs the groove | Keep `zOffset` on the patch and trace the outline to the rim's inner edge (grow 1 cell) |
| Speckled light/dark dots along the glass edge (worst at the bottom, head tipped down) | The decimated lip's jagged silhouette really is in front of the glass; `zOffset`, mipmaps and normal filters don't change it | The bezel tube along `face.rim` covers it with a clean line, like the reference's white rim |
| Dots along the bezel's inner side | Glass tucked under the tube wins the depth test in spots (zOffset is slope-scaled), or lip spikes poke through the tube | End the glass at the tube's inner side (outline inset 0.06); keep the tube above the lip's rolling-max height. Hide the glass in a debug render to tell which |
| Eyes take the mouth's colour (lavender-white, or magenta when emission-only) | `drawFace` set the fill to `mouthColor` and the next glow pass drew the eyes with it | Fixed: each pass resets to the eye ink. A separate `mouthColor` applies only to the blue tone, so error turns the whole face red |
| White flaps peel off the torso's top corners when an arm lifts | Shoulder blend axis (shoulder → elbow) points down the torso side, so torso vertices just below the shoulder weigh onto the arm | `shoulderAxis` along the direction the arm leaves the torso |
| White sliver rides beside a raised claw or hand | A piece of the thigh's outer shell is labelled forearm (arm gate too close to the leg), or `strictSeams` reassigned a long gap-spanning bridge | Map forearm vertex density by x/y and gate the arm rule in the empty column; `dropBridges` |
| Hand or claw points the wrong way when the arm moves | `rig.wrist` (or elbow) off the limb's real centreline, so the forearm rotates about the wrong axis | Slice the arm vertices by height and re-place the pivots; don't cap `raiseMax` to hide it (on Meshy a lower cap made the arm stick straight out) |
| Ragged fringe beside the neck when the head tips | Collar or shoulder-top vertices split between head and upper by a rule below the collar | Head = above the collar only; weld triangles go to their majority part |
| Antenna glow ball floats beside the antenna | `antennaBall.at` is wrong, or the antenna verts aren't labelled antenna | Re-measure the ball on both side views; widen the antenna rule's radius |
| Antenna base tears off the head | The antenna rule is too tall, or `rig.antenna` sits above the base | Put `rig.antenna` at the stalk's base; the head ↔ antenna joint blends there |

## Loading and rendering

| Symptom | Cause | Fix |
| --- | --- | --- |
| Hero shows the procedural robot instead of the bot, only inside VS Code (probes are fine) | The webview CSP blocks WebAssembly, which the meshopt decoder for `.bin` v2 needs. The canvas shows `data-robot-loaded="fallback"` and `data-robot-error` names the CSP | Both webview CSPs (`chatWindow.ts`, `webviewHost.ts`) need `'wasm-unsafe-eval'` in `script-src`; it allows WebAssembly only, not JS eval |
| Hero shows the procedural robot instead of the bot | Asset fetch failed (fallback) | In VS Code: `connect-src` missing from the CSP, or `media/bots` missing from `localResourceRoots`. In previews: page opened via `file://` (fetch can't read it), so use `probe.ts` (it serves over HTTP) |
| Texture black or missing | Texture not ready when rendered, or file name mismatch | `whenReadyAsync()` before rendering. Check `header.textures` names exist in `media/bots` |
| Bot mirrored (thumb on the wrong side, text reversed) | X mirror skipped or applied twice | The bake mirrors once, like Babylon's loader; grids use the loader, so they match the bake |
| Bot looks tiny in the welcome canvas | Very wide pose; `botFit` backs the camera off to fit the width | Expected for spread poses (ally). Trim the outliers (e.g. the raised hand) only if the user wants it bigger |
| Avatar shows body bits under the head | `portrait()` collapses non-head bones at the neck; blended neck vertices remain | Fine at avatar size; if large, lower the neck blend (narrower `band`) |

## Source model and skeleton

Some problems are cheaper to fix in the model than in the bake. Regenerating costs Meshy credits, so ask first (references/meshy.md).

| Symptom | Cause | Fix |
| --- | --- | --- |
| Streaks, bridges or hand paint on the thighs come back after every `classify` fix | The hands are sculpted resting on the body, so the remesher welded and painted them together | Regenerate with `pose_mode: "a-pose"` (and `smart-topology` for separate parts) instead of piling up `scrub` / `strictSeams` rules |
| Bot idles with its arms straight out | Sculpted in a T-pose; poses are offsets from the sculpt, and skinning can't fold the arm ~80° down cleanly | Re-pose the arms in Blender, or regenerate in A-pose. `skeleton.ts` prints each arm's angle below horizontal |
| Dark blotches or highlights that don't move with the runtime's lights; `lum` rules misfire | Lighting baked into the base colour | Regenerate or `retexture` with `remove_lighting: true` |
| Shell looks flat and matte | No metallic-roughness or normal map in the source | `enable_pbr: true` when generating or retexturing |
| `skeleton.ts`: node positions differ from the bind pose | The file was saved in an animation frame, or the mesh was moved off its armature | Re-export at rest (Blender: clear the pose, apply). The draft rig (bind pose) is still right, but `--rigged` would read the posed nodes |
| `skeleton.ts` maps a joint to the wrong part, or a part owns no vertices | Unusual bone names (non-English, numbered chains) | Rename the bones in Blender to Mixamo-style names or to the runtime's (`arm-1`, …), or extend `role()` in `skeleton.ts` |
| A `--rigged` bot tears at the hips when the body leans | The source's Hips bone covers the pelvis and the tops of the thighs; `upper` now carries all of it | Use the draft rig with the normal bake (its hip blend and `strictSeams`), or repaint the thigh tops in Blender |
| Meshy `rig` refuses the model | Over 300k faces, or not a humanoid | `remesh` first (`target_polycount` ≈ 70k); otherwise skip the auto-rig and measure on the grids |

## Tooling

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No Chrome found` | No browser at the usual paths | Set `CHROME=/path`. With Windows bun under WSL, export it through `WSLENV=CHROME` |
| Screenshot blank or white | Chrome captured before the page finished (virtual time doesn't wait for large decodes or slow fetches) | Re-run. `grid.ts` avoids it by having the page return its own PNG |
| Texture resize hangs in a page | Same as the blank screenshot: `--dump-dom` fires at load | The bake uses sharp in Bun, not Chrome |
| `Cannot find package @babylonjs/core` | Dependencies not installed | `bun install` |
| A whole file shows as changed in git after an edit | It had CRLF line endings in the working tree | Match the file's existing line endings when editing; don't normalise unrelated files |
