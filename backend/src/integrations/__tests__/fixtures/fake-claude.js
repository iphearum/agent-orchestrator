// Stand-in for a coding-agent CLI: prints Claude Code stream-json events for the prompt it receives.
const fromArgs = process.argv.slice(2).join(" ");
const respond = prompt => {
  const say = event => process.stdout.write(JSON.stringify(event) + "\n");
  say({ type: "system", subtype: "init", cwd: process.cwd() });
  say({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth/login.py" } }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "def login(): ..." }] } });
  say({ type: "result", subtype: "success", is_error: false, result: `handled: ${prompt.trim()} in ${process.cwd().split(/[\\/]/).pop()}` });
};
if (fromArgs) respond(fromArgs);
else { let input = ""; process.stdin.on("data", chunk => { input += chunk; }); process.stdin.on("end", () => respond(input)); }
