/**
 * Assignment and Grade Service (AGS) — LTI 1.3
 */
import { requestAccessToken } from "./oauth.ts";
import { buildKeyId } from "../utils/platform-utils.ts";

import type { Storage } from "../storage/storage.ts";
import type { LineItem, LTIToken, Platform, StoredContextToken } from "../types.ts";

export interface Score {
  userId: string;
  scoreGiven?: number;
  scoreMaximum?: number;
  comment?: string;
  timestamp?: string;
  activityProgress: "Initialized" | "Started" | "InProgress" | "Submitted" | "Completed";
  gradingProgress: "FullyGraded" | "Pending" | "PendingManual" | "Failed" | "NotReady";
}

export interface Result {
  id: string;
  userId: string;
  resultScore?: number;
  resultMaximum?: number;
  comment?: string;
}

const AGS_SCOPE_LINEITEM = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem";
const AGS_SCOPE_LINEITEM_RO = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly";
const AGS_SCOPE_SCORE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";
const AGS_SCOPE_RESULT_RO = "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly";

export async function ensureLineItemsCached(
  storage: Storage,
  toolDomain: string,
  aesKey: CryptoKey,
  platformUrl: string,
  clientId: string,
  contextId: string,
  userId: string,
): Promise<void> {

  if (await storage.hasAnyLineItems(clientId, contextId)) {
    console.debug(`Line items already cached for clientId ${clientId}, contextId ${contextId}`);
    return;
  }

  const items: LineItem[] | null = await loadLineItems(storage, toolDomain, aesKey, platformUrl, clientId, contextId, userId);
  if (items) {
    items.forEach(item => storage.setLineItem(clientId, contextId, item));
  } else {
    console.warn("No items found");
  }
}

export async function getLineItems(
  storage: Storage,
  toolDomain: string,
  aesKey: CryptoKey,
  platformUrl: string,
  clientId: string,
  contextId: string,
  userId: string,
): Promise<LineItem[]> {

  await ensureLineItemsCached(storage, toolDomain, aesKey, platformUrl, clientId, contextId, userId);
  return storage.getLineItems(clientId, contextId);
}

/** Get all line items for the current context, following pagination. */
async function loadLineItems(
  storage: Storage,
  toolDomain: string,
  aesKey: CryptoKey,
  platformUrl: string,
  clientId: string,
  contextId: string,
  userId: string,
  options?: { resourceId?: string; tag?: string },
): Promise<LineItem[] | null> {

  const contextToken: StoredContextToken | null = await storage.getContextToken(`${contextId}${userId}`);

  if (!platformUrl || !clientId) {
    console.error("platformUrl and clientId must be supplied");
    return null;
  }

  const platform: Platform | null = await storage.getPlatform(platformUrl, clientId);
  if (!platform) return null;

  let url: URL;
  try {
    url = new URL(contextToken?.grades?.lineitems as string || "");
  } catch (error) {
    console.error(error);
    return null;
  }

  const requestedScopes = [ AGS_SCOPE_LINEITEM_RO, AGS_SCOPE_LINEITEM ];

  const accessToken = await requestAccessToken(
    toolDomain,
    platform.accesstokenEndpoint,
    platformUrl,
    clientId,
    buildKeyId(platform),
    requestedScopes,
    storage,
    aesKey,
  );

  if (!accessToken) {
    console.warn("Failed to get access token");
    return null;
  }

  if (options?.resourceId) url.searchParams.set("resource_id", options.resourceId);
  if (options?.tag) url.searchParams.set("tag", options.tag);

  return await fetchAllPages(url.toString(), accessToken, "application/vnd.ims.lis.v2.lineitemcontainer+json");
}

