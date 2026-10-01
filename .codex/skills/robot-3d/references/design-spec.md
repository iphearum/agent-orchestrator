# Robot design spec (from `target/3d-robot.png`)

Units are scene units with +Y up and the head width as the unit of measure (2.0). An `ArcRotateCamera` with `alpha = π/2` sits on **+Z** looking toward −Z, so the face (visor, eyes, mouth) goes on **+Z**, and **+X is the viewer's left**. Both caught us out: a face on −Z disappears inside the head, and a key light "from −X" lights the viewer's right.

Measure from the image, not from memory. 1 px in the 271×410 reference ≈ 0.0125 units (head ≈ 160 px wide). Check every change with `preview.ts --compare`. The numbers below are what `webview-ui/src/robot-runtime.ts` uses after that comparison.

## Silhouette and proportions

| Part | Reference look | Build (current values) |
| --- | --- | --- |
| Head | Deep rounded **cube**, barely wider than tall (≈1.1 : 1), big soft corners | `roundedBox(2.0, 1.82, 1.74, n = 3.3)` at y = 1.4. A scaled sphere reads as an egg; n < 3 reads as a pill. |
| Visor | Glossy near-black rounded rectangle, **thick white bezel** (≈ 0.25 on the sides, more at the bottom) | `roundedBox(1.48, 1.14, 0.36, n = 3)` at (0, −0.04, 0.72) inside the head node. |
| Eyes | Large round glowing dots, wide apart | Spheres ⌀ 0.29, z-squashed 0.45, at x = ±0.36, y = +0.06, z = 0.88. |
| Mouth | Wide, thick U smile | Tube along u ∈ [−1, 1]: x = 0.36u, y = −0.24 − 0.15(1 − u²); radius 0.048. |
| Ears | Blue rounded pucks, **low** on the head sides | `roundedBox(0.4, 0.78, 0.74, n = 2.6)` at x = ±1.04, y = −0.16. |
| Antenna | Very short stalk, fat blue ball almost on the head | Stalk ⌀ 0.1 × 0.14; ball ⌀ 0.36 at head +1.12. |
| Torso | White **rounded barrel** tucked under the chin; flat sides, soft top/bottom, slight base taper | `barrel(1.56, 1.62, n = 3.2, taper 0.08)` at y = −0.24. Not an egg. |
| Arms | Hug the torso like brackets: short upper arm out to a **thick ribbed elbow**, forearm down and in | Shoulder (±0.72, −0.12) → elbow (±1.16, −0.36) → wrist (±1.1, −0.8); tubes ⌀ 0.2, elbow ball ⌀ 0.3, 3 ribs ⌀ 0.3 on each side of the bend. |
| Cuffs | **Big** blue rounded cups at the torso's base line, tilted slightly | `barrel(0.66, 0.6, n = 2.6)` at (±1.04, −1.02), roll ±0.12, grey ring ⌀ 0.42 beneath. |
| Claws | Large grey open pincers "( )" hanging below the body | Two `clawFinger`s per hand, radius 0.31, thickness 0.085, 0.78π arc, bases ±0.1 apart. |
| Legs | **None** | It floats. |

## Pose

- Root yaw **0.4**, so the face turns toward the viewer's left and the head's right side and ear show. Head roll 0.07, pitch 0.04.
- Hero camera: beta 1.38, radius 9.4, target y 0.26, fov 0.6. The whole robot fills about 85% of the canvas height, with room for the idle bob.
- Avatar camera: beta 1.45, radius 5.3, target y 1.62. Head and antenna fill the 256² sprite.

## Palette

| Role | Hex | Material |
| --- | --- | --- |
| Shell (head, torso, stalk) | `#E8ECF2` | PBR roughness 0.3. Brighter values clip to flat white under the key. |
| Visor | `#0A0E16` | roughness 0.08 |
| Face glow | `#C8F2FF` | unlit emissive + `GlowLayer` 0.8 (hero only) |
| Accent blue | `#2F7BEA` | roughness 0.28 |
| Metal (arms, claws, rings) | `#A3ABB6` | roughness 0.36, metallic 0.55 |

## Light and finish

- ACES tone mapping, exposure 1.1. Without it the white shell is a flat silhouette.
- Hemispheric 0.5 with a cool ground colour `(0.45, 0.6, 0.72)`, which mimics the blue bounce in the reference.
- Key directional 2.6, direction `(−0.6, −0.75, −1)`: from the viewer's upper left-front. Rim 0.9, direction `(0.6, −0.2, 1)`.
- The reference's shading falls on the viewer's right side of the head and torso. If yours falls on the left, the light's X is flipped.

## Motion (hero only, off for `prefers-reduced-motion`)

Yaw ±0.07 around the base 0.4, bob ±0.05 on Y, blink (eye Y scale 0.12) for 140 ms every 4.5 s.
