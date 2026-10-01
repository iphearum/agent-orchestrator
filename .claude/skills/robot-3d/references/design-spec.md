# Robot design spec (from `target/3d-robot-full.png`, `target/3d-robot-head.png`, and `target/3d-robot-detail.png`)

Units are scene units with +Y up. The `3d-robot-head.png` close-up controls head and face proportions; `3d-robot-full.png` controls the standing silhouette and pose; `3d-robot-detail.png` guides the visible joints, armour seams, and shoe hardware. An `ArcRotateCamera` with `alpha = π/2` sits on **+Z** looking toward −Z, so the face (visor, eyes, mouth) goes on **+Z**, and **+X is the viewer's left**.

Measure from the correct reference: full robot **306×656 px**, head close-up **451×433 px**. Use `preview.ts --compare`; it shows the full reference and render at true size, freezes motion, and writes part crops to `.ui-check/parts/`.

## Head (current build, matched to `target/3d-robot-head.png`)

The straight-on close-up `target/3d-robot-head.png` (451×433) is the authority for the head. `preview.ts --compare` renders the runtime's preview-only `data-robot-view="head-front"` canvas beside it (`robot-head-compare.png`, plus `parts/h1–h5`). The numbers below were measured from its pixels (head ≈ 285 px = 2.0 units).

- Shell: Barr superellipsoid `1.9 × 1.7 × 1.3`, outline exponent 3.2, front/back exponent 3, 96 segments.
- **Recessed screen:** `visorRecess()` sinks the shell 0.08 inside a **squircle** (exponent 3.6) and eases out over a 0.07 lip. The screen grid lies on the carved surface. Size 1.43 × 1.1, centred at y −0.02 (75% × 65% of the head).
- Glass (canvas texture): deep navy `#0D1426 → #121B32 → #192640`, an edge vignette, dark bevel ring, soft top-left reflection and a faint band along the top. The emissive texture adds a faint navy self-glow so tone mapping doesn't crush it to black.
- Face (screen-relative): eyes r = 0.118 h at x 0.252 / 0.748, y 0.466. Smile: a quadratic curve from (0.265, 0.72) through control (0.5, 0.932) to (0.735, 0.72), line 0.055 h. Glow: blue `shadowBlur` passes 0.15 / 0.07 / 0.03 h.
- **Mirroring gotcha:** +X is the viewer's left, so the screen UVs use `1 − u`. A symmetric face hides a mirrored texture; the asymmetric gloss exposed it.
- Ears: rounded pads `barrel(0.5, 0.3, n = 3)` at x ±1.0, y −0.03, seen edge-on from the front.
- Antenna: grey collar plate ⌀ 0.52 plus a ⌀ 0.27 step, a gunmetal stalk ⌀ 0.126 × 0.2, a blue ball ⌀ 0.4 centred 0.42 above the head top.
- Neck: a silver coil spring (3.5 turns, radius 0.28, tube 0.034) around a dark core, from the torso top 0.64 to the head bottom 0.82.
- Pose in the hero view only: pitch −0.14 (looks up), roll −0.09, extra yaw 0.12. The head-front view zeroes these.

## Body (current build, matched to `target/3d-robot-full.png`)

`target/3d-robot-full.png` (306×656) is the authority for the full robot; `target/3d-robot.png` is an earlier legless concept. `preview.ts --compare` shows the reference beside the hero render at true size, with crops `parts/1–5` (head, torso and arms, hips and thighs, hands, shins and feet).

| Part | Build |
| --- | --- |
| Head | Head node at y 7.05, scale 1.15. Hero pose: body yaw 0.4, head extra yaw 0.2, pitch −0.14, roll −0.09 |
| Neck | Short coil spring from the torso top into the head |
| Torso | `taperedBox(1.9 × 1.13 × 1.08)` from y 4.49 to 5.62, base scaled 0.76 (broad shoulders, narrow waist) |
| Spine | Dark core plus 5 metal rib discs ⌀ 0.66, y 3.98–4.4 |
| Pelvis | Tapered metal housing, a ⌀ 0.54 ball beneath it, a ⌀ 0.44 hip axle (length 1.5) at y 3.68, blue rings ⌀ 0.48 at x ±0.56 |
| Legs (x ±0.72) | Smooth tapered armour shells over dark cores: thigh `0.98 × 1.1 × 0.88` centred y 3.08; shin `0.88 × 0.96 × 0.82` centred y 1.72. Narrow metal rims define shell joints. Knee: blue roller ⌀ 0.5 on an axle along X at y 2.38. Vent with blue slots on the back of each shin |
| Ankle | Metal drum ⌀ 0.5 × 0.72 along X at y 0.9, two seams |
| Feet | `foot` node offset outward 0.1 and turned out ±0.22: solid blue sole 1.12 × 0.18 × 1.58 with dark-blue grooves, grey rim, white toe cap, grey heel housing and strap |
| Arms | Shoulder drum at (±0.74, 5.72); `ribbedLimb` tube r 0.18 bowing out to a blue elbow `joint` (axle along Z) at (±1.42, 4.66); forearm r 0.165 down to a cuff at (±1.53, 3.74); then palm peg and ring claw |

Hero camera: beta 1.42, radius 18.5, target y = height/2 − 0.08, fov 0.5. The chat welcome box is tall to fit a standing robot: 170×300, then 104×180 at ≤360 px wide or ≤680 px tall, then 84×150 at ≤300 px wide.

## Palette

| Role | Hex | Material |
| --- | --- | --- |
| Shell (head, torso, stalk) | `#E8ECF2` | PBR roughness 0.3. Brighter values clip to flat white under the key. |
| Visor | `#0A0E16` | roughness 0.08 |
| Face glow | `#C8F2FF` | unlit emissive + `GlowLayer` 0.8 (hero only) |
| Accent blue | `#2F7BEA` | roughness 0.28 |
| Metal (arms, joints, claws) | `#D5DAE1` | roughness 0.2, metallic 0.32; darker values read as gunmetal without an environment map |

## Light and finish

- ACES tone mapping, exposure 1.1. Without it the white shell is a flat silhouette.
- Hemispheric 0.5 with a cool ground colour `(0.45, 0.6, 0.72)`, which mimics the blue bounce in the reference.
- Key directional 2.6, direction `(−0.6, −0.75, −1)`: from the viewer's upper left-front. Rim 0.9, direction `(0.6, −0.2, 1)`.
- The reference's shading falls on the viewer's right side of the head and torso. If yours falls on the left, the light's X is flipped.

## Motion (hero only, off for `prefers-reduced-motion`)

Yaw ±0.07 around the base 0.4, bob ±0.05 on Y, blink (eye Y scale 0.12) for 140 ms every 4.5 s.
