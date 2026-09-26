# Agent Development Specification
## Laya-per-Agent + JEV + SQLite-First Architecture

**Status:** Implementation Guide  
**Primary Language:** Python  
**API Layer:** FastAPI  
**Primary Storage:** SQLite3  
**Optional Vector Layer:** `sqlite-vec` or another pluggable vector store  
**Decision Model:** `convaiinnovations/laya`  
**Primary Design Goal:** Build an agentic runtime where each agent has its own decision policy, knowledge, memory, tasks, plans, tools, and communication, while sharing a common Laya runtime and SQLite-backed state.

---

# 1. Objective

Build a standalone agentic runtime focused on intelligent orchestration, multi-agent coordination, memory, knowledge, tools, planning, and efficient model usage.

The core system should expose a clean API that can later integrate with external applications if needed, but external harness compatibility is not a primary design concern.

The core runtime should provide:

1. Agent selection
2. Per-agent Laya decision policies
3. Tool routing
4. Context reduction
5. Memory management
6. Knowledge graph / JEV
7. Tasks
8. Plans
9. Agent-to-agent communication
10. Main-LLM escalation
11. Optional vector retrieval
12. Observability and tracing

The architecture must work fully with SQLite3 before any vector database is enabled.

---

# 2. Core Design Principles

## 2.1 SQLite is the source of truth

SQLite stores:

- conversations
- messages
- agents
- memories
- entities
- relations
- tools
- tool runs
- tasks
- plans
- plan steps
- agent messages
- summaries
- traces

Vector storage must never become the authoritative state store.

Use vectors only for semantic retrieval.

---

## 2.2 Laya is a decision layer, not the orchestrator

Laya should answer constrained questions such as:

- Is this task for this agent?
- Does the agent need memory?
- Does the agent need graph retrieval?
- Does semantic retrieval help?
- Which tool category should be used?
- Should the task be delegated?
- Should the current plan continue?
- Is deeper reasoning required?
- Should the main LLM be invoked?

Laya must not directly:

- execute tools
- persist state
- mutate memory
- control authorization
- perform long-form reasoning
- replace the main orchestrator

---

## 2.3 Each agent gets its own Laya policy

Do not load a separate Laya model per agent.

Use:

```text
One shared Laya runtime
        │
        ├── Coder Laya Policy
        ├── Researcher Laya Policy
        ├── Planner Laya Policy
        ├── General Agent Laya Policy
        └── Future Agent Policies
```

Each policy defines the questions relevant to that agent.

---

## 2.4 The main LLM should receive only useful context

Never send:

```text
all history
+ all memory
+ all graph nodes
+ all tools
+ all tool results
```

Instead:

```text
raw state
   ↓
routing
   ↓
retrieval
   ↓
filtering
   ↓
compression
   ↓
minimal context
   ↓
main LLM
```

---

# 3. High-Level Architecture

```text
                         Client / API
                            │
                            ▼
                      ORCHESTRATOR
                            │
                      Global Laya
                            │
                 agent selection/gating
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
      Coder             Researcher           Planner
        │                   │                   │
   Local Laya          Local Laya          Local Laya
    Policy              Policy              Policy
        │                   │                   │
        ├── tools            ├── retrieval       ├── plans
        ├── memory           ├── memory          ├── tasks
        ├── JEV              ├── JEV             ├── JEV
        └── LLM              └── LLM             └── LLM
                 \             |               /
                  \            |              /
                   └──────── SQLite ─────────┘
                               │
                         ┌─────┴─────┐
                         │           │
                        JEV      Vector Store
                                optional
```

---

# 4. Runtime Flow

Every incoming message should follow this pipeline:

```text
User Message
   ↓
1. Normalize input
   ↓
2. Save raw message
   ↓
3. Global Laya agent routing
   ↓
4. Resolve target agent
   ↓
5. Build lightweight agent state
   ↓
6. Run agent-specific Laya policy
   ↓
7. Retrieve structured memory if needed
   ↓
8. Retrieve JEV graph data if needed
   ↓
9. Run semantic/vector retrieval if needed
   ↓
10. Select tool candidates
   ↓
11. Build minimal context
   ↓
12. Invoke main LLM if required
   ↓
13. Execute tool calls
   ↓
14. Continue tool/LLM loop until complete
   ↓
15. Save response
   ↓
16. Update memory
   ↓
17. Update JEV
   ↓
18. Update tasks/plans
   ↓
19. Compress old context when needed
   ↓
20. Save trace
```

