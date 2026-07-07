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
   * Loads groups from the LTI Course Groups Service. This can be called in two ways. The first way
   * - with the groupsUrl and accessToken set to null and the rest of the params set - is usually
   * the way the first page of results is requested. An CGS implementation may well supply a url
   * and access token to get the next page, alongside the group objects. That url can be used with
   * the token in further calls to loadGroups and in that case only groupsUrl and accessToken will
   * be supplied.
   *
   * @param {string} groupsUrl The url of the platform's groups service
   * @param {string} accessToken An access tokem for retrieving the groups from the groupsUrl
   * @param {string} platformUrl Used to identify a registered platform
   * @param {string} clientId Used to identify a registered platform
   * @param {string} contextId Used to retrieve the context token
   * @param {string} user Used to retrieve the context token
   * @param {string} limit Number of groups to retrieve at a time
   *
   * @return {object} A js object with the groups
   */
  async #loadGroups(
    groupsUrl?: string | null,
    accessToken?: string | null,
    platformUrl?: string | null,
    clientId?: string | null,
    contextId?: string,
    user?: string,
  ): Promise<object | null> {

    const contextToken = await this.#storage.getContextToken(`${contextId}${user}`);
    const productFamilyCode = contextToken?.toolPlatform?.product_family_code;

    if (!accessToken && !groupsUrl && platformUrl && clientId) {
      const platform = await this.#ltiService.getPlatform(platformUrl, clientId);
      if (!platform) return null;

      groupsUrl = contextToken?.groups?.context_groups_url;
      if (!groupsUrl) {
        console.error("No context_groups_url supplied. Let's check product codes");
        if (productFamilyCode === "canvas") {
          console.debug("We're launching into Canvas. Return an empty groups list for now ...");
          return { groups: [] };
        } else {
        }
      }
      groupsUrl += `?limit=${limit || 20}`;

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
    }

    if (!accessToken) {
      console.debug("Still no accessToken. Not great :(");
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

  async #persistGroups(
    clientId: string,
    contextId: string,
    groups: object[] = []
  ): Promise<void> {

    for (const m of groups) await this.#storage.setGroup(clientId, contextId, m);
  }

  async #primeGroupsCache(
    platformUrl: string,
    clientId: string,
    contextId: string,
    userId: string,
  ): Promise<void> {

    if (await this.#storage.isGroupsCaching(clientId, contextId)) {
      // Another request is already filling the cache; wait until at least the first page is in.
      return;
    }

    this.#storage.setGroupsCaching(clientId, contextId);

    console.debug(`Getting first page of members for clientId ${clientId} and contextId ${contextId} ...`);
    const first = await this.#loadGroups(null, null, platformUrl, clientId, contextId, userId);
    if (!first) return;
    await this.#persistGroups(clientId, contextId, first.members);

    if (!first.next) {
      this.#storage.unsetGroupsCaching(clientId, contextId);
      return;
    }

    const drain = (async () => {
      let pageUrl: string | undefined = first.next;
      let accessToken: string | undefined = first.accessToken;
      let page = 2;
      while (pageUrl) {
        const result = await this.#loadGroups(pageUrl, accessToken, null, null, null, null);
        if (!result) break;
        await this.#persistGroups(clientId, contextId, result.members);
        console.debug(`Drained groups page ${page} for clientId ${clientId} and contextId ${contextId}`);
        pageUrl = result.next;
        accessToken = result.accessToken;
        page++;
      }
    })().finally(() => this.#storage.unsetGroupsCaching(clientId, contextId));
  }

  async ensureGroupsCached(
    platformUrl: string,
    clientId: string,
    contextId: string,
    userId: string,
  ): Promise<void> {

    if (await this.#storage.hasAnyGroups(clientId, contextId)) {
      console.debug(`Groups already cached for clientId ${clientId}, contextId ${contextId}`);
      return;
    }

    await this.#primeGroupsCache(platformUrl, clientId, contextId, userId);
  }
}
