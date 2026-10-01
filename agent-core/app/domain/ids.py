from uuid import uuid4


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:12].upper()}"


def format_ref(scheme: str, object_id: str) -> str:
    return f"{scheme}://{object_id}"
