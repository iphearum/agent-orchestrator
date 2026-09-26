export const AGENT_TOOLS = [
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
      description: "Persist a named project entity for future relationship retrieval.",
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
