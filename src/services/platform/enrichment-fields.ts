/**
 * Tier 1 NRPS enrichment — LTI custom variable substitution.
 *
 * Single source of truth for the fields we decorate members with (profile
 * pictures, pronouns, …). Each field is requested at *registration* time as an
 * LTI custom parameter and harvested back out of the per-member custom claim in
 * the NRPS feed. Because both sides are derived from the same table, adding a
 * decorated field is a one-line change here — no proprietary LMS API calls and
 * no extra credentials required.
 *
 * The substitution variable can vary per LMS (identified by
 * `product_family_code`), so a field may declare a default `variable` plus
 * `byFamily` overrides.
 */

export interface EnrichmentField {
  /** Custom-claim key requested at registration and read back from members. */
  param: string;
  /** Member property to populate from the harvested value. */
  memberProp: string;
  /** Default substitution variable, used when no family-specific one applies. */
  variable?: string;
  /** Per-`product_family_code` substitution variable overrides. */
  byFamily?: Record<string, string>;
}

export const ENRICHMENT_FIELDS: EnrichmentField[] = [
  {
    // Profile picture. `$User.image` is the core LTI substitution variable
    // (Core spec §B.1); Canvas exposes the avatar via its own variable instead.
    // Many platforms also surface a `picture` directly in the NRPS member
    // object, in which case harvesting leaves the native value untouched (see
    // harvestCustom).
    param: "user_image",
    memberProp: "picture",
    variable: "$User.image",
    byFamily: { canvas: "$Canvas.user.avatarUrl" },
  },
  {
    // Pronouns is not a core LTI variable; only request where a platform-
    // specific variable exists.
    param: "pronouns",
    memberProp: "pronouns",
    byFamily: { canvas: "$Canvas.user.pronouns", "sakai": "$User.pronouns", "sakailms.org": "$User.pronouns" },
  },
  {
    // Nickname is not a core LTI variable; only request where a platform-
    // specific variable exists.
    param: "nickname",
    memberProp: "nickname",
    byFamily: {"sakai": "$User.nickname", "sakailms.org": "$User.nickname" },
  },
];

/**
 * Build the `custom_parameters` map to send at registration, choosing the
 * family-specific substitution variable where one is declared.
 *
 * @param familyCode The platform's `product_family_code`, if known.
 * @param extra Literal/extra custom parameters merged over the enrichment ones.
 */
export function buildCustomParameters(
  familyCode?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const field of ENRICHMENT_FIELDS) {
    const variable = (familyCode && field.byFamily?.[familyCode]) ?? field.variable;
    if (variable) params[field.param] = variable;
  }
  return { ...params, ...extra };
}

/**
 * Drop substitution-variable parameters the platform doesn't advertise.
 *
 * Dynamic registration platform configuration may list the substitution
 * variables it supports (without the leading `$`). Requesting an unsupported
 * variable can cause some platforms to echo the raw `$Foo.bar` string back or
 * reject it, so when the list is present we filter to advertised variables only.
 * Literal parameters (anything not starting with `$`) are always kept.
 */
export function filterSupportedVariables(
  params: Record<string, string>,
  supportedVariables: string[] = [],
  debug = false,
): Record<string, string> {
  if (!supportedVariables.length) return params;

  const supported = new Set(supportedVariables);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value.startsWith("$") && !supported.has(value.slice(1))) {
      if (debug) console.debug(`Dropping unsupported custom parameter ${key}=${value}`);
      continue;
    }
    result[key] = value;
  }
  return result;
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
export function harvestCustom(
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
