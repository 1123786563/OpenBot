/*
 * The independent identity center as a generic OAuth provider entry (#714/#715).
 *
 * Shaped the way `casdoor()` above it is: the identity center is its own deployment with its own
 * issuer, discovered against `/.well-known/openid-configuration`. OpenBot is a relying party here —
 * login happens at the identity center in the browser top level and comes back over a registered
 * code+PKCE callback; no session cookie is ever copied across origins (that is the organizationAuth
 * pattern this integration deliberately does not use).
 */

export function identityCenter(options: {
  clientId: string;
  clientSecret: string;
  issuer: string;
}) {
  const issuer = options.issuer.replace(/\/$/, "");
  return {
    providerId: "identity-center",
    accountIssuer: issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    scopes: ["openid", "profile", "email"],
  };
}
