# Sourcing a bot with Meshy

Most bake fixes repair problems the model was generated with: hands welded to thighs, a hand's paint baked onto the leg, one arm sculpted mid-gesture, baked-in shadows, 600k triangles, no texture. When there is no model yet, or a model is cheaper to regenerate than to fix, generate it with settings that avoid these problems. This file comes from Meshy's MCP server (the `@meshy-ai/meshy-mcp-server` npm package, source at https://github.com/meshy-dev/meshy-mcp-server): its workflow guide, tool schemas and rig/download handling, as of v0.5.2. The parameters and prices are copied here, so the guide doesn't need the source. If a call is rejected, check the upstream repo, because parameters change.

## Contents
1. Ground rules
2. Settings that make the bake easy
3. Flows
4. Rigging: two routes into the bake
5. Tasks, results and downloads
6. Setup

## 1. Ground rules

- **Every call except `analyze_printability` costs credits.** State the cost and wait for the user's yes before each one (Meshy's own Rule 1). Never retry a paid call in a loop.
- **Decide formats before generating.** `target_formats` is fixed when the task is created. The bake only reads `["glb"]`; asking only for that also finishes sooner.
- **Ask which model to use.** `ai_model` differs per endpoint (below), and the cheap and best options differ 4–6× in price.

| Step | Credits |
| --- | --- |
| `text_to_image` (concept art) | nano-banana 3, nano-banana-2 6, nano-banana-pro 9, gpt-image-2 9 |
| `image_to_3d`, `meshy-t2` smart topology | 5 mesh, 15 textured |
| `image_to_3d` / `multi_image_to_3d`, `meshy-7` (`latest`) or `meshy-6` | 20 mesh, 30 textured; `ultra_mode` +5 |
| `text_to_3d` preview + `_refine` | 20 + 10 (`meshy-6`/`latest`; text-to-3d has no `meshy-7`) |
| `remesh` | 5 |
| `retexture` | 10 (15 at 8k) |
| `uv_unwrap` | 5 |
| `rig` (walk + run included) | 5 |
| `animate` | 3 (not useful here: the runtime has its own acts) |

## 2. Settings that make the bake easy

| Parameter | Use | Why, in bake terms |
| --- | --- | --- |
| `pose_mode` | `"a-pose"` | Limbs stand apart, so there are no hand↔thigh bridges, no hand paint on the thighs (`scrub`) and no sculpted gesture to `mirror` away. **Don't use Meshy's `"t-pose"` advice.** The runtime animates *offsets from the sculpted pose* (pipeline.md §6). A T-posed bot idles with its arms straight out, and lowering them is more than the ~90° that two-bone skinning bends cleanly. `skeleton.ts` prints the sculpted arm angle. |
| `model_type` | `"smart-topology"` (`ai_model: "meshy-t2"`) | Native part separation: limbs come out as separate pieces instead of one welded shell, which is what `strictSeams` and bridge handling work around. It is a quarter of the mesh price. Image-to-3d only (one image). |
| `target_polycount` + `topology` | `70000`, `"triangle"` | Arrives at bake density (60–80k). The count is in faces, so quads mean twice the triangles. It also has to stay ≤ 300k for `rig`. On meshy-6/7 set `should_remesh: true` (its default there is false). |
| `remove_lighting` | `true` (default on meshy-6 / `latest`) | Shadows and highlights painted into the base colour fight the runtime's lights, and they skew the `lum` that `classify` and `scrub` read. With meshy-7, pass `ai_model: "meshy-7"` explicitly, because `remove_lighting` with `latest` falls back to Meshy 6. |
| `enable_pbr` | `true` | Adds metallic-roughness and normal maps, which the bake ships as `<bot>-mr.webp` / `-normal.webp`. Without them the shell looks flat. |
| `texture_resolution` | `"2k"` (default) | The bake resizes to 1024², so 4k/8k is wasted credit. |
| `multi_view_thumbnails` | `true` | Four cardinal views to check the pose and the face before spending more credits. |

**Prompt** (or concept image): full body, front-facing, standing with feet apart, arms slightly away from the body, **a blank visor or screen face** (the runtime draws the live eyes and mouth; painted features have to be covered, see `cover` / `glowOff`), and one antenna if wanted. Name the material ("glossy white plastic shell, dark grey joints"). Avoid held props and capes, because they weld to a limb.

## 3. Flows

**New bot from an idea**
1. Optional concept: `text_to_image` with the prompt above (3–9). Show it before going 3D. `image_to_3d` chains from it with `input_task_id`, so nothing is re-uploaded.
2. `image_to_3d` with the settings in §2: `meshy-t2` (15) for cheap and part-separated, `meshy-7` (30) for best detail. With front/side/back art use `multi_image_to_3d` (no smart topology).
3. Over ~80k triangles: `remesh` with `target_polycount: 70000, topology: "triangle"` (5).
4. Download the GLB to `backend/src/bots/<bot>.glb` and run the normal workflow from `glb-info.ts`.

