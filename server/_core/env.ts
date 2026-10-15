// Platform values are read at use time. See the Webdev service/authentication skills.
export const ENV = {
  get appId() { return process.env.MANUS_PROJECT_ID ?? ""; },
  get cookieSecret() { return process.env.MANUS_JWT_SECRET ?? ""; },
  get databaseUrl() { return process.env.DATABASE_URL ?? ""; },
  get oAuthServerUrl() { return process.env.MANUS_OAUTH_API_URL ?? ""; },
  // Preserve the legacy hint when supplied; otherwise roles remain application data.
  get ownerOpenId() { return process.env.OWNER_OPEN_ID ?? ""; },
  get ownerAccountId() { return process.env.GEOTWIN_OWNER_ACCOUNT_ID ?? ""; },
  get ownerEmail() { return process.env.GEOTWIN_OWNER_EMAIL ?? ""; },
  get isProduction() { return process.env.NODE_ENV === "production"; },
  get forgeApiUrl() { return process.env.BUILT_IN_FORGE_API_URL?.trim() || process.env.MANUS_API_URL?.trim() || ""; },
  get forgeApiKey() { return process.env.BUILT_IN_FORGE_API_KEY?.trim() || process.env.MANUS_API_KEY?.trim() || ""; },
};
