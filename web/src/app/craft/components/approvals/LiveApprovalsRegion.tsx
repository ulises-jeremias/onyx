"use client";

import useSWR from "swr";

import { errorHandlingFetcher } from "@/lib/fetcher";
import ApprovalCard from "@/app/craft/components/approvals/ApprovalCard";
import SetupCard from "@/app/craft/components/setup-requests/SetupCard";
import { useLiveApprovals } from "@/app/craft/hooks/useLiveApprovals";
import { CONNECT_APP_ACTION_TYPE } from "@/app/craft/types/setupRequests";
import { ExternalAppUserResponse } from "@/app/craft/v1/apps/registry";
import { SWR_KEYS } from "@/lib/swr-keys";

interface LiveApprovalsRegionProps {
  sessionId: string | null;
}

// Renders one card per row returned by /live. Action approvals render an
// ApprovalCard; connect-app approvals (the __connect_app__ sentinel) render a
// SetupCard that drives the OAuth/credential flow. No outer logo/wrapper —
// caller places this under the previous assistant message.
export default function LiveApprovalsRegion({
  sessionId,
}: LiveApprovalsRegionProps) {
  const { data } = useLiveApprovals(sessionId);
  // Loaded only to resolve connect-app cards' app metadata (slug/oauth/fields).
  const { data: apps } = useSWR<ExternalAppUserResponse[]>(
    SWR_KEYS.buildExternalApps,
    errorHandlingFetcher
  );

  if (!sessionId || !data || data.items.length === 0) {
    return null;
  }

  const appsById = new Map((apps ?? []).map((app) => [app.id, app]));
  const sorted = [...data.items].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
  );

  return (
    <div data-testid="live-approvals-region" className="flex flex-col gap-3">
      {sorted.map((approval) =>
        approval.actions[0]?.action_type === CONNECT_APP_ACTION_TYPE ? (
          <SetupCard
            key={approval.approval_id}
            approval={approval}
            userApp={
              approval.external_app_id !== null
                ? appsById.get(approval.external_app_id)
                : undefined
            }
          />
        ) : (
          <ApprovalCard key={approval.approval_id} approval={approval} />
        )
      )}
    </div>
  );
}
