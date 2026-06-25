// Connect-app requests are ActionApproval rows with this sentinel action_type
// (mirrors backend approvals/connect_app.py). The approvals card detects it and
// renders a "Connect" card instead of approve/reject.
export const CONNECT_APP_ACTION_TYPE = "__connect_app__";

// postMessage source tag the OAuth callback popup sends back to its opener.
export const OAUTH_POPUP_MESSAGE_SOURCE = "onyx-external-app-oauth";

export interface OAuthPopupMessage {
  source: typeof OAUTH_POPUP_MESSAGE_SOURCE;
  externalAppId: number;
}
