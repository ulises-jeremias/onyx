"""Shared user-seeding helpers for craft integration suites."""

from __future__ import annotations

import httpx

from onyx.auth.schemas import UserRole
from tests.integration.common_utils.constants import GENERAL_HEADERS
from tests.integration.common_utils.managers.user import build_email
from tests.integration.common_utils.managers.user import DEFAULT_PASSWORD
from tests.integration.common_utils.managers.user import UserManager
from tests.integration.common_utils.test_models import DATestUser


def _is_user_already_exists(response: httpx.Response) -> bool:
    # Only a 400 with detail REGISTER_USER_ALREADY_EXISTS counts; a malformed
    # request also 400s but must not be treated as "exists".
    if response.status_code == 409:
        return True
    if response.status_code != 400:
        return False
    try:
        body = response.json()
    except ValueError:
        return False
    return (
        isinstance(body, dict) and body.get("detail") == "REGISTER_USER_ALREADY_EXISTS"
    )


def create_or_login_admin(
    name: str, expected_role: UserRole | None = None
) -> DATestUser:
    """Create the named user, or log in if it already exists.

    When ``expected_role`` is provided, the resulting user's role is asserted
    against it; otherwise the login falls back to a BASIC role with no check.
    """
    try:
        user = UserManager.create(name=name)
    except httpx.HTTPStatusError as exc:
        if not _is_user_already_exists(exc.response):
            raise
        user = UserManager.login_as_user(
            DATestUser(
                id="",
                email=build_email(name),
                password=DEFAULT_PASSWORD,
                headers=GENERAL_HEADERS.copy(),
                role=expected_role or UserRole.BASIC,
                is_active=True,
            )
        )
    if expected_role is not None and user.role != expected_role:
        raise AssertionError(
            f"Expected {name} to have role {expected_role.value}, got {user.role.value}"
        )
    return user
