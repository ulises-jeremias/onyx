"""Connect-app requests modeled as ``ActionApproval`` rows.

A connect-app request — the agent asking the user to set up an external app it
isn't authenticated for — reuses the whole approval rendezvous (announce →
card → decision → wake). It is represented as an ``ActionApproval`` with a
single synthetic action whose ``action_type`` is the sentinel below, so the
frontend can render a "Connect" card instead of approve/reject, and the
decision maps APPROVED↔connected, REJECTED↔declined.
"""

from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from onyx.db.enums import ApprovalDecidedVia
from onyx.db.enums import ApprovalDecision
from onyx.db.enums import EndpointPolicy
from onyx.db.models import ActionApproval
from onyx.db.models import BuildSession
from onyx.server.features.build.db.action_approval import try_record_decision

# Sentinel action_type marking an approval as a connect-app request rather than
# a real gated egress action. Shared with the frontend (see SetupCard).
CONNECT_APP_ACTION_TYPE = "__connect_app__"


def connect_app_action(app_name: str, reason: str | None) -> dict[str, Any]:
    """The single synthetic ``MatchedAction``-shaped entry for a connect-app
    approval row."""
    return {
        "action_type": CONNECT_APP_ACTION_TYPE,
        "display_name": f"Connect {app_name}",
        "description": reason or f"Connect {app_name} to continue.",
        "policy": EndpointPolicy.ASK.value,
    }


def is_connect_app_approval(actions: list[dict[str, Any]]) -> bool:
    return bool(actions) and actions[0].get("action_type") == CONNECT_APP_ACTION_TYPE


def approve_connect_app_requests(
    db_session: Session,
    *,
    user_id: UUID,
    external_app_id: int,
) -> int:
    """Mark every pending connect-app approval for this user+app as APPROVED.

    Called when the user actually connects the app (credential written), so the
    parked agent tool resumes regardless of whether the frontend popup managed to
    post its completion message. Idempotent via the conditional-UPDATE arbiter.
    Returns the number resolved."""
    stmt = (
        select(ActionApproval)
        .join(BuildSession, BuildSession.id == ActionApproval.session_id)
        .where(BuildSession.user_id == user_id)
        .where(ActionApproval.external_app_id == external_app_id)
        .where(ActionApproval.decision.is_(None))
    )
    pending = [
        row
        for row in db_session.scalars(stmt).all()
        if is_connect_app_approval(row.actions)
    ]
    return sum(
        try_record_decision(
            db_session,
            approval_id=row.approval_id,
            decision=ApprovalDecision.APPROVED,
            decided_via=ApprovalDecidedVia.USER,
        )
        is not None
        for row in pending
    )
