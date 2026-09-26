const fs = require("node:fs");
const path = require("node:path");

const helperPath = path.join(path.dirname(require.resolve("node-pty")), "conpty_console_list_agent.js");
const source = fs.readFileSync(helperPath, "utf8");
const target = "var consoleProcessList = getConsoleProcessList(shellPid);";

if (source.includes("AttachConsole can fail if the process already exited") || !source.includes(target)) {
  if (source.includes("getConsoleProcessList(shellPid)") && /try\s*\{[^}]*getConsoleProcessList\(shellPid\)/s.test(source)) process.exit(0);
  throw new Error("Unsupported node-pty console-list helper; review scripts/patch-node-pty.cjs before updating node-pty.");
}

const replacement = [
  "var consoleProcessList = [];",
  "try {",
  "    consoleProcessList = getConsoleProcessList(shellPid);",
  "} catch (_error) {",
  "    // ConPTY may exit before its helper can attach to the console.",
  "    consoleProcessList = [];",
  "}"
].join("\n");

fs.writeFileSync(helperPath, source.replace(target, replacement), "utf8");
