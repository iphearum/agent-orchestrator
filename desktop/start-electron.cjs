const { spawn } = require("node:child_process");
const path = require("node:path");

// Some developer environments set this for their own Node tooling. Electron
// must not inherit it or it starts as plain Node and exposes no Electron APIs.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes("--dev")) {
  env.NEXT_DEV_SERVER_URL ||= "http://127.0.0.1:3000";
} else {
  delete env.NEXT_DEV_SERVER_URL;
}

const electronPath = require("electron");
const child = spawn(electronPath, [path.resolve(__dirname)], {
  env,
  stdio: "inherit",
  windowsHide: false
});

child.on("error", error => {
  console.error("Could not start Electron:", error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
