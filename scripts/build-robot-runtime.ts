// The runtime creates Babylon's WebGL Engine, never WebGPUEngine. Babylon's materials
// import WGSL shader registrations alongside GLSL; dropping those side-effect-only
// registrations trims the browser bundle without changing the WebGL shader path.
const result = await Bun.build({
  entrypoints: ["webview-ui/src/robot-runtime.ts"],
  target: "browser",
  format: "iife",
  minify: true,
  metafile: true,
  plugins: [{
    name: "webgl-only-babylon-shaders",
    setup(build) {
      build.onLoad(
        { filter: /[\\/]ShadersWGSL[\\/]/ },
        () => ({ contents: "", loader: "js" })
      );
    }
  }]
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const bundle = result.outputs.find(output => output.path.endsWith("robot-runtime.js"));
if (!bundle) throw new Error("Robot runtime bundle output was not produced.");

const outputPath = "dist/webview/robot-runtime.js";
await Bun.write(outputPath, bundle);
console.log(`WebGL-only robot runtime: ${(bundle.size / 1024 / 1024).toFixed(2)} MB → ${outputPath}`);
