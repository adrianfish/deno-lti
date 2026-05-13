import type { Context } from "hono";
import type { Platform } from "../types.ts";
import type { Storage } from "../storage/storage.ts";
import type { LTIService } from "../services/lti-service.ts";

export async function handleRegisterPlatform(
  c: Context,
  storage: Storage,
  service: LTIService,
  debug: boolean = false,
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

  if (debug) {
    console.debug("");
    console.debug(" ==== OPENID_CONFIG ====");
    console.debug(openIdConfig);
    console.debug("");
  }

  const data = {
    "application_type": "web",
    "response_types": ["id_token"],
    "grant_types": ["implicit", "client_credentials"],
    "initiate_login_uri": `https://${service.toolDomain}/lti/login`,
    "redirect_uris": [`https://${service.toolDomain}/lti`],
    "client_name": "Dialang",
    "logo_uri": "http://bogus.org/dialang.png",
    "jwks_uri": `https://${service.toolDomain}/lti/keys`,
    "token_endpoint_auth_method": "private_key_jwt",
    "scope": "https://purl.imsglobal.org/spec/lti-reg/scope/registration.readonly openid https://purl.imsglobal.org/spec/lti-reg/scope/registration https://purl.imsglobal.org/spec/lti-ags/scope/lineitem https://purl.imsglobal.org/spec/lti-ags/scope/score https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
    "https://purl.imsglobal.org/spec/lti-tool-configuration": {
      "domain": service.toolDomain,
      "description": "Test your language skills.",
      "target_link_uri": `https://${service.toolDomain}/lti`,
      "custom_parameters": {
        "context_history": "$Context.id.history",
      },
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

  if (debug) {
    console.log("DATA TO BE SENT");
    console.log(data);
  }

  const registrationEndpoint = openIdConfig["registration_endpoint"];
  const registrationToken = c.req.query("registration_token");
  if (debug) console.debug(`Posting tool registration to ${registrationEndpoint}`);
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
      if (debug) {
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

  if (debug) {
    console.debug("");
    console.debug(" ==== PLATFORM ====");
    console.debug(platform);
    console.debug("");
  }

  await service.registerPlatform(platform as Platform);

  return c.html("<script>(window.opener || window.parent).postMessage({subject:'org.imsglobal.lti.close'}, '*')</script>");
}
