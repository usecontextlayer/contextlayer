/**
 * The single platform audience. One `aud=urn:ctx:platform` token is accepted by every
 * resource server (base-platform, slate-platform, web's redemption endpoint);
 * product isolation lives in the membership rows, not the audience.
 *
 * Kept import-free: the barrel-free `ctx-machine-token` entry value-imports it, so
 * anything imported here lands in that entry's bundle too.
 */
export const CTX_TOKEN_AUDIENCE = "urn:ctx:platform"
