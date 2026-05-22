/**
 * Names and Role Provisioning (NRPS) — LTI 1.3
 */

import type { Storage } from "../storage/storage.ts";
import type { LTIToken } from "../types.ts";
import type { LTIService } from "./lti-service.ts";
import { HTTPHeaderLink, HTTPHeaderLinkEntry } from "@hugoalh/http-header-link";
import { requestAccessToken } from "./oauth.ts";

export class NamesAndRoleService {
  #storage: Storage;
  #aesKey: CryptoKey;
  #ltiService: LTIService;

  constructor(storage: Storage, aesKey: CryptoKey, ltiService: LTIService) {
    this.#storage = storage;
    this.#aesKey = aesKey;
    this.#ltiService = ltiService;
  }

  async loadUsers(
    membershipsUrl?: string | unknown,
    accessToken?: string,
    platformUrl?: string,
    clientId?: string,
    contextId?: string,
    user?: string,
  ): Promise<object | null> {
    if (!accessToken && !membershipsUrl && platformUrl && clientId) {
      const platform = await this.#ltiService.getPlatform(platformUrl, clientId);

      if (!platform) return null;

      accessToken = await requestAccessToken(
        this.#ltiService.toolDomain,
        platform.accesstokenEndpoint,
        platformUrl,
        clientId,
        this.#ltiService.buildKeyId(platform),
        ["https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly"],
        this.#storage,
        this.#aesKey,
      );

      const contextToken = await this.#storage.getContextToken(`${contextId}${user}`);

      membershipsUrl = contextToken?.namesRoles?.context_memberships_url;
      if (!membershipsUrl) throw new Error("No context_memberships_url in context");
      membershipsUrl += "?limit=10";
    }

    return fetch(membershipsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.ims.lti-nrps.v2.membershipcontainer+json",
        },
      })
      .then(async r => {
        if (r.ok) {
          const headers: HTTPHeaderLink = HTTPHeaderLink.parse(r.headers);
          const next: HTTPHeaderLinkEntry[] = headers.getByRel("next");

          if (next.length) {
            const users = await r.json();
            users.next = next.length ? next[0][0] : undefined;
            users.accessToken = accessToken;
            return users;
          }

          return r.json();
        } else {
          console.error(`Network error while getting users from ${membershipsUrl}: ${r.status}`);
          console.log(await r.json());
          return {};
        }
      });
  }
}
