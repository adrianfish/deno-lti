/**
 * Course Groups — LTI 1.3
 */

import type { Storage } from "../storage/storage.ts";
import type { LTIToken } from "../types.ts";
import type { LTIService } from "./lti-service.ts";
import { HTTPHeaderLink, HTTPHeaderLinkEntry } from "@hugoalh/http-header-link";
import { requestAccessToken } from "./oauth.ts";

export class GroupsService {
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
   * @param {string} limit Number of members to retrieve at a time
   * @param {string} role The role of the members to retrieve
   *
   * @return {object} A js object with the members and possibly the url for the next page of members
   */
  async loadGroups(
    groupsUrl?: string | unknown,
    accessToken?: string,
    platformUrl?: string,
    clientId?: string,
    contextId: string,
    user: string,
    limit: number,
  ): Promise<object | null> {

    const contextToken = await this.#storage.getContextToken(`${contextId}${user}`);
    const productFamilyCode = contextToken?.toolPlatform?.product_family_code;
    if (!accessToken && !groupsUrl && platformUrl && clientId) {
      const platform = await this.#ltiService.getPlatform(platformUrl, clientId);

      if (!platform) return null;

      accessToken = await requestAccessToken(
        this.#ltiService.toolDomain,
        platform.accesstokenEndpoint,
        platformUrl,
        clientId,
        this.#ltiService.buildKeyId(platform),
        ["https://purl.imsglobal.org/spec/lti-gs/scope/contextgroup.readonly"],
        this.#storage,
        this.#aesKey,
      );

      groupsUrl = contextToken?.groups?.context_groups_url;
      if (!groupsUrl) throw new Error("No context_groups_url in context");
      groupsUrl += `?limit=${limit || 20}`;
    }

    console.debug(`Retrieving groups from ${groupsUrl}`);

    return fetch(groupsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.ims.lti-gs.v1.contextgroupcontainer+json",
        },
      })
      .then(async r => {
        if (r.ok) {
          const headers: HTTPHeaderLink = HTTPHeaderLink.parse(r.headers);
          const next: HTTPHeaderLinkEntry[] = headers.getByRel("next");

          const groups = await r.json();

          if (next.length) {
            groups.next = next.length ? next[0][0] : undefined;
            groups.accessToken = accessToken;
          }

          return groups;
        } else {
          console.error(`Network error while getting groups from ${groupsUrl}: ${r.status}`);
          console.error(await r.json());
          return {};
        }
      });
  }
}
