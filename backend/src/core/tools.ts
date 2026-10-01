export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_workspace",
      description: "Find where something is: case-insensitive text search across the workspace. Returns matching lines with file paths and line numbers (a few per file). Use a short, specific term from the request; query must not be blank.",
      parameters: { type: "object", properties: { query: { type: "string", minLength: 1, description: "Required non-empty search term, such as a filename, symbol, or phrase." }, glob: { type: "string", description: "Optional workspace-relative glob such as src/**/*.ts." } }, required: ["query"], additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read part of a text file with line numbers (about 160 lines per call). For big files, call file_outline or search_workspace first, then read only the lines you need. Never re-read a range you already have.",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "Workspace-relative path." },
        start_line: { type: "integer", minimum: 1, description: "First line to read (1-based). Defaults to 1." },
        end_line: { type: "integer", minimum: 1, description: "Last line to read, inclusive. Defaults to about 160 lines after start_line." }
      }, required: ["path"], additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "file_outline",
      description: "Get the main points of a file without its body: classes, functions, methods, headings or top-level keys, each with its line number. Cheap; use it before read_file on large files.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path." } }, required: ["path"], additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or replace a UTF-8 text file inside the current workspace. User approval may be required.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path." }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "list_agents",
      description: "List all available specialist agents and their capabilities.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_agent",
      description: "Find agents whose skills match a capability or topic.",
      parameters: {
        type: "object",
        properties: {
          capability: { type: "string" }
        },
        required: ["capability"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "ask_agent",
      description: "Ask another agent a focused question. Use for consultation rather than ownership of a large subtask.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          question: { type: "string" }
        },
        required: ["agent_id", "question"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delegate_task",
      description: "Delegate a substantial subtask to another agent. The other agent owns the subtask and returns its result.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          instruction: { type: "string" }
        },
        required: ["agent_id", "instruction"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delegate_team",
      description: "Give parts of the work to several agents at once. Parts run in parallel; a part with \"after\" waits for those agents and gets their results (e.g. a reviewer after the coder). You get every result back and can then call more agents or answer.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: {
              type: "object",
              properties: {
                agent_id: { type: "string" },
                instruction: { type: "string", description: "What this agent should do and report back." },
                after: { type: "array", items: { type: "string" }, description: "agent_ids from this list whose results this part needs first." }
              },
              required: ["agent_id", "instruction"],
              additionalProperties: false
            }
          }
        },
        required: ["tasks"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Persist an important reusable project fact or decision.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
          scope: {
            type: "string",
            enum: ["private", "project"]
          }
        },
        required: ["content", "scope"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "Create a persisted plan for the current task with ordered steps.",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string" },
          steps: { type: "array", items: { type: "string" } }
        },
        required: ["objective", "steps"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remember_entity",
      description: "Remember a named thing in the project (a file, service, technology, table, concept…) so later requests can find it and its relationships. Types: concept, entity, event, technology, file, service, agent, task.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          data: { type: "object" }
        },
        required: ["name", "type"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remember_relation",
      description: "Record a project fact as source --predicate--> target (e.g. gateway uses_port 8080, api depends_on redis). Repeating a fact strengthens it. For single-valued predicates (uses_port, database, owned_by, runs_on, version, status) a new value replaces the old one, which is kept as history; other predicates add values.",
      parameters: {
        type: "object",
        properties: {
          source_name: { type: "string" }, source_type: { type: "string" },
          predicate: { type: "string" },
          target_name: { type: "string" }, target_type: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["source_name", "predicate", "target_name"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "expand_tool_result",
      description: "Read a slice of a stored tool result. Copy tool_run_id exactly from the shortened result; never guess it. Use the next offset suggested, and do not request the same offset twice.",
      parameters: {
        type: "object",
        properties: {
          tool_run_id: { type: "string" },
          offset: { type: "integer", minimum: 0, description: "Character offset to read; defaults to 0." },
          limit: { type: "integer", minimum: 500, maximum: 6000, description: "Maximum characters to return; defaults to 6000." }
        },
        required: ["tool_run_id"],
        additionalProperties: false
      }
    }
  }
];

export const FULL_ACCESS_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run an arbitrary shell command with the current user's permissions. This can read or change files anywhere on the computer and access the internet. Use only for actions needed to complete the user's request.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "A command for the operating system's default shell." } },
        required: ["command"],
        additionalProperties: false
      }
    }
  }
];
