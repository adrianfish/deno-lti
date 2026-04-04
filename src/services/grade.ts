/**
 * Assignment and Grade Service (AGS) — LTI 1.3
 */

import type { Storage } from "../storage/storage.ts";
import type { LTIToken } from "../types.ts";
import { getAccessToken } from "./oauth.ts";

export interface LineItem {
  id?: string;
  scoreMaximum: number;
  label: string;
  resourceId?: string;
  tag?: string;
  resourceLinkId?: string;
  [key: string]: unknown;
}

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

export class GradeService {
  #storage: Storage;
  #aesKey: CryptoKey;

  constructor(storage: Storage, aesKey: CryptoKey) {
    this.#storage = storage;
    this.#aesKey = aesKey;
  }

  /** Get all line items for the current context, following pagination. */
  async getLineItems(token: LTIToken, options?: { resourceId?: string; tag?: string }): Promise<LineItem[]> {
    const endpoint = token.platformContext.endpoint;
    if (!endpoint?.lineitems) throw new Error("No lineitems endpoint in context");

    const accessToken = await getAccessToken(
      token,
      [AGS_SCOPE_LINEITEM_RO, AGS_SCOPE_LINEITEM],
      this.#storage,
      this.#aesKey,
    );

    const url = new URL(endpoint.lineitems as string);
    if (options?.resourceId) url.searchParams.set("resource_id", options.resourceId);
    if (options?.tag) url.searchParams.set("tag", options.tag);

    return this.#fetchAllPages<LineItem>(url.toString(), accessToken, "application/vnd.ims.lis.v2.lineitemcontainer+json");
  }

  /** Create a new line item. */
  async createLineItem(token: LTIToken, lineItem: LineItem): Promise<LineItem> {
    const endpoint = token.platformContext.endpoint;
    if (!endpoint?.lineitems) throw new Error("No lineitems endpoint in context");

    const accessToken = await getAccessToken(
      token,
      [AGS_SCOPE_LINEITEM],
      this.#storage,
      this.#aesKey,
    );

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
  async postScore(token: LTIToken, lineItemId: string, score: Score): Promise<void> {
    const accessToken = await getAccessToken(
      token,
      [AGS_SCOPE_SCORE],
      this.#storage,
      this.#aesKey,
    );

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
  async getResults(token: LTIToken, lineItemId: string): Promise<Result[]> {
    const accessToken = await getAccessToken(
      token,
      [AGS_SCOPE_RESULT_RO],
      this.#storage,
      this.#aesKey,
    );

    const resultsUrl = lineItemId.replace(/\/?$/, "/results");
    return this.#fetchAllPages<Result>(resultsUrl, accessToken, "application/vnd.ims.lis.v2.resultcontainer+json");
  }

  async #fetchAllPages<T>(
    url: string,
    accessToken: string,
    accept: string,
  ): Promise<T[]> {
    const all: T[] = [];
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
      all.push(...(Array.isArray(data) ? data : [data]));

      // Follow RFC 5988 Link: <url>; rel="next" header
      nextUrl = parseNextLink(res.headers.get("link"));
    }

    return all;
  }
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>.*rel="next"/);
    if (match) return match[1];
  }
  return null;
}