---

# 5. Recommended Project Structure

```text
agent-core/
│
├── app/
│   ├── main.py
│   │
│   ├── api/
│   │   ├── chat.py
│   │   ├── agents.py
│   │   ├── memory.py
│   │   ├── tools.py
│   │   ├── tasks.py
│   │   └── debug.py
│   │
│   ├── core/
│   │   ├── config.py
│   │   ├── orchestrator.py
│   │   ├── context.py
│   │   ├── routing.py
│   │   └── tracing.py
│   │
│   ├── decision/
│   │   ├── laya_runtime.py
│   │   ├── engine.py
│   │   ├── result.py
│   │   └── policies/
│   │       ├── global_policy.py
│   │       ├── coder_policy.py
│   │       ├── researcher_policy.py
│   │       └── planner_policy.py
│   │
│   ├── agents/
│   │   ├── manager.py
│   │   ├── runtime.py
│   │   ├── communication.py
│   │   └── state.py
│   │
│   ├── tools/
│   │   ├── base.py
│   │   ├── registry.py
│   │   ├── selector.py
│   │   ├── executor.py
│   │   └── builtin/
│   │       ├── calculator.py
│   │       ├── filesystem.py
│   │       ├── shell.py
│   │       └── search.py
│   │
│   ├── memory/
│   │   ├── manager.py
│   │   ├── retrieval.py
│   │   ├── compression.py
│   │   ├── extractor.py
│   │   └── types.py
│   │
│   ├── jev/
│   │   ├── graph.py
│   │   ├── extractor.py
│   │   ├── resolver.py
│   │   ├── conflict.py
│   │   └── retrieval.py
│   │
│   ├── tasks/
│   │   ├── manager.py
│   │   ├── planner.py
│   │   └── scheduler.py
│   │
│   ├── models/
│   │   ├── provider.py
│   │   ├── llm.py
│   │   └── adapters/
│   │       ├── openai.py
│   │       ├── ollama.py
│   │       └── local.py
│   │
│   ├── storage/
│   │   ├── sqlite.py
│   │   ├── repositories/
│   │   │   ├── agents.py
│   │   │   ├── conversations.py
│   │   │   ├── memories.py
│   │   │   ├── graph.py
│   │   │   ├── tasks.py
│   │   │   └── tools.py
│   │   └── vector/
│   │       ├── base.py
│   │       ├── noop.py
│   │       ├── sqlite_vector.py
│   │       └── qdrant.py
│   │
│   └── domain/
│       ├── agent.py
│       ├── message.py
│       ├── memory.py
│       ├── task.py
│       ├── plan.py
│       └── tool.py
│
├── migrations/
│   └── 001_initial.sql
│
├── data/
│   └── runtime.db
│
├── tests/
│
├── .env
├── pyproject.toml
└── README.md
```

---

# 6. Initial Dependencies

Create environment:

```bash
python -m venv .venv
source .venv/bin/activate
```

Install the minimal stack:

```bash
pip install \
    fastapi \
    uvicorn \
    pydantic \
    pydantic-settings \
    aiosqlite \
    httpx
```

Add Laya according to the current package/repository installation instructions.

Do not add vector libraries during phase 1.

Optional later:

```bash
pip install sqlite-vec
```

---

# 7. Configuration

Example:

```python
# app/core/config.py

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "data/runtime.db"

    vector_enabled: bool = False
    vector_provider: str = "none"

    laya_enabled: bool = True
    laya_model: str = "convaiinnovations/laya"

    context_max_tokens: int = 12000
    context_recent_messages: int = 6

    automatic_execution_confidence: float = 0.90
    context_enrichment_confidence: float = 0.65

    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
    )


settings = Settings()
```

Example `.env`:

```env
DATABASE_URL=data/runtime.db

VECTOR_ENABLED=false
VECTOR_PROVIDER=none

LAYA_ENABLED=true
LAYA_MODEL=convaiinnovations/laya

CONTEXT_MAX_TOKENS=12000
CONTEXT_RECENT_MESSAGES=6

AUTOMATIC_EXECUTION_CONFIDENCE=0.90
CONTEXT_ENRICHMENT_CONFIDENCE=0.65
```

---

# 8. SQLite Initialization

Use:

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=NORMAL;
```

Recommended connection wrapper:

```python
import aiosqlite

from app.core.config import settings


