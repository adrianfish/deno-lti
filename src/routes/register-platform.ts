import { ENRICHMENT_FIELDS } from "../services/platform/enrichment-fields.ts";

import type { Context } from "hono";
import type { Platform, ToolOptions } from "../types.ts";
import type { Storage } from "../storage/storage.ts";
import type { LTIService } from "../services/lti-service.ts";
import type { EnrichmentField } from "../services/platform/enrichment-fields.ts";

export async function handleRegisterPlatform(
  c: Context,
  storage: Storage,
  service: LTIService,
  clientName: string,
  description: string,
  logoUri: string,
  options: ToolOptions,
): Promise<Response> {
  const openIdUrl: string = c.req.query("openid_configuration") || "";

  if (!openIdUrl) {
    c.status(400);
    return c.text("You must supply an openid_configuration parameter");
  }

  const openIdConfig = await fetch(openIdUrl)
    .then((r) => {
      if (r.ok) {
        return r.json();
      }
      throw new Error(`Network error while retrieving OpenId configuration from ${openIdUrl}`);
    })
    .catch((e) => console.error(e));

  if (options.debug) {
    console.debug("");
    console.debug(" ==== OPENID_CONFIG ====");
    console.debug(openIdConfig);
    console.debug("");
  }

  // Tier 1 enrichment: request profile picture / pronouns / … as custom
  // substitution variables, picking family-specific variables and dropping any
  // the platform doesn't advertise.
  const platformConfig = (openIdConfig?.["https://purl.imsglobal.org/spec/lti-platform-configuration"] ?? {}) as Record<
    string,
    unknown
  >;
  const familyCode = platformConfig["product_family_code"] as string | undefined;
  const supportedVariables = (platformConfig["variables"] ?? []) as string[];

  const customParameters = filterSupportedVariables(
    buildCustomParameters(familyCode, {
      "context_history": "$Context.id.history",
      ...(options.customParameters ?? {}),
    }),
    supportedVariables,
    options.debug,
  );

  const scopes = [
    "https://purl.imsglobal.org/spec/lti-reg/scope/registration.readonly",
    "openid",
    "https://purl.imsglobal.org/spec/lti-reg/scope/registration",
    "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
    "https://purl.imsglobal.org/spec/lti-ags/scope/score",
    "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
  ];

  const data = {
    "application_type": "web",
    "response_types": ["id_token"],
    "grant_types": ["implicit", "client_credentials"],
    "initiate_login_uri": `https://${service.toolDomain}/lti/login`,
    "redirect_uris": [`https://${service.toolDomain}/lti`],
    "client_name": clientName,
    "logo_uri": logoUri,
    "jwks_uri": `https://${service.toolDomain}/lti/keys`,
    "token_endpoint_auth_method": "private_key_jwt",
    "scope": scopes.join(" "),
    "https://purl.imsglobal.org/spec/lti-tool-configuration": {
      "domain": service.toolDomain,
      "description": description,
      "target_link_uri": `https://${service.toolDomain}/lti`,
      "custom_parameters": customParameters,
      "messages": [
        {
          "type": "LtiDeepLinkingRequest",
          "target_link_uri": `https://${service.toolDomain}/lti`,
          "label": "Add a language",
          "placements": [ "https://canvas.instructure.com/lti/assignment_selection" ],
        },
        {
          "type": "LtiResourceLinkRequest",
          "target_link_uri": `https://${service.toolDomain}/lti`,
          "placements": [ "course_navigation", "https://canvas.instructure.com/lti/course_navigation" ],
          "https://canvas.instructure.com/lti/course_navigation/default_enabled": true,
          "https://canvas.instructure.com/lti/display_type": "full_width_in_context",
        },
      ],
      "claims": ["sub", "name", "given_name", "family_name"],
    },
  };


  if (options.debug) {
    console.debug("DATA TO BE SENT");
    console.debug(data);
  }

  const registrationEndpoint = openIdConfig["registration_endpoint"];
  const registrationToken = c.req.query("registration_token");
  if (options.debug) console.debug(`Posting tool registration to ${registrationEndpoint}`);
  const platform = await fetch(registrationEndpoint, {
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${registrationToken}`,
    },
    method: "POST",
    body: JSON.stringify(data),
  })
    .then((r) => {
      if (r.ok || r.status === 400) {
        return r.json();
      }
      throw new Error(`Network error while registering at endpoint ${registrationEndpoint}. Status: ${r.status}`);
    })
    .then((d) => {
      if (options.debug) {
        console.debug("");
        console.debug(" ==== CLIENT_REGISTRATION_RESPONSE ====");
        console.debug(d);
        console.debug("");
      }

      return {
        url: openIdConfig.issuer as string,
        clientId: d.client_id as string,
        name: d.name as string,
        authEndpoint: openIdConfig.authorization_endpoint as string,
        accesstokenEndpoint: openIdConfig.token_endpoint as string,
        method: openIdConfig.token_endpoint_auth_methods_supported[0] as string,
        jwksUri: openIdConfig.jwks_uri as string,
        active: true,
      };
    })
    .catch((e) => console.error(e.message));

  if (options.debug) {
    console.debug("");
    console.debug(" ==== PLATFORM ====");
    console.debug(platform);
    console.debug("");
  }

  await service.registerPlatform(platform as Platform);

  return c.html("<script>(window.opener || window.parent).postMessage({subject:'org.imsglobal.lti.close'}, '*')</script>");
}

/**
 * Build the `custom_parameters` map to send at registration, choosing the
 * family-specific substitution variable where one is declared.
 *
 * @param familyCode The platform's `product_family_code`, if known.
 * @param extra Literal/extra custom parameters merged over the enrichment ones.
 */
function buildCustomParameters(
  familyCode?: string,
  extra: Record<string, string> = {},
): Record<string, string> {

  const params: Record<string, string> = {};
  for (const field: EnrichmentField of ENRICHMENT_FIELDS) {
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
function filterSupportedVariables(
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
