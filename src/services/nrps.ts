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

  /**
   * Load some users from the nrps endpoint. This can be called in two ways. The first way - with
   * the membershipsUrl and accessToken set to null and the rest of the params set - is usually the
   * way the first page of results is requested. An NRPS implementation may well supply a url and
   * access token to get the next page, alongside the member objects. That url can be used with the
   * token in further calls to loadUsers and in that case only membershipsUrl and accessToken will
   * be supplied.
   *
   * @param {string} membershipsUrl The url of the results page to retrieve. This is returned by the
   *                 Platform in a JSON page of member results and then supplied in further calls.
   * @param {string} accessToken An access tokem for retrieving the page of results indicated by
   *                 membershipsUrl. This is returned by the Platform in a JSON page of member
   *                 results and then supplied in further calls.
   * @param {string} platformUrl Used to identify a registered platform and allow us to get the
   *                 context_memberships_url.
   * @param {string} clientId Used to identify a registered platform and allow us to get the
   *                 context_memberships_url.
   * @param {string} contextId Used to identify a registered platform and allow us to get the
   *                 context_memberships_url.
   * @param {string} user Used to identify a registered platform and allow us to get the
   *                 context_memberships_url.
   *
   * @return {object} A js object with the members and possibly the url for the next page of members
   */
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