class Database:
    def __init__(self, path: str):
        self.path = path

    async def connect(self):
        conn = await aiosqlite.connect(self.path)
        await conn.execute("PRAGMA foreign_keys = ON")
        await conn.execute("PRAGMA journal_mode = WAL")
        await conn.execute("PRAGMA synchronous = NORMAL")
        return conn


db = Database(settings.database_url)
```

---

# 9. Database Schema

## 9.1 Conversations

```sql
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 9.2 Messages

```sql
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    agent_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER,
    active_context INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(conversation_id)
        REFERENCES conversations(id)
);
```

## 9.3 Agents

```sql
CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT,
    model TEXT,
    laya_profile TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 9.4 Tools

```sql
CREATE TABLE tools (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    schema_json TEXT,
    risk_level INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1
);
```

## 9.5 Agent tools

```sql
CREATE TABLE agent_tools (
    agent_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    priority REAL DEFAULT 1,

    PRIMARY KEY(agent_id, tool_id),

    FOREIGN KEY(agent_id) REFERENCES agents(id),
    FOREIGN KEY(tool_id) REFERENCES tools(id)
);
```

## 9.6 Memories

```sql
CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    conversation_id TEXT,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    importance REAL DEFAULT 0.5,
    confidence REAL DEFAULT 1.0,
    source_message_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    accessed_at DATETIME,
    active INTEGER DEFAULT 1
);
```

Recommended memory types:

```text
working
episodic
semantic
procedural
profile
```

## 9.7 Entities

```sql
CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    data_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(type, name)
);
```

## 9.8 Relations

```sql
CREATE TABLE relations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    predicate TEXT NOT NULL,
    target_id TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    source_message_id TEXT,
    valid_from DATETIME,
    valid_to DATETIME,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(source_id) REFERENCES entities(id),
    FOREIGN KEY(target_id) REFERENCES entities(id)
);
```

## 9.9 Tasks

```sql
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    parent_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    priority INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);
```

Recommended statuses:

```text
pending
active
blocked
completed
cancelled
```

## 9.10 Plans

```sql
CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    objective TEXT,
    status TEXT DEFAULT 'active',

    FOREIGN KEY(task_id) REFERENCES tasks(id)
);
```

## 9.11 Plan steps

```sql
CREATE TABLE plan_steps (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    description TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    result TEXT,

    FOREIGN KEY(plan_id) REFERENCES plans(id)
);
```

## 9.12 Agent communication

```sql
CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY,
    sender_agent_id TEXT,
    receiver_agent_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Recommended message types:

```text
request
response
handoff
event
observation
task
result
```

## 9.13 Tool runs

