/**
 * LMS-specific NRPS extension blocks.
 *
 * Some platforms attach a proprietary object to each NRPS member carrying
 * properties that LTI 1.3 core does not (yet) define. Sakai uses `sakai_ext`.
 * We lift these onto the member's top level so callers see a flat, uniform
 * member object regardless of platform.
 *
 * This is deliberately future-proof. Should any of these properties be promoted
 * into LTI 1.3 core, the platform will start emitting them at the member top
 * level directly. Because lifting never overwrites an existing top-level value
 * (the same "native value wins" rule used by harvestCustom), the core value
 * automatically takes precedence and the extension block — if still present —
 * is ignored. No code change is required at that point; once a property is
 * fully core, removing the entry here is a one-liner.
 */

export interface LmsExtension {
  /** `product_family_code` identifying the platform. */
  family: string;
  /** The member-level container holding the proprietary properties. */
  extKey: string;
}

export const LMS_EXTENSIONS: LmsExtension[] = [
  { family: "sakailms.org", extKey: "sakai_ext" },
  { family: "sakai", extKey: "sakai_ext" },
];

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
export function liftExtensions(member: Record<string, unknown>, familyCode: string | undefined): void {

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
