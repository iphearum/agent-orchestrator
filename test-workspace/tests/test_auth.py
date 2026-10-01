import pytest

from src.auth.login import login


@pytest.mark.asyncio
async def test_login_success(fake_db):
    assert (await login("ana@example.com", "correct-horse"))["email"] == "ana@example.com"
