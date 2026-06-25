"""Connect-app request endpoint.

The agent's ``request_app_setup`` tool calls this (authenticated as the user via
the sandbox PAT) to ask the user to connect an external app it isn't set up for
yet. A connect-app request is modeled as an ``ActionApproval`` with a single
synthetic ``__connect_app__`` action, reusing the entire approval rendezvous:
it is announced on the live stream, rendered as a card, and resolved via
``POST /approvals/{id}/decision`` (APPROVED = connected, REJECTED = declined)
or server-side when the credential is written. ``create`` returns immediately
with a ``request_id``; the agent's tool polls ``GET /setup-requests/{id}`` with
short requests until resolved.
"""

from datetime import datetime
from datetime import timedelta
from datetime import timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter
from fastapi import Depends
from pydantic import BaseModel
from pydantic import ConfigDict
from sqlalchemy.orm import Session

from onyx.auth.permissions import require_permission
from onyx.cache.factory import get_cache_backend
from onyx.cache.interface import CACHE_TRANSIENT_ERRORS
from onyx.db.engine.sql_engine import get_session
from onyx.db.enums import ApprovalDecision
from onyx.db.enums import Permission
from onyx.db.external_app import get_external_app_by_slug
from onyx.db.external_app import get_external_app_user_credential
from onyx.db.external_app import is_user_authenticated_for_app
from onyx.db.models import User
from onyx.error_handling.error_codes import OnyxErrorCode
from onyx.error_handling.exceptions import OnyxError
from onyx.sandbox_proxy import approval_cache
from onyx.server.features.build.approvals.connect_app import connect_app_action
from onyx.server.features.build.approvals.connect_app import is_connect_app_approval
from onyx.server.features.build.db import action_approval
from onyx.server.features.build.db.build_session import get_build_session
from onyx.utils.logger import setup_logger
from shared_configs.contextvars import get_current_tenant_id

logger = setup_logger()

router = APIRouter(prefix="/setup-requests")


# Status relayed back to the agent's tool.
SetupStatus = Literal["connected", "declined", "pending"]


class CreateSetupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: UUID
    app_slug: str
    reason: str | None = None


class SetupStatusResponse(BaseModel):
    # request_id is None only when already connected (no approval was created).
    request_id: UUID | None
    status: SetupStatus
    external_app_id: int | None
    app_name: str


def _status_from_decision(decision: ApprovalDecision | None) -> SetupStatus:
    if decision == ApprovalDecision.APPROVED:
        return "connected"
    if decision == ApprovalDecision.REJECTED:
        return "declined"
    return "pending"


def _announce_best_effort(approval_id: UUID, session_id: UUID) -> None:
    try:
        cache = get_cache_backend(tenant_id=get_current_tenant_id())
        approval_cache.announce_approval(approval_id, session_id, cache)
    except CACHE_TRANSIENT_ERRORS as e:
        logger.warning(
            "appsetup.announce_failed approval_id=%s error=%s", approval_id, str(e)
        )


@router.post("")
def create_setup_request(
    body: CreateSetupRequest,
    user: User = Depends(require_permission(Permission.BASIC_ACCESS)),
    db_session: Session = Depends(get_session),
) -> SetupStatusResponse:
    """Ask the user to connect ``app_slug`` and return immediately.

    Short-circuits to ``connected`` when already authenticated. Otherwise creates
    (or reuses) a pending connect-app ``ActionApproval`` and returns its
    ``request_id`` with status ``pending``. The agent's tool then *polls*
    ``GET /setup-requests/{request_id}`` with short requests until resolved —
    rather than holding one long request open through the (flaky) egress tunnel,
    which is what dropped the result before."""
    if get_build_session(body.session_id, user.id, db_session) is None:
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "session not found")

    app = get_external_app_by_slug(db_session, body.app_slug)
    if app is None or not app.skill.enabled:
        raise OnyxError(
            OnyxErrorCode.NOT_FOUND, f"app '{body.app_slug}' not found or disabled"
        )

    user_cred = get_external_app_user_credential(
        db_session, external_app_id=app.id, user_id=user.id
    )
    if is_user_authenticated_for_app(app, user_cred):
        return SetupStatusResponse(
            request_id=None,
            status="connected",
            external_app_id=app.id,
            app_name=app.skill.name,
        )

    # Reuse an open connect-app approval for this session+app rather than stack cards.
    cutoff = datetime.now(timezone.utc) - timedelta(
        seconds=approval_cache.WAIT_TIMEOUT_S
    )
    pending = action_approval.list_session_pending_action_approvals(
        db_session, body.session_id, created_after=cutoff
    )
    existing = next(
        (
            a
            for a in pending
            if a.external_app_id == app.id and is_connect_app_approval(a.actions)
        ),
        None,
    )
    if existing is not None:
        approval_id = existing.approval_id
    else:
        row = action_approval.insert_action_approval(
            db_session,
            session_id=body.session_id,
            actions=[connect_app_action(app.skill.name, body.reason)],
            app_name=app.skill.name,
            payload={},
            external_app_id=app.id,
        )
        approval_id = row.approval_id
        db_session.commit()
        _announce_best_effort(approval_id, body.session_id)

    return SetupStatusResponse(
        request_id=approval_id,
        status="pending",
        external_app_id=app.id,
        app_name=app.skill.name,
    )


@router.get("/{request_id}")
def get_setup_request_status(
    request_id: UUID,
    user: User = Depends(require_permission(Permission.BASIC_ACCESS)),
    db_session: Session = Depends(get_session),
) -> SetupStatusResponse:
    """Poll a connect-app request's status (one short request per poll).

    The agent's tool calls this in a loop until ``connected``/``declined``."""
    approval = action_approval.get_action_approval_for_user(
        db_session, request_id, user.id
    )
    if approval is None:
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "setup request not found")
    return SetupStatusResponse(
        request_id=request_id,
        status=_status_from_decision(approval.decision),
        external_app_id=approval.external_app_id,
        app_name=approval.app_name,
    )
