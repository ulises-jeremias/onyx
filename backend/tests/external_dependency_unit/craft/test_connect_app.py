"""External-dependency-unit tests for connect-app requests.

Connect-app requests reuse the ``ActionApproval`` pipeline: this verifies the
synthetic-action mapping is a valid approval row that flows through the shared
db ops, plus the kept connectable-apps query + AGENTS rendering. The announce /
wake / decision rendezvous itself is covered by the action_approval / approvals
tests, since connect-app rides the exact same machinery.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable

from sqlalchemy.orm import Session

from onyx.db.enums import ApprovalDecision
from onyx.db.enums import EndpointPolicy
from onyx.db.external_app import get_connectable_apps_for_user
from onyx.db.models import BuildSession
from onyx.sandbox_proxy import approval_cache
from onyx.server.features.build.approvals.connect_app import (
    approve_connect_app_requests,
)
from onyx.server.features.build.approvals.connect_app import connect_app_action
from onyx.server.features.build.approvals.connect_app import CONNECT_APP_ACTION_TYPE
from onyx.server.features.build.approvals.connect_app import is_connect_app_approval
from onyx.server.features.build.db.action_approval import get_action_approval
from onyx.server.features.build.db.action_approval import insert_action_approval
from onyx.server.features.build.db.action_approval import (
    list_session_pending_action_approvals,
)
from onyx.server.features.build.db.action_approval import try_record_decision
from onyx.server.features.build.sandbox.util.agent_instructions import (
    build_connectable_apps_section,
)
from tests.external_dependency_unit.craft.db_helpers import make_external_app
from tests.external_dependency_unit.craft.db_helpers import make_skill
from tests.external_dependency_unit.craft.db_helpers import make_user
from tests.external_dependency_unit.craft.db_helpers import make_user_credential

_TOKEN_TEMPLATE = {"Authorization": "Bearer {api_token}"}


def test_connect_app_request_is_an_action_approval(
    db_session: Session,
    tenant_context: None,  # noqa: ARG001
    build_session_with_user: Callable[..., BuildSession],
) -> None:
    """A connect-app request is a valid ActionApproval (synthetic sentinel
    action), shows up in the shared live-pending list, and APPROVED resolves it
    (= connected) via the same arbiter."""
    bs = build_session_with_user()
    app = make_external_app(
        db_session, skill=make_skill(db_session), auth_template=_TOKEN_TEMPLATE
    )

    row = insert_action_approval(
        db_session,
        session_id=bs.id,
        actions=[connect_app_action(app.skill.name, "need it for the task")],
        app_name=app.skill.name,
        payload={},
        external_app_id=app.id,
    )
    db_session.commit()

    assert is_connect_app_approval(row.actions)
    assert row.actions[0]["action_type"] == CONNECT_APP_ACTION_TYPE
    assert row.actions[0]["policy"] == EndpointPolicy.ASK.value
    assert row.external_app_id == app.id

    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(
        seconds=approval_cache.WAIT_TIMEOUT_S
    )
    pending = list_session_pending_action_approvals(
        db_session, bs.id, created_after=cutoff
    )
    assert row.approval_id in {a.approval_id for a in pending}

    decided = try_record_decision(
        db_session,
        approval_id=row.approval_id,
        decision=ApprovalDecision.APPROVED,
    )
    assert decided is not None
    assert decided.decision == ApprovalDecision.APPROVED
    # No longer pending once resolved.
    assert get_action_approval(db_session, row.approval_id).decision == (
        ApprovalDecision.APPROVED
    )


def test_approve_connect_app_requests_resolves_pending(
    db_session: Session,
    tenant_context: None,  # noqa: ARG001
    build_session_with_user: Callable[..., BuildSession],
) -> None:
    """The server-side resolver (called when the credential is written) marks the
    pending connect-app approval APPROVED — independent of the frontend popup
    message — and is idempotent."""
    user = make_user(db_session)
    bs = build_session_with_user(user=user)
    app = make_external_app(
        db_session, skill=make_skill(db_session), auth_template=_TOKEN_TEMPLATE
    )
    row = insert_action_approval(
        db_session,
        session_id=bs.id,
        actions=[connect_app_action(app.skill.name, None)],
        app_name=app.skill.name,
        payload={},
        external_app_id=app.id,
    )
    db_session.commit()

    assert (
        approve_connect_app_requests(
            db_session, user_id=user.id, external_app_id=app.id
        )
        == 1
    )
    assert (
        get_action_approval(db_session, row.approval_id).decision
        == ApprovalDecision.APPROVED
    )
    # Idempotent — nothing left pending to resolve.
    assert (
        approve_connect_app_requests(
            db_session, user_id=user.id, external_app_id=app.id
        )
        == 0
    )


def test_get_connectable_apps_for_user(
    db_session: Session,
    tenant_context: None,  # noqa: ARG001
) -> None:
    """Connectable = enabled, requires per-user creds, user hasn't supplied them.
    Authenticated, org-credentialed, and disabled apps drop out."""
    user = make_user(db_session)

    needs_setup = make_external_app(
        db_session, skill=make_skill(db_session), auth_template=_TOKEN_TEMPLATE
    )
    already_connected = make_external_app(
        db_session, skill=make_skill(db_session), auth_template=_TOKEN_TEMPLATE
    )
    make_user_credential(
        db_session,
        app=already_connected,
        user=user,
        user_credentials={"api_token": "x"},
    )
    org_credentialed = make_external_app(
        db_session,
        skill=make_skill(db_session),
        auth_template={"Authorization": "Bearer {client_secret}"},
        organization_credentials={"client_secret": "s"},
    )
    disabled = make_external_app(
        db_session,
        skill=make_skill(db_session, enabled=False),
        auth_template=_TOKEN_TEMPLATE,
    )

    connectable_ids = {
        app.id for app in get_connectable_apps_for_user(db_session, user.id)
    }
    assert needs_setup.id in connectable_ids
    assert already_connected.id not in connectable_ids
    assert org_credentialed.id not in connectable_ids
    assert disabled.id not in connectable_ids


def test_build_connectable_apps_section(
    db_session: Session,
    tenant_context: None,  # noqa: ARG001
) -> None:
    """The section lists the app slug and points the agent at the connect tool;
    no connectable apps renders nothing."""
    skill = make_skill(db_session, slug="acme")
    app = make_external_app(db_session, skill=skill, auth_template=_TOKEN_TEMPLATE)

    section = build_connectable_apps_section([app])
    assert "acme" in section
    assert "request_app_setup" in section
    assert "Connectable apps" in section

    assert build_connectable_apps_section([]) == ""
