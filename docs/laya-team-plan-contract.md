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

The extension validates the whole graph before persistence: 1–12 tasks, unique task IDs, known agent IDs, non-empty bounded instructions, existing dependencies, and no self-dependency or cycles. If the service returns only typed answers and no graph, the extension creates one bounded work item for each positively selected worker, provided at least two workers were selected and Laya did not choose `single`. Those generated work items run in parallel; Laya still chooses the team membership, and the extension builds each instruction from the request and that worker's role. Invalid or missing plans fall back to the normal routed-agent path.

Laya-assigned work is a decision payload only. It cannot grant tools or approval, and workers cannot delegate beyond the accepted graph. Tool calls still use the normal per-agent grants and approval flow.
