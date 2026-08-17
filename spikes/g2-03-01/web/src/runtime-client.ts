import { UserManager } from "oidc-client-ts";

import { client } from "./generated/client.gen.ts";

const oidc = new UserManager({
  authority: "https://identity.example.invalid",
  client_id: "ontos-runtime-web-candidate",
  redirect_uri: `${globalThis.location.origin}/oidc/callback`,
  post_logout_redirect_uri: globalThis.location.origin,
  response_type: "code",
  scope: "openid profile ontos.runtime.read",
  loadUserInfo: false,
});

client.setConfig({
  baseUrl: "https://runtime.example.invalid",
  responseStyle: "fields",
  throwOnError: true,
  auth: async () => (await oidc.getUser())?.access_token,
});

export { client, oidc };
