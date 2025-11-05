import { createHash, timingSafeEqual } from "crypto";
import { SunsamaClient } from "sunsama-api/client";
import type { AuthMethod, SessionData } from "./types.js";
import { getSessionConfig } from "../config/session-config.js";
import { getMcpAuthToken } from "../config/transport.js";

// Client cache with TTL management (keyed by credential hash for security)
const clientCache = new Map<string, SessionData>();

// Pending authentication promises to prevent race conditions
const authPromises = new Map<string, Promise<SessionData>>();

// Configuration - loaded from environment
const sessionConfig = getSessionConfig();
const CLIENT_IDLE_TIMEOUT = sessionConfig.CLIENT_IDLE_TIMEOUT;
const CLIENT_MAX_LIFETIME = sessionConfig.CLIENT_MAX_LIFETIME;
const CLEANUP_INTERVAL = sessionConfig.CLEANUP_INTERVAL;

/**
 * Parse HTTP Basic Auth credentials from Authorization header
 */
export function parseBasicAuth(authHeader: string): { email: string; password: string } {
  const base64Credentials = authHeader.replace('Basic ', '');
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const colonIndex = credentials.indexOf(':');

  if (colonIndex === -1) {
    throw new Error("Invalid Basic Auth format");
  }

  const email = credentials.substring(0, colonIndex);
  const password = credentials.substring(colonIndex + 1);

  if (!email || password === undefined) {
    throw new Error("Invalid Basic Auth format");
  }

  return { email, password };
}

/**
 * Parse Bearer token from Authorization header
 */
export function parseBearerToken(authHeader: string): string {
  const token = authHeader.replace('Bearer ', '');

  if (!token) {
    throw new Error("Invalid Bearer token format");
  }

  return token;
}

/**
 * Timing-safe token comparison to prevent timing attacks
 */
export function validateToken(providedToken: string, expectedToken: string): boolean {
  if (!providedToken || !expectedToken) {
    return false;
  }

  // Convert strings to Uint8Array for timing-safe comparison
  const providedBuffer = new Uint8Array(Buffer.from(providedToken));
  const expectedBuffer = new Uint8Array(Buffer.from(expectedToken));

  // If lengths differ, use a dummy comparison to maintain constant time
  if (providedBuffer.length !== expectedBuffer.length) {
    // Compare against itself to maintain timing consistency
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Generate secure cache key from credentials
 * Uses SHA-256 hash to prevent authentication bypass vulnerability
 */
function getCacheKey(email: string, password: string): string {
  return createHash('sha256')
    .update(`${email}:${password}`)
    .digest('hex');
}

/**
 * Generate cache key for token-based authentication
 * Uses a special prefix to distinguish from credential-based keys
 */
function getTokenCacheKey(token: string): string {
  return createHash('sha256')
    .update(`token:${token}`)
    .digest('hex');
}

/**
 * Check if a cached client is still valid based on TTL
 */
function isClientValid(sessionData: SessionData): boolean {
  const now = Date.now();
  const idleTime = now - sessionData.lastAccessedAt;
  const lifetime = now - sessionData.createdAt;

  return idleTime < CLIENT_IDLE_TIMEOUT && lifetime < CLIENT_MAX_LIFETIME;
}

/**
 * Cleanup expired clients from cache
 */
function cleanupExpiredClients(): void {
  const now = Date.now();

  for (const [cacheKey, sessionData] of clientCache.entries()) {
    if (!isClientValid(sessionData)) {
      console.error(`[Client Cache] Expiring stale client for ${sessionData.email}`);
      try {
        sessionData.sunsamaClient.logout();
      } catch (err) {
        console.error(`[Client Cache] Error logging out client for ${sessionData.email}:`, err);
      }
      clientCache.delete(cacheKey);
    }
  }
}

/**
 * Start periodic cleanup of expired clients
 */
let cleanupTimer: Timer | null = null;

export function startClientCacheCleanup(): void {
  if (cleanupTimer) return; // Already started

  cleanupTimer = setInterval(() => {
    cleanupExpiredClients();
  }, CLEANUP_INTERVAL);

  console.error('[Client Cache] Started periodic cleanup');
}

/**
 * Stop periodic cleanup (for graceful shutdown)
 */
export function stopClientCacheCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.error('[Client Cache] Stopped periodic cleanup');
  }
}

/**
 * Cleanup all cached clients (for graceful shutdown)
 */
export function cleanupAllClients(): void {
  console.error('[Client Cache] Cleaning up all cached clients');

  for (const [email, sessionData] of clientCache.entries()) {
    try {
      sessionData.sunsamaClient.logout();
    } catch (err) {
      console.error(`[Client Cache] Error logging out client for ${email}:`, err);
    }
  }

  clientCache.clear();
}

/**
 * Authenticate HTTP request using token (for MCP_AUTH_TOKEN mode)
 * Uses the server's MCP_AUTH_TOKEN to authenticate and uses a shared client
 */