```sql
CREATE TABLE tool_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    agent_id TEXT,
    tool_name TEXT NOT NULL,
    arguments_json TEXT,
    result_json TEXT,
    summary TEXT,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 9.14 Summaries

```sql
CREATE TABLE summaries (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    start_message_id TEXT,
    end_message_id TEXT,
    summary TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

# 10. Shared Laya Runtime

Create a single runtime service.

```python
# app/decision/laya_runtime.py

class LayaRuntime:
    def __init__(self, model):
        self.model = model

    async def decide(
        self,
        state: dict,
        questions: dict,
    ) -> dict:
        return self.model.predict(
            state,
            questions,
        )
```

The actual loading code should follow the current `convaiinnovations/laya` API.

Important rule:

```text
Do not load one full Laya checkpoint for every agent.
```

Load once and reuse it.

---

# 11. Global Laya Policy

The global policy chooses the responsible agent.

Example:

```python
GLOBAL_POLICY = {
    "agent": {
        "type": "choice",
        "instructions": "Choose the best agent for this request.",
        "criteria": {
            "coder": "Programming, debugging, repositories, infrastructure, code changes.",
            "researcher": "Information retrieval, web research, source comparison, investigation.",
            "planner": "Planning, decomposition, sequencing, migration strategy.",
            "general": "Requests that do not require a specialized agent."
        }
    },

    "needs_deep_reasoning": {
        "type": "noul",
        "instructions": "Does the request require substantial generative reasoning?"
    }
}
```

Flow:

```text
request
  ↓
global Laya
  ↓
target agent
```

---

# 12. Per-Agent Laya Policies

## 12.1 Coder Agent

```python
CODER_POLICY = {
    "needs_memory": {
        "type": "noul",
        "instructions": "Would previous project knowledge materially help?"
    },

    "needs_graph": {
        "type": "noul",
        "instructions": "Would project/entity relationships help solve this task?"
    },

    "needs_vector": {
        "type": "noul",
        "instructions": "Would semantic similarity search over historical memory help?"
    },

    "tool": {
        "type": "choice",
        "instructions": "Choose the most useful next capability.",
        "criteria": {
            "search_code": "Find implementation related to the issue.",
            "read_file": "Inspect a known source file.",
            "shell": "Run diagnostic or development commands.",
            "database": "Inspect database schema or data.",
            "git": "Inspect repository history or working tree.",
            "none": "No tool is currently required."
        }
    },

    "delegate": {
        "type": "choice",
        "instructions": "Choose whether this agent should continue or delegate.",
        "criteria": {
            "self": "Coder should continue.",
            "researcher": "External investigation is needed.",
            "planner": "The task requires planning first."
        }
    },

    "needs_llm": {
        "type": "noul",
        "instructions": "Is deeper generative reasoning required?"
    }
}
```

---

## 12.2 Researcher Agent

```python
RESEARCHER_POLICY = {
    "retrieval_source": {
        "type": "choice",
        "instructions": "Choose the best retrieval source.",
        "criteria": {
            "local_memory": "Known internal memory is sufficient.",
            "graph": "Entity and relationship lookup is important.",
            "vector": "Semantic historical retrieval is useful.",
            "web": "Fresh external information is required."
        }
    },

    "needs_memory": {
        "type": "noul",
        "instructions": "Should internal historical memory be searched?"
    },

    "needs_graph": {
        "type": "noul",
        "instructions": "Should the JEV graph be queried?"
    },

    "needs_llm": {
        "type": "noul",
        "instructions": "Does this task require generative synthesis?"
    }
}
```

---

## 12.3 Planner Agent

```python
PLANNER_POLICY = {
    "continue_plan": {
        "type": "noul",
        "instructions": "Should the current active plan continue?"
    },

    "replan": {
        "type": "noul",
        "instructions": "Does new information require revising the plan?"
    },

    "delegate": {
        "type": "choice",
        "instructions": "Choose the best agent for the next step.",
        "criteria": {
            "coder": "Implementation work is required.",
            "researcher": "Investigation is required.",
            "planner": "Planning should continue."
        }
    },

    "needs_llm": {
        "type": "noul",
        "instructions": "Does this planning step require deeper generative reasoning?"
    }
}
```

---

# 13. Agent State

Define a compact state object.

```python
from dataclasses import dataclass


@dataclass
class AgentState:
    agent_id: str
    agent_name: str
    message: str

    current_task: dict | None
    active_plan: dict | None

    available_tools: list[str]

    recent_context_summary: str | None = None
    relevant_entities: list[str] | None = None
```

Do not send the full database state into Laya.

The state must remain small.

---

# 14. Decision Engine

```python
class AgentDecisionEngine:
    def __init__(
        self,
        runtime,
        policies: dict[str, dict],
    ):
        self.runtime = runtime
        self.policies = policies

    async def decide(
        self,
        profile: str,
        state: dict,
    ) -> dict:

        policy = self.policies[profile]

        return await self.runtime.decide(
            state=state,
            questions=policy,
        )
```

Registry:

```python
POLICIES = {
    "coder": CODER_POLICY,
    "researcher": RESEARCHER_POLICY,
    "planner": PLANNER_POLICY,
}
```

---

# 15. Confidence Gating

Use confidence bands.

Suggested starting thresholds:

```text
confidence >= 0.90
    execute automatically

0.65 <= confidence < 0.90
    retrieve more context / verify

confidence < 0.65
    escalate to main LLM
```

Example:

```python
def decision_mode(confidence: float) -> str:
    if confidence >= 0.90:
        return "execute"

    if confidence >= 0.65:
        return "enrich"

    return "reason"
```

Important:

Laya confidence must not override tool security.

A high-confidence dangerous tool request must still pass permissions and approval policy.

---

# 16. Tool Abstraction

```python
from abc import ABC, abstractmethod
from typing import Any


class Tool(ABC):
    name: str
    description: str

    @abstractmethod
    async def execute(self, **kwargs) -> Any:
        ...
```

Example registry:

```python
class ToolRegistry:
    def __init__(self):
        self.tools = {}

    def register(self, tool: Tool):
        self.tools[tool.name] = tool

    def get(self, name: str):
        return self.tools[name]

    def list(self):
        return list(self.tools.values())
```

---

# 17. Tool Selection Strategy

Tool selection should happen in layers.

```text
All tools
   ↓
enabled tools
   ↓
agent permissions
   ↓
task relevance
   ↓
Laya selection
   ↓
1–3 tool schemas
   ↓
main LLM
```

Example:

```text
40 registered tools
      ↓
coder has 12
      ↓
current task suggests 5
      ↓
Laya selects 2
      ↓
main LLM sees only 2
```

This is a central optimization target.

---

# 18. JEV Knowledge Graph

JEV should manage structured knowledge and state.

Example:

```text
AI Gateway
   ├── uses → FastAPI
   ├── database → PostgreSQL
   ├── exposes → /api/v1
   └── owned_by → Backend Agent
```

JEV responsibilities:

```text
extract
normalize
resolve
link
deduplicate
reinforce
conflict-detect
version
decay
retrieve
```

JEV is not a vector store.

---

# 19. JEV Conflict Handling

Example input:

```text
"The gateway now runs on port 8080."
```

Existing graph:

```text
gateway → uses_port → 8000
```

Update:

```text
old relation:
gateway → uses_port → 8000
active=false
valid_to=now

new relation:
gateway → uses_port → 8080
active=true
valid_from=now
```

Do not simply store contradictory facts as equally current.

---

# 20. Memory Architecture

Use separate memory types.

```text
Working memory
    current task/conversation context

Episodic memory
    what happened

Semantic memory
    facts and learned information

Procedural memory
    how a process should be performed

Profile memory
    durable configuration/preferences
```

The memory manager should support:

```python
await memory.store(...)
await memory.retrieve(...)
await memory.deactivate(...)
await memory.reinforce(...)
```

---

# 21. Vector Retrieval

Vector search is optional.

Interface:

```python
from abc import ABC, abstractmethod


class VectorStore(ABC):

    @abstractmethod
    async def add(
        self,
        id: str,
        vector: list[float],
        metadata: dict,
    ):
        ...

    @abstractmethod
    async def search(
        self,
        vector: list[float],
        limit: int = 10,
    ):
        ...
```

No-op implementation:

```python
class NoVectorStore(VectorStore):

    async def add(self, *args, **kwargs):
        return None

    async def search(self, *args, **kwargs):
        return []
```

Factory:

```python
def create_vector_store(settings):
    if not settings.vector_enabled:
        return NoVectorStore()

    if settings.vector_provider == "sqlite":
        return SQLiteVectorStore()

    if settings.vector_provider == "qdrant":
        return QdrantVectorStore()

    raise ValueError(
        f"Unsupported vector provider: {settings.vector_provider}"
    )
```

---

# 22. Laya-Gated Vector Search

Do not create embeddings for every request automatically.

Ask Laya:

```python
{
    "needs_vector": {
        "type": "noul",
        "instructions":
            "Would semantically similar historical knowledge help solve this request?"
    }
}
```

Then:

```text
low probability
   ↓
skip vector retrieval

high probability
   ↓
embed query
   ↓
vector search
   ↓
rerank
```

---

# 23. Hybrid Retrieval

Final retrieval should combine:

```text
structured lookup
+ graph traversal
+ lexical search
+ semantic/vector search
+ recency
+ importance
+ current task relevance
```

Possible score:

```python
score = (
    semantic_similarity * 0.35
    + recency * 0.15
    + importance * 0.15
    + entity_overlap * 0.15
    + task_relevance * 0.20
)
```

Treat these as initial tunable values, not fixed rules.

---

# 24. Context Builder

The context builder is a core service.

Recommended order:

```text
1. system instructions
2. agent identity
3. current objective
4. current task
5. active plan
6. recent conversation
7. relevant memories
8. relevant JEV facts
9. selected tool schemas
10. reserved generation space
```

Example token budget:

```text
System                1000
Agent                   500
Task                    700
Plan                    500
Recent messages        3000
Memory                 1800
Graph                    700
Tools                   1300
Reserved generation    2500
```

Do not exceed the model context window.

---

# 25. Conversation Compression

Never delete raw history only because context was summarized.

Maintain:

```text
Raw conversation
    immutable source

Summaries
    derived context representation
```

Example:

```text
M1 ... M30
     ↓
summary(M1-M30)

Keep:
summary(M1-M30)
M31
M32
...
M40
```

Store all original messages in SQLite.

---

# 26. Structured Compression

Compression should output more than plain prose.

Recommended schema:

```json
{
  "summary": "...",
  "facts": [],
  "decisions": [],
  "open_tasks": [],
  "entities": [],
  "relationships": []
}
```

Route outputs:

```text
summary
   → summary table

facts
   → semantic memory

decisions
   → memory / project state

open_tasks
   → task manager

entities
   → JEV entities

relationships
   → JEV relations
```

---

# 27. Tasks and Plans

A task is an objective.

Example:

```text
Fix authentication failure
```

A plan is the strategy.

Example:

```text
1. inspect authentication route
2. inspect database connection
3. reproduce failure
4. identify root cause
5. implement fix
6. run tests
```

Do not combine task and plan into the same database object.

---

# 28. Agent Communication

Prefer structured communication over free-form conversations.

Example:

```json
{
  "type": "request",
  "sender": "planner",
  "receiver": "coder",
  "payload": {
    "task": "Inspect authentication implementation",
    "expected_output": "Root cause and recommended change"
  }
}
```

Possible communication types:

```text
request
response
handoff
event
observation
task
result
```

---

# 29. Main LLM Escalation

The main LLM should be invoked when:

- Laya confidence is low
- complex reasoning is required
- synthesis is required
- code generation is required
- a multi-step decision cannot safely be reduced to constrained classification
- user-visible natural language needs to be generated

The main LLM should not be used for every routing decision.

---

# 30. Tool Result References

Do not repeatedly insert giant tool outputs into context.

Every stored result should receive an addressable identifier.

Example:

```text
tool://TR-921
memory://MEM-301
entity://ENT-44
task://TASK-17
plan://PLAN-3
message://MSG-990
```

Context can include:

```text
tool://TR-921
summary: Found authentication logic in three files.
```

The model may request full expansion only if needed.

---

# 31. Orchestrator Skeleton

```python
class Orchestrator:

    async def handle(
        self,
        conversation_id: str,
        message: str,
        agent_id: str | None = None,
    ):

        # 1. Persist user message
        await self.messages.save_user_message(
            conversation_id,
            message,
        )

        # 2. Global agent routing
        if agent_id is None:
            agent_id = await self.route_agent(message)

        # 3. Resolve agent
        agent = await self.agent_manager.get(agent_id)

        # 4. Build lightweight decision state
        state = await self.agent_state_builder.build(
            agent=agent,
            conversation_id=conversation_id,
            message=message,
        )

        # 5. Run local Laya policy
        decision = await self.decision_engine.decide(
            profile=agent.laya_profile,
            state=state,
        )

        # 6. Retrieve memory if needed
        memories = []

        if decision_requires_memory(decision):
            memories = await self.memory.retrieve(
                agent_id=agent.id,
                query=message,
                use_vector=decision_requires_vector(decision),
            )

        # 7. Retrieve JEV graph if needed
        knowledge = []

        if decision_requires_graph(decision):
            knowledge = await self.jev.retrieve(
                agent_id=agent.id,
                query=message,
            )

        # 8. Select tools
        tools = await self.tool_selector.select(
            agent=agent,
            message=message,
            decision=decision,
        )

        # 9. Build minimal prompt context
        context = await self.context_builder.build(
            conversation_id=conversation_id,
            agent=agent,
            message=message,
            memories=memories,
            knowledge=knowledge,
            tools=tools,
        )

        # 10. Main LLM only when necessary
        if decision_requires_llm(decision):
            response = await self.llm.generate(
                context=context,
                tools=tools,
            )
        else:
            response = await self.direct_action_handler.handle(
                decision=decision,
                tools=tools,
            )

        # 11. Tool loop
        response = await self.execute_tool_loop_if_needed(
            response=response,
            context=context,
            agent=agent,
        )

        # 12. Persist final result
        await self.messages.save_assistant_message(
            conversation_id,
            agent.id,
            response,
        )

        # 13. Post-processing
        await self.postprocess(
            conversation_id=conversation_id,
            agent=agent,
            user_message=message,
            assistant_response=response,
        )

        return response
```

---

# 32. Post-Processing

Initially execute synchronously.

Later move it to background jobs.

```text
Final response
   │
   ├── memory extraction
   ├── JEV extraction/update
   ├── task update
   ├── plan update
   ├── context compression
   └── trace persistence
```

Do not introduce Kafka, Celery, RabbitMQ, or similar systems in V1 unless actually necessary.

---

# 33. API Design

Initial endpoints:

```text
POST /api/v1/chat
GET  /api/v1/agents
GET  /api/v1/agents/{id}
GET  /api/v1/tools
GET  /api/v1/memory
GET  /api/v1/tasks
GET  /api/v1/plans
GET  /api/v1/debug/trace/{request_id}
```

Example chat request:

```json
{
  "conversation_id": "c1",
  "agent_id": null,
  "message": "Check why authentication started failing after the database change."
}
```

Example response:

```json
{
  "message": "The authentication failure appears related to ...",
  "agent": "coder",
  "tools_used": [
    "search_code",
    "database"
  ],
  "memory_used": [
    "MEM-31",
    "MEM-44"
  ],
  "graph_used": [
    "ENT-8",
    "REL-19"
  ],
  "trace_id": "TRACE-932"
}
```

---

# 34. Tracing

Tracing is required from the beginning.

Example trace:

```text
REQUEST
 ├─ id=TRACE-932
 ├─ conversation=c001
 └─ message_tokens=31

GLOBAL ROUTE
 ├─ agent=coder
 └─ confidence=0.96

LOCAL LAYA
 ├─ needs_memory=true
 ├─ needs_graph=true
 ├─ needs_vector=false
 ├─ tool=search_code
 ├─ needs_llm=true
 └─ confidence=0.92

MEMORY
 ├─ scanned=34
 └─ selected=5

JEV
 ├─ entities=6
 └─ relations=8

TOOLS
 ├─ eligible=11
 └─ selected=2

CONTEXT
 ├─ max_tokens=12000
 └─ actual_tokens=7140

LLM
 └─ provider=...

TOOL
 ├─ name=search_code
 └─ duration=0.18s

TOTAL
 └─ duration=2.91s
```

---

# 35. Security Rules

Laya must never bypass execution policy.

Every tool must declare:

```text
risk level
permission requirements
approval requirements
allowed agents
allowed environment
```

Suggested risk levels:

```text
0 = read-only
1 = low-risk mutation
2 = system-changing
3 = destructive / external side-effect
```

Example policy:

```text
risk 0
    automatic if authorized

risk 1
    automatic only above configured confidence and policy allows

risk 2
    explicit approval or strict sandbox

risk 3
    explicit human approval
```

---

# 36. Recommended Development Phases

## Phase 1 — Core Runtime

Implement:

1. configuration
2. SQLite initialization
3. migrations
4. conversations
5. messages
6. agents
7. tools
8. shared Laya runtime
9. global Laya policy
10. coder agent policy
11. basic orchestrator
12. main LLM adapter
13. tracing

Exit condition:

```text
One agent can receive a message,
make a Laya decision,
call a tool,
invoke the LLM,
and save the result.
```

---

## Phase 2 — Memory + JEV

Implement:

1. memory types
2. memory extraction
3. memory retrieval
4. entity extraction
5. relation extraction
6. graph retrieval
7. temporal relation updates
8. conflict handling

Exit condition:

```text
The coder agent can reuse prior structured knowledge
without replaying the whole conversation.
```

---

## Phase 3 — Context Compression

Implement:

1. token budgeting
2. recent-message selection
3. summaries
4. structured compression
5. tool-output summaries
6. result references

Exit condition:

```text
Long conversations stay within a predictable context budget.
```

---

## Phase 4 — Tasks + Plans

Implement:

1. tasks
2. plan generation
3. plan steps
4. planner agent
5. task/plan Laya decisions
6. structured agent handoff

Exit condition:

```text
A planner can create work,
delegate it,
receive a result,
and update the plan.
```

---

## Phase 5 — Multi-Agent

Implement:

1. researcher agent
2. planner agent
3. communication queue
4. delegation
5. parent/child tasks
6. agent-scoped memory
7. shared/global memory rules

Exit condition:

```text
Multiple agents collaborate without sharing
all tools, memory, or context by default.
```

---

## Phase 6 — Optional Vector Retrieval

Implement:

1. embedding provider interface
2. vector store interface
3. no-op vector store
4. sqlite-vec adapter
5. Laya-gated semantic retrieval
6. hybrid reranking

Exit condition:

```text
Turning VECTOR_ENABLED=false
must not break the system.
```

---


# 37. Testing Strategy

Required tests:

## Unit tests

Test:

- agent routing
- confidence gating
- memory filtering
- graph conflict resolution
- tool permissions
- task updates
- plan transitions
- context budgeting

## Integration tests

Test:

```text
message
→ global routing
→ local Laya
→ retrieval
→ context
→ tool execution
→ LLM
→ persistence
```

## Regression tests

Create fixed scenarios such as:

```text
1. authentication debugging
2. repository search
3. database schema change
4. old fact replaced by new fact
5. agent delegation
6. tool failure
7. low-confidence Laya decision
8. vector-disabled mode
```

---

# 38. Metrics to Track

Track at least:

```text
total request latency
Laya latency
LLM latency
tool latency
context token count
tool schema token count
memory token count
number of retrieved memories
number of graph facts
main LLM invocation rate
vector retrieval invocation rate
tool success rate
routing confidence
agent handoff count
```

Important optimization metric:

```text
How often can the runtime avoid invoking
the expensive main LLM for trivial decisions?
```

---

# 39. Anti-Patterns

Do not:

```text
load one Laya model per agent
```

Do not:

```text
send every tool schema to every agent
```

Do not:

```text
send the entire history on every turn
```

Do not:

```text
treat vector retrieval as memory itself
```

Do not:

```text
store only summaries and delete raw history
```

Do not:

```text
let every agent access every memory automatically
```

Do not:

```text
allow Laya confidence to bypass security rules
```

Do not:

```text
tie the runtime to any external agent framework or client
```

---

# 40. Final Mental Model

```text
Laya
    fast decision intelligence
    "What should happen next?"

JEV
    structured knowledge/state intelligence
    "What do we know and how is it related?"

Memory Engine
    persistence intelligence
    "What should be remembered?"

Context Engine
    prompt intelligence
    "What does the current model need now?"

Tool Engine
    execution capability
    "What can the agent do?"

Agent
    responsibility boundary
    "Who owns this objective?"

Planner
    sequencing intelligence
    "What steps should achieve the objective?"

Main LLM
    deep reasoning/generation
    "What requires generative intelligence?"

Runtime/API
    system entry and execution boundary
    "How does the application enter and execute the agent workflow?"
```

---

# 41. Required First Deliverable

The first implementation milestone should support this exact flow:

```text
POST /api/v1/chat
        │
        ▼
save user message
        │
        ▼
global Laya
        │
        ▼
select coder/general agent
        │
        ▼
local agent Laya policy
        │
        ├── memory?
        ├── graph?
        ├── vector?
        ├── tool?
        └── LLM?
        │
        ▼
build minimal context
        │
        ▼
execute tool if needed
        │
        ▼
main LLM if needed
        │
        ▼
save response
        │
        ▼
update memory/JEV
        │
        ▼
return response
```

Do not implement multi-agent autonomous loops before this path is stable.

---

# 42. Definition of Done for V1

V1 is complete only when all of these are true:

- SQLite is the single required persistence layer.
- Vector search can be disabled completely.
- One shared Laya runtime is used.
- Agents have distinct Laya policies.
- Tools are filtered per agent.
- The main LLM does not receive all tools automatically.
- Memory retrieval is selective.
- JEV entities and relations can be stored and queried.
- Old graph facts can be deactivated when facts change.
- Tool outputs are stored and referenced by ID.
- Conversation history can be compressed without deleting raw messages.
- Every request produces an inspectable trace.
- The API runs as a completely standalone agent runtime.
- External integrations may be added later without affecting the core architecture.

---

# 43. Implementation Priority

The development agent should follow this order unless blocked:

```text
P0  database + migrations
P0  domain models
P0  repositories
P0  shared Laya runtime
P0  global routing
P0  one local agent policy
P0  tool registry
P0  orchestrator
P0  API
P0  tracing

P1  memory
P1  JEV graph
P1  context budgeting
P1  compression
P1  tool-result references

P2  tasks
P2  plans
P2  multi-agent delegation
P2  structured communication

P3  vector adapter
P3  sqlite-vec
P3  hybrid reranking

P4  optional external integrations
P4  UI/client adapters
P4  deployment and scaling refinements
```

---

# 44. Instruction to the Development Agent

Implement incrementally.

For each phase:

1. inspect existing code before modifying it
2. preserve separation between domain, storage, decisions, orchestration, and API
3. avoid introducing unnecessary infrastructure
4. keep SQLite as the default
5. keep vector storage optional
6. keep Laya shared across agents
7. put agent-specific behavior in policies
8. add tests with every new capability
9. add trace output for every important decision
10. do not continue to the next phase if the current phase is unstable

When a design decision is unclear:

```text
draft
→ recommend
→ ask
```

When the implementation path is clear:

```text
implement
→ test
→ fix
→ continue
```

The development agent should prefer a working, inspectable architecture over premature abstraction or distributed infrastructure.
