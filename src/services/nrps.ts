/**
 * Names and Role Provisioning (NRPS) — LTI 1.3
 */

import { HTTPHeaderLink, HTTPHeaderLinkEntry } from "@hugoalh/http-header-link";
import { requestAccessToken } from "./oauth.ts";
import { buildFilter } from "../utils/filters.ts";
import { LMS_EXTENSIONS } from "./platform/extensions.ts";
import { ENRICHMENT_FIELDS } from "./platform/enrichment-fields.ts";

import type { DenoLTI } from "../deno-lti.ts";
import type { MemberPage, Storage } from "../storage/storage.ts";
import type { Platform, StoredContextToken } from "../types.ts";
import type { LTIService } from "./lti-service.ts";

/** A page of NRPS members, plus the cursor/token for the next page (if any). */
interface MembersPage {
  members: object[];
  next?: string;
  accessToken?: string;
}

/** The filter dimensions a roster page can be narrowed by. */
export interface MemberFilter {
  role?: string;
  groupId?: string;
  search?: string;
}

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
   * token in further calls to loadMembers and in that case only membershipsUrl and accessToken will
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
  async #loadMembers(
    membershipsUrl?: string | null,
    accessToken?: string | null,
    platformUrl?: string | null,
    clientId?: string | null,
    contextId?: string | null,
    user?: string | null,
  ): Promise<MembersPage | null> {

    const contextToken: StoredContextToken = await this.#storage.getContextToken(`${contextId}${user}`);
    const productFamilyCode = contextToken?.toolPlatform?.product_family_code;
    if (!accessToken && !membershipsUrl && platformUrl && clientId) {
      const platform: Platform = await this.#ltiService.getPlatform(platformUrl, clientId);

      if (!platform) return null;

      const requestedScopes = [
        "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
      ];

      accessToken = await requestAccessToken(
        this.#ltiService.toolDomain,
        platform.accesstokenEndpoint,
        platformUrl,
        clientId,
        this.#ltiService.buildKeyId(platform),
        requestedScopes,
        this.#storage,
        this.#aesKey,
      );

      membershipsUrl = contextToken?.namesRoles?.context_memberships_url as string | undefined;
      if (!membershipsUrl) throw new Error("No context_memberships_url in context");

      const rlid = contextToken?.namesRoles?.rlid || contextToken?.resource?.id;
      rlid && (membershipsUrl += `?rlid=${rlid}`);
    }

    if (!membershipsUrl) throw new Error("No membershipsUrl supplied to loadMembers");

    console.debug(`Retrieving users from ${membershipsUrl}`);

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

          const users = await r.json();
          users.members.forEach(m => {

            m.user_id = m.user_id.substring(m.user_id.lastIndexOf("/") + 1);

            const roles = new Set();

            // Remove the full namespace from the roles - nobody needs that.
            m.roles.forEach((r: string) => {

              const i = r.lastIndexOf("#");
              i !== -1 && roles.add(r.substring(i + 1));
            });

            m.roles = Array.from(roles);

            // Tier 1 enrichment: per-member custom params are delivered in the
            // message array under the custom claim. Harvest the configured
            // enrichment fields (pronouns, profile picture, …) onto the member.
            const custom = m.message?.[0]?.["https://purl.imsglobal.org/spec/lti/claim/custom"];
            this.#harvestCustom(m, custom);

            // Now delete the message property. Clients of this lib don't, or shouldn't need to know
            // about LTI specific stuff. Ideally, anyway :)
            delete m.message;

            // Lift LMS-specific extension blocks (e.g. Sakai's sakai_ext) onto
            // the member top level. No-op for platforms without one, and a
            // no-op for any property that has graduated to LTI core.
            this.#liftExtensions(m, productFamilyCode);
          });

          if (next.length) {
            users.next = next.length ? next[0][0] : undefined;
            users.accessToken = accessToken;
          }

          return users;
        } else {
          console.error(`Network error while getting users from ${membershipsUrl}: ${r.status}`);
          console.error(await r.json());
          return {};
        }
      });
  }

  async getPageOfMembers(
    platformUrl: string,
    clientId: string,
    contextId: string,
    userId: string,
    start: number,
    length: number,
    filterSpec: MemberFilter = {},
  ): Promise<MemberPage> {

    await this.ensureMembersCached(platformUrl, clientId, contextId, userId);

    const { role, groupId, search } = filterSpec;
    const filter = buildFilter(role, groupId, search);
    const filteredCount = await this.#filteredCount(clientId, contextId, role, groupId, search);

    return this.#storage.getPageOfMembers(clientId, contextId, start, length, filter, filteredCount);
  }

  /**
   * Work out how many members match a filter without scanning the roster,
   * using the cached role/group totals. Returns undefined when the count
   * cannot be served from cache (a free-text search, or a combined
   * role+group filter whose intersection we do not cache) — the caller then
   * falls back to a counting scan.
   */
  async #filteredCount(
    clientId: string,
    contextId: string,
    role?: string,
    groupId?: string,
    search?: string,
  ): Promise<number | undefined> {

    const roleActive = !!role && role !== "all";
    const groupActive = !!groupId && groupId !== "all";
    const searchActive = !!search?.trim();

    // Free text can match any field, and role∩group is not precomputed.
    if (searchActive) return undefined;
    if (roleActive && groupActive) return undefined;

    const groupTotals = await this.#storage.getCachedGroupTotals(clientId, contextId);
    if (!groupTotals) return undefined;

    if (roleActive) {
      const roleTotals = await this.#storage.getCachedTotals(clientId, contextId);
      return roleTotals?.[role] ?? 0;
    }

    if (groupActive) return groupTotals.byGroup[groupId] ?? 0;

    return groupTotals.total;
  }

  async isMembersCacheBuilding(
    clientId: string,
    contextId: string
  ): Promise<boolean> {

    return await this.#storage.isMembersCaching(clientId, contextId);
  }

  async #persistMembers(
    clientId: string,
    contextId: string,
    members: object[] = []
  ): Promise<void> {

    for (const m of members) await this.#storage.setMember(clientId, contextId, m);
  }

  async #primeMembersCache(
    platformUrl: string,
    clientId: string,
    contextId: string,
    userId: string,
  ): Promise<void> {

    if (await this.#storage.isMembersCaching(clientId, contextId)) {
      // Another request is already filling the cache; wait until at least the first page is in.
      console.debug(`The members for ${clientId} and ${contextId} are currently being cached.`);
      return;
    }

    this.#storage.setMembersCaching(clientId, contextId);

    console.debug(`Getting first page of members for clientId ${clientId} and contextId ${contextId} ...`);
    const first = await this.#loadMembers(null, null, platformUrl, clientId, contextId, userId);
    if (!first) return;
    await this.#persistMembers(clientId, contextId, first.members);

    if (!first.next) {
      console.debug(`Only one page of members for clientId ${clientId} and contextId ${contextId}. Unsetting the caching flag, calculating the totals and returning ...`);
      this.#storage.unsetMembersCaching(clientId, contextId);
      await this.#storage.cacheTotals(clientId, contextId);
      return;
    }

    const drain = (async () => {
      let pageUrl: string | undefined = first.next;
      let accessToken: string | undefined = first.accessToken;
      let page = 2;
      while (pageUrl) {
        const result = await this.#loadMembers(pageUrl, accessToken, null, null, null, null);
        if (!result) break;
        await this.#persistMembers(clientId, contextId, result.members);
        console.debug(`Drained members page ${page} for clientId ${clientId} and contextId ${contextId}`);
        pageUrl = result.next;
        accessToken = result.accessToken;
        page++;
      }
      await this.#storage.cacheTotals(clientId, contextId);
    })().finally(() => this.#storage.unsetMembersCaching(clientId, contextId));
  }

  async ensureMembersCached(
    platformUrl: string,
    clientId: string,
    contextId: string,
    userId: string,
  ): Promise<void> {

    if (await this.#storage.hasAnyMembers(clientId, contextId)) {
      console.debug(`Members already cached for clientId ${clientId}, contextId ${contextId}`);
      return;
    }

    await this.#primeMembersCache(platformUrl, clientId, contextId, userId);
  }

  async getCachedTotals(
    clientId: string,
    contextId: string,
  ): Promise<Record<string, string>> {

    return await this.#storage.getCachedTotals(clientId, contextId);
  }

  /**
   * Harvest enrichment fields out of a member's custom claim and onto the member.
   *
   * Native NRPS fields win: an existing truthy member property is never
   * overwritten, so this only ever *fills gaps*. Unresolved substitution
   * variables (values still beginning with `$`) and empty values are ignored.
   *
   * @param member The NRPS member object to decorate (mutated in place).
   * @param custom The member's custom claim, e.g. `member.message[0][".../custom"]`.
   */
  #harvestCustom(
    member: Record<string, unknown>,
    custom: Record<string, unknown> | undefined,
  ): void {

    if (!custom) return;

    for (const field of ENRICHMENT_FIELDS) {
      if (member[field.memberProp]) continue; // native value wins
      const value = custom[field.param];
      if (typeof value !== "string") continue;
      if (value === "" || value.startsWith("$")) continue; // empty / unresolved
      member[field.memberProp] = value;
    }
  }

  /**
   * Lift a platform's extension-block properties onto the member top level.
   *
   * Native/core member properties win: an existing top-level value is never
   * overwritten, so this only ever fills gaps. This makes the lift a no-op the
   * moment a property graduates to LTI 1.3 core and is emitted natively.
   *
   * @param member The NRPS member object to decorate (mutated in place).
   * @param familyCode The platform's `product_family_code`, if known.
   */
  #liftExtensions(member: Record<string, unknown>, familyCode: string | undefined): void {

    if (!familyCode) return;

    for (const { family, extKey } of LMS_EXTENSIONS) {
      if (family !== familyCode) continue;
      const ext = member[extKey];

      if (!ext || typeof ext !== "object") continue;
      for (const [key, value] of Object.entries(ext)) {
        if (member[key] !== undefined) continue; // native / core value wins
        member[key] = value;
      }

      // Now remove the ext section from the member. This doesn't need to go back to the calling client
      delete member[extKey];
    }
  }
}
