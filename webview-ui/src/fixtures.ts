// Design data from target/real_ui_design.png, served when the UI runs in a normal browser (bun --port=5174 webview-ui/dev.html).
import type { AgentRef, MethodName, Methods, OverviewView, SidebarBundle, Surface, TaskBundle } from "@shared/protocol";

const today = (time: string) => { const [h, m] = time.split(":").map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const agent = (id: string, name: string, state: AgentRef["state"] = "idle"): AgentRef => ({ id, name, color: id, state });
const supervisor = agent("supervisor", "Supervisor", "running"), coder = agent("coder", "Coder", "running"), researcher = agent("researcher", "Researcher", "running");
const reviewer = agent("reviewer", "Reviewer", "waiting"), devops = agent("devops", "DevOps", "waiting");

const sidebar: SidebarBundle = {
  workspaces: [{ key: "file:///ai-gateway", name: "AI Gateway" }],
  agents: [
    { ...supervisor, description: "Coordinates and plans work", profile: "global", canDelegate: true },
    { ...coder, description: "Implementation and debugging", profile: "coder", canDelegate: true },
    { ...agent("researcher", "Researcher"), description: "External research and analysis", profile: "researcher", canDelegate: true },
    { ...agent("planner", "Planner", "waiting"), description: "Task breakdown and strategy", profile: "planner", canDelegate: true },
    { ...agent("reviewer", "Reviewer", "running"), description: "Code review and quality", profile: "general", canDelegate: false },
    { ...agent("devops", "DevOps", "running"), description: "Deployment and infrastructure", profile: "coder", canDelegate: true },
    { ...agent("documenter", "Documenter"), description: "Documentation and guides", profile: "general", canDelegate: false }
  ],
  tasks: [
    { id: "t12", number: 12, title: "Fix authentication error", status: "active", running: true },
    { id: "t11", number: 11, title: "Add user management API", status: "planning", running: false },
    { id: "t10", number: 10, title: "Improve documentation", status: "pending", running: false },
    { id: "t9", number: 9, title: "Research best practices", status: "completed", running: false },
    { id: "t8", number: 8, title: "Set up CI/CD pipeline", status: "completed", running: false }
  ],
  conversations: [
    { id: "c1", title: "Debug auth 500 error", updatedAt: new Date(Date.now() - 120_000).toISOString(), taskId: "t12" },
    { id: "c2", title: "Design new feature", updatedAt: new Date(Date.now() - 3_600_000).toISOString() },
    { id: "c3", title: "Review code changes", updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() },
    { id: "c4", title: "Research LLM options", updatedAt: new Date(Date.now() - 5 * 3_600_000).toISOString() }
  ],
  health: { laya: { status: "online" }, sqlite: { status: "connected" }, agentsRunning: 5, tasksActive: 1, workspace: "AI Gateway" }
};

const tool = (id: string, name: string, displayName: string) => ({ name, displayName, ref: `tool://${id}` });
const loginDiff = `async def login(email: str, password: str):
    user = await db.get_user(email)
    if not user:
        logger.warning(f"Login attempt for non-existent user: {email}")
        raise HTTPException(
            status_code=401,
            detail="Invalid credentials"
        )
    if not verify_password(password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")`;

const task: TaskBundle = {
  task: {
    id: "t12", number: 12, title: "Fix authentication error",
    description: "User reported 500 error on /api/auth/login after database changes. Investigate, fix, and add test.",
    status: "active", running: true, priority: 2, createdAt: today("10:24"), updatedAt: new Date(Date.now() - 300_000).toISOString(), createdBy: "Client",
    owner: supervisor,
    assignees: [
      { agent: supervisor, activity: "Coordinating", status: "active" }, { agent: coder, activity: "Implementing", status: "active" },
      { agent: researcher, activity: "Investigating", status: "completed" }, { agent: reviewer, activity: "Code review", status: "pending" }
    ],
    plan: { id: "p1", objective: "", progress: .7, steps: [
      { id: "s1", position: 1, description: "Investigate recent changes", status: "completed" },
      { id: "s2", position: 2, description: "Identify root cause", status: "completed" },
      { id: "s3", position: 3, description: "Implement fix", status: "active" },
      { id: "s4", position: 4, description: "Add/Update tests", status: "pending" },
      { id: "s5", position: 5, description: "Code review", status: "pending" },
      { id: "s6", position: 6, description: "Deploy / Verify", status: "pending" }
    ] },
    conversationId: "c1", counts: { events: 10, toolRuns: 8, filesChanged: 3, subtasks: 4 }, canComplete: false
  },
  flow: {
    nodes: [
      { id: "request", kind: "request", layer: 0, title: "Client Request", subtitle: "Fix authentication 500 error", state: "done" },
      { id: "agent:supervisor", kind: "agent", layer: 1, agent: supervisor, title: "Supervisor", subtitle: "Analyzing and delegating", state: "active" },
      { id: "agent:researcher", kind: "agent", layer: 2, agent: researcher, title: "Researcher", subtitle: "Checking related changes", state: "active" },
      { id: "agent:coder", kind: "agent", layer: 2, agent: coder, title: "Coder", subtitle: "Inspecting and fixing code", state: "active" },
      { id: "agent:devops", kind: "agent", layer: 2, agent: devops, title: "DevOps", subtitle: "Checking environment", state: "active" },
      { id: "agent:reviewer", kind: "agent", layer: 3, agent: reviewer, title: "Reviewer", subtitle: "Reviewing changes", state: "pending" },
      { id: "result", kind: "result", layer: 4, title: "Result", subtitle: "Fix implemented · Tests added", state: "done" }
    ],
    edges: [
      { from: "request", to: "agent:supervisor", type: "request" },
      { from: "agent:supervisor", to: "agent:researcher", type: "handoff" }, { from: "agent:supervisor", to: "agent:coder", type: "handoff" },
      { from: "agent:supervisor", to: "agent:devops", type: "handoff" }, { from: "agent:researcher", to: "agent:reviewer", type: "result" },
      { from: "agent:coder", to: "agent:reviewer", type: "result" }, { from: "agent:devops", to: "agent:reviewer", type: "result" },
      { from: "agent:reviewer", to: "result", type: "result" }
    ]
  },
  events: [
    { id: "e1", at: today("10:24"), kind: "handoff", agent: supervisor, label: "Analyzing the issue and delegating to Researcher, Coder, and DevOps.", status: "info" },
    { id: "e2", at: today("10:24"), kind: "tool", agent: researcher, label: "Searching for recent database changes and authentication related commits...", tool: tool("r1", "search_workspace", "Web Search"), status: "succeeded" },
    { id: "e3", at: today("10:25"), kind: "tool", agent: researcher, label: "Found relevant changes in commit a3f9c2. There is a schema change in users table.", tool: tool("r2", "read_file", "Read Files"), status: "succeeded" },
    { id: "e4", at: today("10:26"), kind: "tool", agent: coder, label: "Inspecting the authentication code and database models.", tool: tool("r3", "read_file", "Read Files"), status: "succeeded" },
    { id: "e5", at: today("10:27"), kind: "tool", agent: coder, label: "Found the issue: missing null check for new field. Implementing fix...", tool: tool("r4", "write_file", "Edit File"), status: "running" },
    { id: "e6", at: today("10:28"), kind: "tool", agent: devops, label: "Checking if the database migration was applied in the current environment.", tool: tool("r5", "run_command", "Shell Command"), status: "succeeded" },
    { id: "e7", at: today("10:29"), kind: "tool", agent: coder, label: "Added null check and improved error handling. Running tests...", tool: tool("r6", "run_command", "Run Tests"), status: "succeeded" },
    { id: "e8", at: today("10:30"), kind: "message", agent: reviewer, label: "Reviewing changes. Looks good. Minor suggestion on logging.", tool: tool("r7", "read_file", "Code Review"), status: "succeeded" },
    { id: "e9", at: today("10:31"), kind: "tool", agent: coder, label: "Updated logging as suggested.", tool: tool("r8", "write_file", "Edit File"), status: "succeeded" },
    { id: "e10", at: today("10:32"), kind: "result", agent: supervisor, label: "All subtasks completed. The fix has been implemented and tested.", status: "task_completed" }
  ],
  logs: [{ id: "l1", at: today("10:24"), kind: "routing", agentId: "supervisor", data: '{"source":"laya","agent":{"value":"supervisor","confidence":0.96}}' }],
  toolRuns: [{ id: "r6", ref: "tool://r6", agentId: "coder", toolName: "run_command", displayName: "Shell Command", status: "completed", summary: "exit 0 · 12 passed in 2.40s", arguments: '{"command":"pytest -v tests/test_auth.py"}', createdAt: today("10:29"), durationMs: 2400 }],
  files: [
    { id: "f1", path: "src/auth/login.py", additions: 24, deletions: 6, content: loginDiff, agentId: "coder", at: today("10:27") },
    { id: "f2", path: "src/models/user.py", additions: 12, deletions: 0, content: "class User(Base):\n    email = Column(String, nullable=True)", agentId: "coder", at: today("10:27") },
    { id: "f3", path: "tests/test_auth.py", additions: 36, deletions: 0, content: "def test_login_nonexistent_user(client):\n    assert client.post('/api/auth/login').status_code == 401", agentId: "coder", at: today("10:29") }
  ],
  tests: { command: "pytest -v tests/test_auth.py", passed: 12, failed: 0, durationS: 2.4, cases: [
    { name: "test_login_success", status: "passed", durationS: .3 }, { name: "test_login_invalid_password", status: "passed", durationS: .2 },
    { name: "test_login_nonexistent_user", status: "passed", durationS: .2 }, { name: "test_login_locked_account", status: "passed", durationS: .4 },
    { name: "test_login_rate_limit", status: "passed", durationS: .3 }
  ] },
  knowledge: [
    { id: "k1", name: "authentication", type: "concept", relationCount: 12 }, { id: "k2", name: "users_table", type: "entity", relationCount: 8 },
    { id: "k3", name: "database_migration", type: "event", relationCount: 4 }, { id: "k4", name: "fastapi", type: "technology", relationCount: 15 }
  ],
  messages: [
    { id: "m1", role: "user", authorName: "Client", content: "Fix the authentication 500 error on /api/auth/login.", at: today("10:24") },
    { id: "m2", role: "assistant", authorName: "Supervisor", agent: supervisor, content: "Got it. Analyzing and delegating the task to the appropriate agents...", at: today("10:24") }
  ],
  metrics: { durationMs: undefined, toolRuns: 8, toolFailures: 0, toolTimeMs: 5200, delegations: 3, decisions: 6, layaDecisions: 5, fallbackDecisions: 1, memoriesRetrieved: 5, graphFacts: 8 }
};

// A one-agent chat that finished immediately, like the smallest real run.
const simple: TaskBundle = {
  ...task,
  task: { ...task.task, id: "t1", number: 1, title: "hi", description: "hi", status: "completed", running: false, priority: 0, createdBy: "You",
    owner: agent("coder", "Coder"), assignees: [{ agent: agent("coder", "Coder"), activity: "Done", status: "completed" }], plan: undefined,
    counts: { events: 3, toolRuns: 0, filesChanged: 0, subtasks: 0 }, canComplete: false },
  flow: { nodes: [
    { id: "request", kind: "request", layer: 0, title: "Request", subtitle: "hi", state: "done" },
    { id: "agent:coder", kind: "agent", layer: 1, agent: agent("coder", "Coder"), title: "Coder", subtitle: "hi", state: "done" },
    { id: "result", kind: "result", layer: 2, title: "Result", subtitle: "Hello! I'm ready to help you with your work.", state: "done" }
  ], edges: [{ from: "request", to: "agent:coder", type: "request" }, { from: "agent:coder", to: "result", type: "result" }] },
  events: [
    { id: "s1", at: today("19:26"), kind: "route", agent: agent("coder", "Coder"), label: "Started the request to Coder.", status: "info" },
    { id: "s2", at: today("19:26"), kind: "message", agent: agent("coder", "Coder"), label: "Hello! I'm ready to help you with your work. What would you like to do today?", status: "info" },
    { id: "s3", at: today("19:26"), kind: "result", agent: agent("coder", "Coder"), label: "Task completed.", status: "task_completed" }
  ],
  toolRuns: [], files: [], tests: null, knowledge: [],
  messages: [{ id: "sm1", role: "user", authorName: "You", content: "hi", at: today("19:26") }, { id: "sm2", role: "result", authorName: "Coder", agent: agent("coder", "Coder"), content: "Hello! I'm ready to help you with your work.", at: today("19:26") }]
};

const overview: OverviewView = {
  health: sidebar.health,
  counts: { total: 12, running: 1, completed: 9, blocked: 1, interrupted: 1, other: 0 },
  toolRuns: { total: 64, failed: 2 },
  agents: sidebar.agents.map((agent, index) => ({ ...agent, taskCount: [12, 9, 4, 3, 5, 2, 1][index] ?? 0 })),
  recentTasks: sidebar.tasks.map(item => ({ ...item, owner: supervisor, updatedAt: new Date(Date.now() - item.number * 600_000).toISOString() })),
  activity: task.events.filter(event => event.agent).slice().reverse().map(event => ({ ...event, taskId: "t12", taskNumber: 12 }))
};

export function fixtureInit(surface: Surface) {
  return surface === "task" ? { taskId: new URLSearchParams(location.search).get("task") ?? "t12" } : {};
}

export async function fixtureCall<M extends MethodName>(method: M, _params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
  const results: Partial<Record<MethodName, unknown>> = { "sidebar.get": sidebar, "overview.get": overview, "task.get": (_params as { taskId?: string })?.taskId === "t1" ? simple : task, "task.latest": { taskId: "t12" }, "task.update": task.task };
  if (method in results) return results[method] as Methods[M]["result"];
  console.info(`[fixtures] ${method}`, _params);
  return null as Methods[M]["result"];
}