**Existing model, wrong pose (T-pose, a gesture, hands on thighs)**
Regenerating from a front render of it with `pose_mode: "a-pose"` is often cheaper than `mirror` / `handTransplant` / `dropHands`. Keep the old file until the new one is better.

**Existing untextured model** (Ironman-style)
`uv_unwrap` (≤ 40k faces, remesh first; 5), then `retexture` with **one** of `text_style_prompt`, `image_style_url`, or `multiview_image_urls` (1–4 views of the same object, `meshy-7` only) (10). The alternative is the bake's free `paint` regions, which give flat colours with clean edges. Ask which the user wants.

**Too dense for the bake or the rig**
`remesh` (5). It is cheaper than regenerating. `convert` (1) only changes the format.

## 4. Rigging: two routes into the bake

`rig` (5 credits, ≤ 300k faces, `height_meters` default 1.7) auto-rigs a humanoid and returns `result.rigged_character_glb_url` plus walking and running clips (`result.basic_animations`), which the runtime doesn't use. Meshy's skeleton is Mixamo-style (`Hips`, `Spine…`, `Head`, `LeftArm`, `LeftForeArm`, `LeftHand`, `LeftUpLeg`, `LeftLeg`, `LeftFoot`, …), and `skeleton.ts` maps it onto the runtime's parts (`Left` → side −1 once X is mirrored; side is decided by position). Use the auto-rig in one of two ways:

1. **Pivots only (default).** `bun .codex/skills/glb-bot/scripts/skeleton.ts <rigged>.glb` prints a draft `rig` in baked units. The rigger puts joints at the limb centres, which saves most of the grid measuring and avoids misplaced pivots (Meshy's wrist was 0.6 off when measured by hand). Paste it, then write `classify` and bake as usual. Decimation, `strictSeams`, `scrub` and the rest still apply. Measure the antenna and face on the grids, because a skeleton has neither.
2. **Weights too.** `skeleton.ts <rigged>.glb --rigged=<bot>` collapses the skin onto the runtime's bones (one joint per part, weights summed per part, top four kept) and writes `.ui-check/glb-bot/<bot>-from-skin.glb`. Copied to `backend/src/bots/<bot>-rigged.glb`, it goes through the bake's rigged-input path: no `classify`, bands, smoothing, seams or scrub. `CONFIG[<bot>]` still supplies `face`, `antenna` and `antennaBall`, and `rig` is the fallback for joints the skin lacks. This route **skips decimation**, so remesh to ~70k before `rig`. Use it when `classify` is hard (a dynamic pose, fused parts). Verify it with the label, relief and `--stretch` checks like any bake. Delete the `-rigged.glb` to go back to the rules.

The rig uses the pose the model was generated in. The note about T-poses in §2 applies to both routes.

## 5. Tasks, results and downloads

- **Tasks are asynchronous:** `PENDING` → `IN_PROGRESS` → `SUCCEEDED` / `FAILED` / `CANCELED`. Poll with `get_task_status` and the right `task_type` (`image-to-3d`, `remesh`, `rigging`, …). The MCP tool waits for you, backing off from 5 s to 30 s, for up to 5 minutes. `rigging` and `animation` have no list endpoint, so keep their task ids.
- **Chaining:** most steps take `input_task_id` from a finished task (remesh → rig, preview → refine), so nothing is re-uploaded. Otherwise use `model_url`.
- **Results:** a generation's files are under `model_urls.glb` (plus `texture_urls`, `thumbnail_url`), and a rig's are under `result.rigged_character_glb_url`.
- **Download URLs expire after 24 hours.** Download straight into `backend/src/bots/` (source models aren't packaged; `backend/src/**` is in `.vscodeignore`). Record the task ids and settings in the progress note so the model can be regenerated.
- **Errors:** a 400 usually means a parameter isn't valid for that model (for example `ultra_mode` on meshy-6, `meshy-7` on text-to-3d, or `uv_unwrap` on more than 40k faces). 401 is a bad key, 429 is the rate limit (wait, don't loop), and 5xx means Meshy is down. Check credits first with `check_balance` (free).

## 6. Setup

The MCP server needs a Meshy API key (Pro plan or above). Keep the key in the client config's `env` block, never in the repo. In Claude Code on Windows:

```bash
claude mcp add-json meshy '{"command":"cmd","args":["/c","npx","-y","@meshy-ai/meshy-mcp-server"],"env":{"MESHY_API_KEY":"msy_…"}}'
```

The tools are then named `meshy_<tool>` (`meshy_image_to_3d`, `meshy_rig`, …). Without the MCP server, the same endpoints are plain REST: `https://api.meshy.ai/openapi/v1/<endpoint>` (`image-to-3d`, `remesh`, `rigging`, `retexture`, `uv-unwrap`; text-to-3d is under `/openapi/v2/`) with `Authorization: Bearer $MESHY_API_KEY`, and `GET …/<endpoint>/<id>` to poll.
