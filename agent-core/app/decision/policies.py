from typing import Any


def yes_no(instructions: str) -> dict[str, Any]:
    return {"type": "choice", "instructions": instructions, "criteria": {
        "yes": "Yes, this capability is useful for the current request.",
        "no": "No, this capability is not needed for the current request.",
    }}


GLOBAL_POLICY = {
    "agent": {"type": "choice", "instructions": "Choose the best enabled agent for the user's request."},
    "needs_deep_reasoning": yes_no("Does the user's request need substantial generative reasoning?"),
}

CODER_POLICY = {
    "needs_memory": yes_no("Would previous project knowledge materially help with this programming request?"),
    "needs_graph": yes_no("Would project entities and their relationships materially help?"),
    "needs_vector": yes_no("Would semantic retrieval over historical memory materially help?"),
    "tool": {"type": "choice", "instructions": "Choose the most useful next granted tool category."},
    "delegate": {"type": "choice", "instructions": "Choose self unless another enabled specialist is clearly needed."},
    "needs_llm": yes_no("Does this request need a generative user-facing answer or code work?"),
}

GENERAL_POLICY = {
    "needs_memory": yes_no("Would relevant conversation memory materially help with this request?"),
    "needs_graph": yes_no("Would related project entities and facts materially help?"),
    "needs_vector": yes_no("Would semantic retrieval over historical memory materially help?"),
    "tool": {"type": "choice", "instructions": "Choose the most useful next granted tool category."},
    "needs_llm": yes_no("Does this request need a generative user-facing answer?"),
}

POLICIES = {"global": GLOBAL_POLICY, "coder": CODER_POLICY, "general": GENERAL_POLICY}
