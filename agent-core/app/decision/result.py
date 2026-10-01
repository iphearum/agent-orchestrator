from typing import Any


def should_retrieve(answer: dict[str, Any] | None) -> bool:
    """Lower confidence means enrich/verify rather than trusting a negative gate."""
    if not answer:
        return False
    return bool(answer.get("value")) or answer.get("mode") in {"enrich", "reason"}


def should_invoke_llm(answer: dict[str, Any] | None) -> bool:
    if not answer:
        return True
    return bool(answer.get("value")) or answer.get("mode") != "execute"
