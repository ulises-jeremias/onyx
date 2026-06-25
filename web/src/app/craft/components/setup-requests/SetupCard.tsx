"use client";

import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";

import { Button, Text } from "@opal/components";
import {
  ApprovalConflictError,
  postApprovalDecision,
} from "@/app/craft/services/apiServices";
import { startExternalAppOAuth } from "@/app/craft/services/externalAppsService";
import { ApprovalView } from "@/app/craft/types/approvals";
import {
  OAUTH_POPUP_MESSAGE_SOURCE,
  OAuthPopupMessage,
} from "@/app/craft/types/setupRequests";
import {
  ExternalAppUserResponse,
  getAppTypeLogo,
} from "@/app/craft/v1/apps/registry";
import UserCredentialsModal from "@/app/craft/v1/apps/UserCredentialsModal";
import { SWR_KEYS } from "@/lib/swr-keys";

interface SetupCardProps {
  // A connect-app ActionApproval (actions[0].action_type === CONNECT_APP_ACTION_TYPE).
  approval: ApprovalView;
  // The user-facing app row, when loaded — drives popup-vs-form + credential fields.
  userApp?: ExternalAppUserResponse;
}

const POPUP_FEATURES = "popup,width=520,height=720";
const POPUP_POLL_MS = 600;

/**
 * Connect-app card rendered for a `__connect_app__` approval. "Connect" runs the
 * OAuth popup (or the credential form for token apps); finishing records the
 * approval as APPROVED (→ the parked agent tool resumes), "Not now" as REJECTED.
 */
export default function SetupCard({ approval, userApp }: SetupCardProps) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credModalOpen, setCredModalOpen] = useState(false);

  const mountedRef = useRef(true);
  // Tears down the in-flight OAuth poll/listener; run on finish and on unmount.
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      cleanupRef.current?.();
    };
  }, []);

  const appName = approval.app_name;
  const reason = approval.actions[0]?.description ?? null;
  const externalAppId = approval.external_app_id;
  const supportsOauth = userApp?.supports_oauth ?? false;

  function revalidate() {
    void mutate(SWR_KEYS.buildSessionLiveApprovals(approval.session_id));
    void mutate(SWR_KEYS.buildExternalApps);
  }

  async function resolve(decision: "APPROVED" | "REJECTED") {
    try {
      await postApprovalDecision(approval.approval_id, decision);
    } catch (e) {
      // Already resolved (timed out, other device) — a revalidate reconciles.
      if (!(e instanceof ApprovalConflictError)) {
        console.error("Failed to resolve connect-app approval:", e);
      }
    } finally {
      revalidate();
    }
  }

  function awaitOAuthCompletion(popup: Window) {
    let settled = false;

    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Partial<OAuthPopupMessage> | undefined;
      if (data?.source !== OAUTH_POPUP_MESSAGE_SOURCE) return;
      if (data.externalAppId !== externalAppId) return;
      finish(true);
    }

    const poll = setInterval(() => {
      if (popup.closed) finish(false);
    }, POPUP_POLL_MS);
    window.addEventListener("message", onMessage);

    const teardown = () => {
      window.removeEventListener("message", onMessage);
      clearInterval(poll);
    };
    cleanupRef.current = teardown;

    function finish(connected: boolean) {
      if (settled) return;
      settled = true;
      teardown();
      cleanupRef.current = null;
      if (mountedRef.current) setBusy(false);
      if (connected) void resolve("APPROVED");
      else revalidate();
    }
  }

  async function connect() {
    setError(null);
    if (externalAppId === null) {
      setError("This app can't be set up from here.");
      return;
    }
    if (!supportsOauth) {
      if (userApp) {
        setCredModalOpen(true);
      } else {
        setError("This app needs setup on the Apps page.");
      }
      return;
    }

    setBusy(true);
    try {
      const { authorize_url } = await startExternalAppOAuth(externalAppId);
      const popup = window.open(authorize_url, "_blank", POPUP_FEATURES);
      if (!popup) {
        setBusy(false);
        setError(
          "Couldn't open the setup window — allow popups and try again."
        );
        return;
      }
      awaitOAuthCompletion(popup);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Failed to start setup");
    }
  }

  const Logo = getAppTypeLogo(userApp?.app_type ?? "CUSTOM");

  return (
    <div
      data-testid="setup-card"
      className="rounded-08 border border-status-info-03 bg-background-neutral-00 p-3 flex flex-col gap-2"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Logo className="size-5 shrink-0" />
        <Text font="main-ui-action" color="text-05" nowrap>
          {`Connect ${appName}`}
        </Text>
      </div>
      <Text font="secondary-body" color="text-03">
        {reason ?? `The agent needs ${appName} to continue this task.`}
      </Text>
      {error && (
        <Text font="secondary-body" color="text-03">
          {error}
        </Text>
      )}
      <div className="flex items-center justify-end gap-1">
        <Button
          prominence="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void resolve("REJECTED")}
        >
          Not now
        </Button>
        <Button
          prominence="primary"
          size="sm"
          disabled={busy}
          onClick={() => void connect()}
        >
          {busy ? "Waiting…" : `Connect ${appName}`}
        </Button>
      </div>
      {userApp && (
        <UserCredentialsModal
          open={credModalOpen}
          onClose={() => setCredModalOpen(false)}
          onSaved={() => void resolve("APPROVED")}
          userApp={userApp}
        />
      )}
    </div>
  );
}
