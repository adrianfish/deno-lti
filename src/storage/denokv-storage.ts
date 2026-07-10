import type { GroupTotals, MemberPage, Storage } from "./storage.ts";
import type { OidcStateData, Platform, StoredAccessToken, StoredContextToken, StoredIdToken } from "../types.ts";

const LIST_CHUNK = 200;

/**
 * DenoKVStorage — zero-dependency storage using Deno's built-in KV store.
 *
 * Key schema:
 *   ["platform", url, clientId]                → Platform
 *   ["platform_by_url", url, clientId]         → true  (index for list-by-url)
 *   ["key_public", kid]                        → encrypted public key string
 *   ["key_private", kid]                       → encrypted private key string
 *   ["idtoken", key]                           → StoredIdToken   (24h TTL)
 *   ["contexttoken", key]                      → StoredContextToken (24h TTL)
 *   ["nonce", nonce]                           → true  (10s TTL)
 *   ["state", state]                           → OidcStateData (10m TTL)
 *   ["accesstoken", platformUrl, clientId, scopes] → StoredAccessToken (1h TTL)
 *
 * Requires: --unstable-kv flag (or "unstable": ["kv"] in deno.json)
 */
export class DenoKVStorage implements Storage {
  #kv: Deno.Kv;

  private constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }

  static async open(kv?: Deno.Kv, path?: string): Promise<DenoKVStorage> {

    if (kv) return new DenoKVStorage(kv);
    return new DenoKVStorage(await Deno.openKv(path));
  }

  #accessTokenKey(
    platformUrl: string,
    clientId: string,
    requestedScopes: string
  ): Deno.KvKey {
    return [ "accesstoken", platformUrl, clientId, requestedScopes ];
  }

  #membersPrefix(clientId: string, contextId: string): Deno.KvKey {
    return [ "members", clientId, contextId ];
  }

  #groupsPrefix(clientId: string, contextId: string): Deno.KvKey {
    return [ "groups", clientId, contextId ];
  }

  #roleTotalsKey(clientId: string, contextId: string): Deno.KvKey {
    return [ "role-totals", clientId, contextId ];
  }

  #groupTotalsKey(clientId: string, contextId: string): Deno.KvKey {
    return [ "group-totals", clientId, contextId ];
  }

  #membersCachingKey(clientId: string, contextId: string): Deno.KvKey {
    return [ "members-caching", clientId, contextId ];
  }

  #groupsCachingKey(clientId: string, contextId: string): Deno.KvKey {
    return [ "groups-caching", clientId, contextId ];
  }

  // -------------------------------------------------------------------------
  // Platforms
  // -------------------------------------------------------------------------

  async savePlatform(platform: Platform): Promise<void> {
    await this.#kv.set(["platform", platform.url, platform.clientId], platform);
  }

  async getPlatform(url: string, clientId: string): Promise<Platform | null> {
    return (await this.#kv.get(["platform", url, clientId])).value;
  }

  async getPlatformsByUrl(url: string): Promise<Platform[]> {

    const results = [];
    for await (const entry of this.#kv.list({ prefix: ["platform", url] })) {
      if (entry.value) results.push(entry.value);
    }
    return results;
  }

  async getAllPlatforms(): Promise<Platform[]> {

    const results = [];
    for await (const entry of this.#kv.list({ prefix: ["platform"] })) {
      if (entry.value) results.push(entry.value);
    }
    return results;
  }

  async setPlatformActive(url: string, clientId: string, active: boolean): Promise<void> {

    const platform = await this.getPlatform(url, clientId);
    if (!platform) throw new Error(`Platform not found: ${url} / ${clientId}`);
    await this.#kv.set(["platform", url, clientId], { ...platform, active });
  }

  // -------------------------------------------------------------------------
  // Keypairs
  // -------------------------------------------------------------------------

  async saveKeyPair(
    kid: string,
    encryptedPublicKey: string,
    encryptedPrivateKey: string,
  ): Promise<void> {

    await this.#kv.set(["key_public", kid], encryptedPublicKey);
    await this.#kv.set(["key_private", kid], encryptedPrivateKey);
  }

  async getPublicKey(kid: string): Promise<string | null> {
    return (await this.#kv.get<string>(["key_public", kid])).value;
  }

  async getPrivateKey(kid: string): Promise<string | null> {
    return (await this.#kv.get<string>(["key_private", kid])).value;
  }

  async getAllPublicKeys(): Promise<Array<{ kid: string; encryptedKey: string }>> {

    const results = [];
    for await (const entry of this.#kv.list({ prefix: ["key_public"] })) {
      if (entry.value) {
        const kid = entry.key[1];
        results.push({ kid, encryptedKey: entry.value });
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // ID tokens
  // -------------------------------------------------------------------------

  async saveIdToken(key: string, token: StoredIdToken, ttlMs: number): Promise<void> {
    await this.#kv.set(["idtoken", key], token, { expireIn: ttlMs });
  }

  async getIdToken(key: string): Promise<StoredIdToken | null> {
    return (await this.#kv.get(["idtoken", key])).value;
  }

  // -------------------------------------------------------------------------
  // Context tokens
  // -------------------------------------------------------------------------

  async saveContextToken(
    key: string,
    token: StoredContextToken,
    ttlMs: number,
  ): Promise<void> {
    await this.#kv.set(["contexttoken", key], token, { expireIn: ttlMs });
  }

  async getContextToken(key: string): Promise<StoredContextToken | null> {
    return (await this.#kv.get<StoredContextToken>(["contexttoken", key])).value;
  }

  // -------------------------------------------------------------------------
  // Nonces
  // -------------------------------------------------------------------------

  async saveNonce(nonce: string, ttlMs: number): Promise<void> {
    await this.#kv.set(["nonce", nonce], true, { expireIn: ttlMs });
  }

  async hasNonce(nonce: string): Promise<boolean> {
    return (await this.#kv.get(["nonce", nonce])).value !== null;
  }

  // -------------------------------------------------------------------------
  // OIDC state
  // -------------------------------------------------------------------------

  async saveState(state: string, data: OidcStateData, ttlMs: number): Promise<void> {
    await this.#kv.set(["state", state], data, { expireIn: ttlMs });
  }

  async getState(state: string): Promise<OidcStateData | null> {
    return (await this.#kv.get<OidcStateData>(["state", state])).value;
  }

  async deleteState(state: string): Promise<void> {
    await this.#kv.delete(["state", state]);
  }

  // -------------------------------------------------------------------------
  // Access token cache
  // -------------------------------------------------------------------------

  async saveAccessToken(record: StoredAccessToken, ttlMs: number): Promise<void> {

    await this.#kv.set(
      this.#accessTokenKey(record.platformUrl, record.clientId, record.requestedScopes),
      record,
      { expireIn: ttlMs },
    );
  }

  async getAccessToken(
    platformUrl: string,
    clientId: string,
    requestedScopes: string,
  ): Promise<StoredAccessToken | null> {

    const entry = await this.#kv.get(this.#accessTokenKey(platformUrl, clientId, requestedScopes));
    if (!entry.value) return null;
    if (entry.value.expiresAt < Date.now()) return null;
    return entry.value;
  }

  async isMembersCaching(clientId: string, contextId: string): Promise<boolean> {
    return !!(await this.#kv.get(this.#membersCachingKey(clientId, contextId))).value;
  }

  async setMembersCaching(clientId: string, contextId: string): Promise<boolean> {
    return (await this.#kv.set(this.#membersCachingKey(clientId, contextId), true)).ok;
  }

  async unsetMembersCaching(clientId: string, contextId: string): Promise<void> {
    return await this.#kv.delete(this.#membersCachingKey(clientId, contextId));
  }

  async setMember(clientId: string, contextId: string, user: any): Promise<boolean> {

    let id = user.user_id;
    const index = id.lastIndexOf("/");
    if (index !== -1) id = id.substring(index + 1);

    delete user.lti11_legacy_user_id;
    delete user.lis_person_sourcedid;

    const expireIn: number = 15 * 60 * 1000;
    return (await this.#kv.set([ ...this.#membersPrefix(clientId, contextId), id ], user, { expireIn })).ok;
  }

  async hasAnyMembers(clientId: string, contextId: string): Promise<boolean> {

    // Try and get one user
    const iter = this.#kv.list({ prefix: this.#membersPrefix(clientId, contextId) }, { limit: 1 });
    for await (const _ of iter) return true;
    return false;
  }

  async getPageOfMembers(
    clientId: string,
    contextId: string,
    start: number,
    length: number,
    filter?: (object) => boolean,
    filteredCount?: number,
  ): Promise<MemberPage> {

    const prefix = this.#membersPrefix(clientId, contextId);

    // When the caller already knows the filtered count (no filter, or a
    // role/group filter whose count we cached) we only need to read the
    // start..start+length window and can stop the scan as soon as it is
    // full. We still need the unfiltered total for DataTables, so that also
    // has to be known up front — otherwise fall back to a full scan.
    const cachedTotal = (await this.getCachedGroupTotals(clientId, contextId))?.total;
    const windowed = filteredCount !== undefined && cachedTotal !== undefined && length > 0;

    const members = [];
    let recordsTotal = 0;
    let matched = 0;
    let cursor: string | undefined;

    while (true) {
      const iter = this.#kv.list({ prefix }, { cursor, limit: LIST_CHUNK });
      let seenInChunk = 0;
      let filled = false;
      for await (const entry of iter) {
        seenInChunk++;
        recordsTotal++;
        const user = entry.value;
        if (filter && !filter(user)) continue;
        if (matched >= start && members.length < length) members.push(user);
        matched++;
        if (windowed && members.length === length) {
          filled = true;
          break;
        }
      }
      if (filled) break;
      cursor = iter.cursor || undefined;
      if (!cursor || seenInChunk === 0) break;
    }

    return {
      members,
      recordsTotal: windowed ? cachedTotal : recordsTotal,
      recordsFiltered: filteredCount !== undefined ? filteredCount : matched,
    };
  }

  async getAllMembers(clientId: string, contextId: string): Promise<Array<object>> {

    const all = [];
    let cursor: string | undefined;
    while (true) {
      const iter = this.#kv.list({ prefix: this.#membersPrefix(clientId, contextId) }, { cursor, limit: LIST_CHUNK });
      let seen = 0;
      for await (const entry of iter) {
        seen++;
        all.push(entry.value);
      }
      cursor = iter.cursor || undefined;
      if (!cursor || seen === 0) break;
    }
    return all;
  }

  async getCachedRoleTotals(clientId: string, contextId: string): Promise<Record<string, number> | null> {
    return (await this.#kv.get(this.#roleTotalsKey(clientId, contextId))).value;
  }

  async getCachedGroupTotals(clientId: string, contextId: string): Promise<GroupTotals | null> {
    return (await this.#kv.get(this.#groupTotalsKey(clientId, contextId))).value;
  }

  async cacheTotals(clientId: string, contextId: string): Promise<Record<string, number>> {

    const totals = await this.getCachedRoleTotals(clientId, contextId);
    const groupTotalsCached = await this.getCachedGroupTotals(clientId, contextId);

    if (totals && groupTotalsCached) {
      console.debug(`Using cached totals for clientId ${clientId} and contextId ${contextId}.`);
      return totals;
    }

    console.debug(`Totals for clientId ${clientId} and contextId ${contextId} not cached. Building ...`);

    // A single pass over the members yields the per-role counts, the
    // per-group counts and the overall member total, so DataTables can page
    // without rescanning on every draw.
    const roleTotals: Record<string, number> = {};
    const groupTotals: GroupTotals = { total: 0, byGroup: {} };

    const all = await this.getAllMembers(clientId, contextId);
    for (const m of all) {
      groupTotals.total++;

      m.roles?.forEach(r => {
        roleTotals[r] = (roleTotals[r] ?? 0) + 1;
      });

      // Dedupe group ids so a member is counted once per group even if the
      // platform reports duplicate enrolments (matches the filter predicate).
      const groupIds = new Set<string>((m.group_enrollments ?? []).map(e => e.group_id));
      for (const groupId of groupIds) {
        groupTotals.byGroup[groupId] = (groupTotals.byGroup[groupId] ?? 0) + 1;
      }
    }

    await this.#kv.set(this.#roleTotalsKey(clientId, contextId), roleTotals);
    await this.#kv.set(this.#groupTotalsKey(clientId, contextId), groupTotals);

    return roleTotals;
  }

  async hasAnyGroups(clientId: string, contextId: string): Promise<boolean> {

    // Try and get one user
    const iter = this.#kv.list({ prefix: this.#groupsPrefix(clientId, contextId) }, { limit: 1 });
    for await (const _ of iter) return true;
    return false;
  }

  async isGroupsCaching(clientId: string, contextId: string): Promise<boolean> {
    return !!(await this.#kv.get(this.#groupsCachingKey(clientId, contextId))).value;
  }

  async setGroupsCaching(clientId: string, contextId: string): Promise<boolean> {
    return (await this.#kv.set(this.#groupsCachingKey(clientId, contextId), true)).ok;
  }

  async unsetGroupsCaching(clientId: string, contextId: string): Promise<void> {
    return await this.#kv.delete(this.#groupsCachingKey(clientId, contextId));
  }

  async setGroup(clientId: string, contextId: string, group: object): Promise<boolean> {

    const expireIn: number = 15 * 60 * 1000;
    return (await this.#kv.set([ ...this.#groupsPrefix(clientId, contextId), group.id ], group, { expireIn })).ok;
  }

  async getGroups(clientId: string, contextId: string): Promise<Array<object>> {

    const groups = [];
    let cursor: string | undefined;

    const prefix = this.#groupsPrefix(clientId, contextId);
    while (true) {
      const iter = this.#kv.list({ prefix }, { cursor, limit: LIST_CHUNK });
      for await (const entry of iter) {
        entry.value && groups.push(entry.value);
      }
      cursor = iter.cursor || undefined;
      if (!cursor) break;
    }

    return groups;
  }

  close(): void {
    this.#kv.close();
  }
}