async function authenticateWithToken(providedToken: string, authMethod: AuthMethod): Promise<SessionData> {
  const expectedToken = getMcpAuthToken();

  if (!expectedToken) {
    throw new Error("MCP_AUTH_TOKEN not configured on server");
  }

  if (!validateToken(providedToken, expectedToken)) {
    throw new Error("Invalid authentication token");
  }

  // For token auth, we use a shared cached client
  const cacheKey = getTokenCacheKey(providedToken);
  const now = Date.now();

  // Check for pending authentication (race condition protection)
  if (authPromises.has(cacheKey)) {
    console.error(`[Client Cache] Waiting for pending token authentication`);
    return await authPromises.get(cacheKey)!;
  }

  // Check cache first
  if (clientCache.has(cacheKey)) {
    const cached = clientCache.get(cacheKey)!;

    // Check if still valid (lazy expiration)
    if (isClientValid(cached)) {
      console.error(`[Client Cache] Reusing cached client for token auth (method: ${authMethod})`);
      // Update last accessed time (sliding window)
      cached.lastAccessedAt = now;
      cached.authMethod = authMethod;
      return cached;
    } else {
      console.error(`[Client Cache] Cached token client expired, re-authenticating`);
      // Cleanup expired client
      try {
        cached.sunsamaClient.logout();
      } catch (err) {
        console.error(`[Client Cache] Error logging out expired token client:`, err);
      }
      clientCache.delete(cacheKey);
    }
  }

  // For token auth, we still need Sunsama credentials from environment
  const email = process.env.SUNSAMA_EMAIL;
  const password = process.env.SUNSAMA_PASSWORD;

  if (!email || !password) {
    throw new Error("SUNSAMA_EMAIL and SUNSAMA_PASSWORD must be set when using token authentication");
  }

  // Create authentication promise to prevent concurrent authentications
  console.error(`[Client Cache] Creating new client for token auth (method: ${authMethod})`);
  const authPromise = (async () => {
    try {
      const sunsamaClient = new SunsamaClient();
      await sunsamaClient.login(email, password);

      const sessionData: SessionData = {
        sunsamaClient,
        email,
        createdAt: now,
        lastAccessedAt: now,
        authMethod
      };

      clientCache.set(cacheKey, sessionData);
      console.error(`[Client Cache] Cached new client for token auth (total: ${clientCache.size})`);

      return sessionData;
    } finally {
      // Always remove from pending map
      authPromises.delete(cacheKey);
    }
  })();

  // Store promise to prevent concurrent authentications
  authPromises.set(cacheKey, authPromise);

  return authPromise;
}

/**
 * Authenticate HTTP request and get or create cached client
 * Uses secure cache key (password hash) and race condition protection
 */
export async function authenticateHttpRequest(
  authHeader?: string,
  queryToken?: string
): Promise<SessionData> {
  const mcpAuthToken = getMcpAuthToken();

  // If MCP_AUTH_TOKEN is configured, check token-based auth methods first
  if (mcpAuthToken) {
    // Priority 1: Query parameter token
    if (queryToken) {
      console.error('[Auth] Attempting authentication via query parameter token');
      return authenticateWithToken(queryToken, "query");
    }

    // Priority 2: Bearer token
    if (authHeader?.startsWith('Bearer ')) {
      console.error('[Auth] Attempting authentication via Bearer token');
      const token = parseBearerToken(authHeader);
      return authenticateWithToken(token, "bearer");
    }

    // Priority 3: Basic Auth (fallback)
    if (authHeader?.startsWith('Basic ')) {
      console.error('[Auth] Attempting authentication via Basic Auth (fallback)');
      // Fall through to Basic Auth below
    } else if (!authHeader) {
      throw new Error("Authentication required: provide token in query parameter (?token=xxx), Bearer header, or Basic Auth");
    }
  }

  // Basic Auth (required if no MCP_AUTH_TOKEN configured)
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    throw new Error("Basic Auth required");
  }

  const { email, password } = parseBasicAuth(authHeader);
  const cacheKey = getCacheKey(email, password);
  const now = Date.now();

  // Check for pending authentication (race condition protection)
  if (authPromises.has(cacheKey)) {
    console.error(`[Client Cache] Waiting for pending authentication for ${email}`);
    return await authPromises.get(cacheKey)!;
  }

  // Check cache first
  if (clientCache.has(cacheKey)) {
    const cached = clientCache.get(cacheKey)!;

    // Check if still valid (lazy expiration)
    if (isClientValid(cached)) {
      console.error(`[Client Cache] Reusing cached client for ${email}`);
      // Update last accessed time (sliding window)
      cached.lastAccessedAt = now;
      cached.authMethod = "basic";
      return cached;
    } else {
      console.error(`[Client Cache] Cached client expired for ${email}, re-authenticating`);
      // Cleanup expired client
      try {
        cached.sunsamaClient.logout();
      } catch (err) {
        console.error(`[Client Cache] Error logging out expired client:`, err);
      }
      clientCache.delete(cacheKey);
    }
  }

  // Create authentication promise to prevent concurrent authentications
  console.error(`[Client Cache] Creating new client for ${email}`);
  const authPromise = (async () => {
    try {
      const sunsamaClient = new SunsamaClient();
      await sunsamaClient.login(email, password);

      const sessionData: SessionData = {
        sunsamaClient,
        email,
        createdAt: now,
        lastAccessedAt: now,
        authMethod: "basic"
      };

      clientCache.set(cacheKey, sessionData);
      console.error(`[Client Cache] Cached new client for ${email} (total: ${clientCache.size})`);

      return sessionData;
    } finally {
      // Always remove from pending map
      authPromises.delete(cacheKey);
    }
  })();

  // Store promise to prevent concurrent authentications
  authPromises.set(cacheKey, authPromise);

  return authPromise;
}
