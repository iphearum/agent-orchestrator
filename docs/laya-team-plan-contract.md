# Laya Team Plan Contract

Team Chat sends the user's objective and available worker roster in `state.team_plan_request`. For configured Laya models, the client serializes the bounded request, context, and roster as the text `state` expected by the laya-multilingual endpoint. Laya receives a `team` choice (`team` or `single`) and one `noul` question per relevant candidate worker (`team_worker_N`). The team choice uses `{ type: "choice", choice, confidence }`; worker answers use `{ type: "noul", noul }`.

When supported, Laya can return the full ordered graph in `routing.team_plan`:

```json
{
  "answers": {
    "agent": { "choice": "lead", "confidence": 0.95 },
    "team": { "type": "choice", "choice": "team", "confidence": 0.93 },
    "team_worker_0": { "type": "noul", "noul": 0.97 },
    "team_worker_1": { "type": "noul", "noul": 0.94 }
  },
  "routing": {
    "team_plan": {
      "objective": "Complete the user request",
      "tasks": [
        { "id": "inspect", "agent_id": "researcher", "instruction": "Inspect the relevant project behavior.", "depends_on": [] },
        { "id": "implement", "agent_id": "coder", "instruction": "Implement the requested change.", "depends_on": ["inspect"] },
        { "id": "review", "agent_id": "reviewer", "instruction": "Review the implementation and report issues.", "depends_on": ["implement"] }
      ]
    }
  }
}
```

## Client discussion before assignment

Team Chat starts in discussion mode. Discussion turns create no task or plan and save the user and assistant messages in the conversation. Team and individual-agent discussions use the selected model without tools. In Supervisor mode, the extension also asks up to three relevant agent profiles for advice before the Supervisor replies; a client can say “ask all agents” to consult every available agent. Consultations are tool-free and advisory: they use the conversation and supplied attachments, do not inspect the workspace or start work, and are synthesized into the Supervisor's reply. The reply trace shows which agents contributed. If an adviser fails, the remaining advisers and Supervisor can still answer.

The chat header keeps Team, Supervisor, and an individual-agent picker available as mode controls. Selecting a mode starts a fresh chat for that mode; the mode is stored with each conversation so chat history reopens it correctly. Supervisor's welcome text explains relevant-agent consultation and the “ask all agents” option.

The client starts orchestration by choosing **Assign task**. The latest bounded discussion turns are passed as context, followed by the final assignment prompt. That assignment then uses the normal Laya routing and team-plan flow below. A client can assign directly from a new chat with a final prompt.

The extension validates the whole graph before persistence: 1–12 tasks, unique task IDs, known agent IDs, non-empty bounded instructions, existing dependencies, and no self-dependency or cycles. If the service returns only typed answers and no graph, the extension creates one bounded work item for each positively selected worker, provided at least two workers were selected and Laya did not choose `single`. Those generated work items run in parallel; Laya still chooses the team membership, and the extension builds each instruction from the request and that worker's role. Invalid or missing plans fall back to the normal routed-agent path.

Laya-assigned work is a decision payload only. It cannot grant tools or approval, and workers cannot delegate beyond the accepted graph. Tool calls still use the normal per-agent grants and approval flow.
