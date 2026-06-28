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
    param: "user_image",
    memberProp: "picture",
    variable: "$User.image",
    byFamily: { canvas: "$Canvas.user.avatarUrl" },
  },
  {
    param: "pronouns",
    memberProp: "pronouns",
    byFamily: { canvas: "$Canvas.user.pronouns", "sakai": "$User.pronouns", "sakailms.org": "$User.pronouns" },
  },
  {
    param: "nickname",
    memberProp: "nickname",
    byFamily: {"sakai": "$User.nickname", "sakailms.org": "$User.nickname" },
  },
  {
    param: "phoneticName",
    memberProp: "phoneticName",
    byFamily: {"sakai": "$User.phoneticname", "sakailms.org": "$User.phoneticname" },
  },
  {
    param: "mobile",
    memberProp: "mobile",
    byFamily: {"sakai": "$User.mobile", "sakailms.org": "$User.mobile" },
  },
];
