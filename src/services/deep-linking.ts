/**
 * Deep Linking Service (LTI 1.3 Content Item Selection)
 */

import { SignJWT } from "jose";
import { getPrivateKey } from "../auth/keys.ts";
import type { Storage } from "../storage/storage.ts";
import type { ContentItem, LTIToken } from "../types.ts";

/**
 * Create an auto-submitting HTML form that posts the Deep Linking response
 * back to the platform.
 *
 * @param token - The LTI token from the current session (res.locals.token equivalent)
 * @param items - Content items to return to the platform
 * @param storage - Storage (to retrieve the private key)
 * @param aesKey - AES key for decrypting stored private key
 * @param toolUrl - The tool's own URL (used as iss in the response JWT)
 */
export async function createDeepLinkingForm(
  token: LTIToken,
  items: ContentItem[],
  storage: Storage,
  aesKey: CryptoKey,
  toolUrl: string,
): Promise<string> {
  const message = await createDeepLinkingMessage(token, items, storage, aesKey, toolUrl);
  const returnUrl = token.platformContext.deepLinkingSettings?.deep_link_return_url || "";

  // Auto-submitting form
  return `<!DOCTYPE html>
<html>
<head><title>Deep Linking Response</title></head>
<body>
  <form id="dlForm" method="POST" action="${escapeHtml(returnUrl as string)}">
    <input type="hidden" name="JWT" value="${escapeHtml(message)}" />
  </form>
  <script>document.getElementById('dlForm').submit();</script>
</body>
</html>`;
}

/**
 * Create a signed Deep Linking response JWT.
 * The caller can embed this in a form or return it directly.
 */
export async function createDeepLinkingMessage(
  token: LTIToken,
  items: ContentItem[],
  storage: Storage,
  aesKey: CryptoKey,
  toolUrl: string,
): Promise<string> {
  const settings = token.platformContext.deepLinkingSettings;

  const kid = `${token.iss}\$\$${token.clientId}`;
  const privateKey = await getPrivateKey(kid, storage, aesKey);

  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingResponse",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": token.deploymentId,
    "https://purl.imsglobal.org/spec/lti-dl/claim/content_items": items,
    "https://purl.imsglobal.org/spec/lti-dl/claim/data": settings?.data,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(toolUrl)
    .setAudience(token.iss)
    .setSubject(token.user)
    .setIssuedAt(now)
    .setExpirationTime(now + 600) // 10-minute validity
    .sign(privateKey);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
