import { SunsamaClient } from "sunsama-api/client";

/**
 * Authentication method type
 */
export type AuthMethod = "basic" | "bearer" | "query";

/**
 * Session data interface for HTTP transport
 */
export interface SessionData extends Record<string, unknown> {
  sunsamaClient: SunsamaClient;
  email: string;
  createdAt: number;
  lastAccessedAt: number;
  authMethod?: AuthMethod;
}