/** Create a new line item. */
export async function createLineItem(
  storage: Storage,
  toolDomain: string,
  aesKey: CryptoKey,
  platformUrl: string,
  clientId: string,
  token: LTIToken,
  lineItem: LineItem,
): Promise<LineItem | null> {

  const endpoint = token.platformContext.endpoint;
  if (!endpoint?.lineitems) throw new Error("No lineitems endpoint in context");

  if (!platformUrl || !clientId) {
    console.error("platformUrl and clientId must be supplied");
    return null;
  }

  const platform: Platform | null = await storage.getPlatform(platformUrl, clientId);
  if (!platform) return null;

  const accessToken = await requestAccessToken(
    toolDomain,
    platform.accesstokenEndpoint,
    platformUrl,
    clientId,
    buildKeyId(platform),
    [AGS_SCOPE_LINEITEM],
    storage,
    aesKey,
  );

  if (!accessToken) {
    console.warn("Failed to get access token");
    return null;
  }

  const res = await fetch(endpoint.lineitems as string, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/vnd.ims.lis.v2.lineitem+json",
    },
    body: JSON.stringify(lineItem),
  });

  if (!res.ok) throw new Error(`Failed to create line item: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Post a score to a line item. */
export async function postScore(
  storage: Storage,
  toolDomain: string,
  aesKey: CryptoKey,
  platformUrl: string,
  clientId: string,
  lineItemId: string,
  score: Score,
): Promise<void> {

  if (!platformUrl || !clientId) {
    console.error("platformUrl and clientId must be supplied");
    return;
  }

  const platform: Platform | null = await storage.getPlatform(platformUrl, clientId);
  if (!platform) return;

  const accessToken = await requestAccessToken(
    toolDomain,
    platform.accesstokenEndpoint,
    platformUrl,
    clientId,
    buildKeyId(platform),
    [AGS_SCOPE_SCORE],
    storage,
    aesKey,
  );

  if (!accessToken) {
    console.warn("Failed to get access token");
    return;
  }

  const scoreUrl = lineItemId.replace(/\/?$/, "/scores");
  const res = await fetch(scoreUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/vnd.ims.lis.v1.score+json",
    },
    body: JSON.stringify({
      ...score,
      timestamp: score.timestamp ?? new Date().toISOString(),
    }),
  });

  if (!res.ok) throw new Error(`Failed to post score: ${res.status} ${await res.text()}`);
}

/** Get results for a line item, following pagination. */
export async function getResults(
  storage: Storage,
  toolDomain: string, 
  aesKey: CryptoKey,
  platformUrl: string,
  clientId: string,
  contextId: string,
  userId: string,
  lineItemId: string
): Promise<Result[] | null> {

  const contextToken: StoredContextToken | null = await storage.getContextToken(`${contextId}${userId}`);

  if (!platformUrl || !clientId) {
    console.error("platformUrl and clientId must be supplied");
    return  [];
  }

  const platform: Platform | null = await storage.getPlatform(platformUrl, clientId);
  if (!platform) return null;

  const accessToken = await requestAccessToken(
    toolDomain,
    platform.accesstokenEndpoint,
    platformUrl,
    clientId,
    buildKeyId(platform),
    [AGS_SCOPE_RESULT_RO],
    storage,
    aesKey,
  );

  if (!accessToken) {
    console.warn("Failed to get access token");
    return [];
  }

  const resultsUrl = lineItemId.replace(/\/?$/, "/results");
  return fetchAllPages(resultsUrl, accessToken, "application/vnd.ims.lis.v2.resultcontainer+json");
}

async function fetchAllPages(
  url: string,
  accessToken: string,
  accept: string,
): Promise<any[]> {
  const all = [];
  let nextUrl: string | null = url;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": accept,
      },
    });

    if (!res.ok) throw new Error(`AGS request failed: ${res.status} ${await res.text()}`);

    const data = await res.json();
    all.push(...(Array.isArray(data) ? data : [ data ]));

    // Follow RFC 5988 Link: <url>; rel="next" header
    nextUrl = parseNextLink(res.headers.get("link"));
  }

  return all;
}

function parseNextLink(
  linkHeader: string | null
): string | null {

  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>.*rel="next"/);
    if (match) return match[1];
  }
  return null;
}
