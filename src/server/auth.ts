import { createHash } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { Config } from "../config/types.js";
import { AuthMethod } from "./authSessions.js";
import { canonicalOAuthResource, OAuthAccessTokenRecord, OAuthStore } from "./oauthStore.js";
import { constantTimeEqual } from "../util/crypto.js";

type AuthenticatedRequest = Request & {
  vibeAuthMethod?: AuthMethod;
  vibeOAuthToken?: string;
  vibeOAuthGrant?: OAuthAccessTokenRecord;
  vibeAuthPrincipal?: string;
};

function queryStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requestUrlToken(req: Request): string | undefined {
  return queryStringValue(req.params.urlToken) ?? queryStringValue(req.query.vibe_token);
}

function hasValidUrlToken(req: Request, config: Config): boolean {
  if (!config.allowUrlTokenAuth || !config.urlToken) return false;
  if (config.urlTokenExpiresAt && Date.now() >= Date.parse(config.urlTokenExpiresAt)) return false;
  return constantTimeEqual(requestUrlToken(req), config.urlToken);
}

export function getAuthMethod(req: Request): AuthMethod | undefined { return (req as AuthenticatedRequest).vibeAuthMethod; }
export function getOAuthToken(req: Request): string | undefined { return (req as AuthenticatedRequest).vibeOAuthToken; }
export function getOAuthGrant(req: Request): OAuthAccessTokenRecord | undefined { return (req as AuthenticatedRequest).vibeOAuthGrant; }
export function getAuthPrincipal(req: Request): string | undefined { return (req as AuthenticatedRequest).vibeAuthPrincipal; }

function setAuth(req: Request, method: AuthMethod, credential: string) {
  const auth = req as AuthenticatedRequest;
  auth.vibeAuthMethod = method;
  auth.vibeAuthPrincipal = `${method}:${createHash("sha256").update(credential).digest("hex")}`;
}

function bearerValue(header: string | undefined): string | undefined {
  return header?.match(/^Bearer[ \t]+([^\s]+)$/i)?.[1];
}

export function sendBearerUnauthorized(req: Request, res: Response, config: Config, invalid = false) {
  const resource = canonicalOAuthResource(config, `http://127.0.0.1:${req.socket.localPort ?? config.port}`)!;
  const metadata = resource.replace(/\/mcp$/, "/.well-known/oauth-protected-resource");
  const quote = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
  const challenge = `Bearer realm="vibe-codex"${config.enableExperimentalOAuth ? `, resource_metadata="${quote(metadata)}", scope="mcp"` : ""}${invalid ? ', error="invalid_token"' : ""}`;
  return res.setHeader("WWW-Authenticate", challenge).status(401).json({ error: {
    code: invalid ? "AUTH_INVALID" : "AUTH_REQUIRED",
    message: invalid ? "Authorization bearer token is invalid." : "Authorization bearer token is required.", details: {},
  } });
}

export function bearerAuth(config: Config, oauthStore?: OAuthStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.disableAuth) {
      (req as AuthenticatedRequest).vibeAuthPrincipal = "development:auth-disabled";
      return next();
    }
    const suppliedUrlToken = requestUrlToken(req);
    if (suppliedUrlToken && config.allowUrlTokenAuth) {
      if (hasValidUrlToken(req, config)) {
        setAuth(req, "url-token", suppliedUrlToken);
        return next();
      }
      return sendBearerUnauthorized(req, res, config, true);
    }
    const header = req.header("authorization");
    if (!header) return sendBearerUnauthorized(req, res, config);
    const token = bearerValue(header);
    const grant = config.enableExperimentalOAuth && token ? oauthStore?.verifyAccessToken(token) : null;
    if (grant) {
      const resource = canonicalOAuthResource(config, `http://127.0.0.1:${req.socket.localPort ?? config.port}`);
      if (grant.resource !== resource || !grant.scope.split(/\s+/).includes("mcp")) return sendBearerUnauthorized(req, res, config, true);
      const auth = req as AuthenticatedRequest;
      auth.vibeAuthMethod = "oauth";
      auth.vibeOAuthToken = token;
      auth.vibeOAuthGrant = grant;
      // Refresh rotation changes the token but not the approved grant's session identity.
      auth.vibeAuthPrincipal = `oauth:${grant.clientId}:${grant.grantId}`;
      return next();
    }
    if (!token || !config.relayToken || !constantTimeEqual(token, config.relayToken)) return sendBearerUnauthorized(req, res, config, true);
    setAuth(req, "bearer", token);
    return next();
  };
}
