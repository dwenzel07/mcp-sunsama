#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import cors from "cors";
import express, { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";

import {
  authenticateHttpRequest,
  cleanupAllClients,
  startClientCacheCleanup,
  stopClientCacheCleanup,
} from "../auth/http.js";
import type { SessionData } from "../auth/types.js";
import { getSessionConfig } from "../config/session-config.js";
import type { TransportConfig } from "../config/transport.js";
import { PACKAGE_NAME, VERSION } from "../constants.js";
import { SessionManager } from "../session/session-manager.js";

// -------------------------------
// Session management
// -------------------------------
export const sessionManager = new SessionManager();

const sessionConfig = getSessionConfig();
const CLEANUP_INTERVAL = sessionConfig.CLEANUP_INTERVAL;

let cleanupTimer: NodeJS.Timer | null = null;

function startSessionCacheCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    sessionManager.cleanupExpired();
  }, CLEANUP_INTERVAL);
  console.error("[Session Cache] Started periodic cleanup");
}

function stopSessionCacheCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.error("[Session Cache] Stopped periodic cleanup");
  }
}

// -------------------------------
// API-key middleware
// -------------------------------
function createApiKeyMiddleware() {
  const expectedApiKey = process.env.MCP_API_KEY;

  return (req: Request, res: Response, next: NextFunction) => {
    // Allow health check if no key configured
    if (req.path === "/" && !expectedApiKey) return next();

    // Enforce X-MCP-API-Key when configured
    if (expectedApiKey) {
      const provided = (req.headers["x-mcp-api-key"] as string | undefined)?.trim();
      if (!provided) {
        console.error("[API Key Auth] Missing X-MCP-API-Key header");
        return res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "API key required (X-MCP-API-Key)" },
          id: null,
        });
      }
      if (provided !== expectedApiKey) {
        console.error("[API Key Auth] Invalid API key");
        return res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Invalid API key" },
          id: null,
        });
      }
      // console.error("[API Key Auth] ✅ Valid API key"); // noisy in prod
    }
    next();
  };
}

// -------------------------------
/** Start the HTTP transport (Streamable HTTP) */
// -------------------------------
export async function setupHttpTransport(
  server: McpServer,
  config: Extract<TransportConfig, { transportType: "http" }>
) {
  const app = express();

  // CORS for MCP usage
  app.use(
    cors({
      origin: "*",
      exposedHeaders: ["Mcp-Session-Id"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-MCP-API-Key",
        "Mcp-Session-Id",
        "Last-Event-ID",
      ],
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
    }),
  );

  app.use(express.json({ limit: "4mb" }));

  // Global API key auth (fallback Basic handled in initialize branch)
  app.use(createApiKeyMiddleware());

  // Health check
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: PACKAGE_NAME,
      version: VERSION,
      transport: "http",
      protected: !!process.env.MCP_API_KEY,
      activeSessions: sessionManager.getSessionCount(),
    });
  });

  // -------------------------------
  // MCP Endpoint - POST (JSON-RPC)
  // -------------------------------
  app.post(config.httpStream.endpoint, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;
      let sessionData: SessionData;

      // Reuse existing session if present
      if (sessionId && sessionManager.hasSession(sessionId)) {
        console.error(`[Transport] Reusing session ${sessionId}`);
        transport = sessionManager.getTransport(sessionId)!;
        sessionData = sessionManager.getSessionData(sessionId)!;
      }
      // Provided ID but not found
      else if (sessionId && !sessionManager.hasSession(sessionId)) {
        console.error(`[Transport] Session ${sessionId} expired/invalid`);
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session expired or invalid" },
          id: null,
        });
        return;
      }
      // New initialize
      else if (!sessionId && isInitializeRequest(req.body)) {
        console.error("[Transport] New initialization request");

        // Prefer API key; fall back to Basic auth
        const apiKeyHeader = (req.headers["x-mcp-api-key"] as string | undefined)?.trim();
        const expectedKey = process.env.MCP_API_KEY;

        if (expectedKey && apiKeyHeader === expectedKey) {
          sessionData = { method: "api-key", subject: "api-key-client" } as SessionData;
          console.error("[Auth] API key accepted");
        } else {
          const authHeader = Array.isArray(req.headers["authorization"])
            ? req.headers["authorization"][0]
            : req.headers["authorization"];
          sessionData = await authenticateHttpRequest(authHeader); // throws on failure
          console.error("[Auth] Basic auth accepted");
        }

        // Create transport; allow public host
        const allowedHosts = [
          "127.0.0.1",
          "localhost",
          `127.0.0.1:${config.httpStream.port}`,
          `localhost:${config.httpStream.port}`,
          // add your Render host (no scheme)
          "sunsama-mcp.onrender.com",
        ];

        transport = new StreamableHTTPServerTransport({
          enableDnsRebindingProtection: true,
          allowedHosts,
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            console.error(`[Transport] Session initialized: ${newSessionId}`);
            sessionManager.createSession(newSessionId, transport, sessionData);
          },
        });

        // Cleanup when closed
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            console.error(`[Transport] Transport closed for session ${sid}`);
            sessionManager.removeSession(sid);
          }
        };

        // Connect this transport to MCP server
        await server.connect(transport);
        console.error("[Transport] Connected new transport to MCP server");
      }
      // Bad request (no session + not initialize)
      else {
        console.error("[Transport] Invalid request: missing session or not initialize");
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      // Handle JSON-RPC call
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[HTTP transport] Error:", error);
      if (!res.headersSent) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Authentication failed" },
          id: null,
        });
      }
    }
  });

  // -------------------------------
  // MCP Endpoint - GET (SSE stream)
  // -------------------------------
  app.get(config.httpStream.endpoint, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !sessionManager.hasSession(sessionId)) {
        console.error(`[Transport] Invalid session ID in GET: ${sessionId}`);
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        console.error(`[Transport] Session ${sessionId} expired during GET`);
        res.status(404).send("Session expired");
        return;
      }

      const lastEventId = req.headers["last-event-id"] as string | undefined;
      if (lastEventId) {
        console.error(`[Transport] SSE reconnection, Last-Event-ID=${lastEventId}`);
      } else {
        console.error(`[Transport] New SSE stream for session ${sessionId}`);
      }

      await session.transport.handleRequest(req, res);
    } catch (err) {
      console.error("[HTTP transport] Error in GET handler:", err);
      if (!res.headersSent) res.status(500).send("Internal server error");
    }
  });

  // -------------------------------
  // MCP Endpoint - DELETE (terminate session)
  // -------------------------------
  app.delete(config.httpStream.endpoint, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !sessionManager.hasSession(sessionId)) {
        console.error(`[Transport] Invalid session ID in DELETE: ${sessionId}`);
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      console.error(`[Transport] Session termination for ${sessionId}`);
      const session = sessionManager.getSession(sessionId);
      if (session) {
        await session.transport.handleRequest(req, res);
        // onclose handler will finish cleanup
      }
    } catch (err) {
      console.error("[HTTP transport] Error in DELETE handler:", err);
      if (!res.headersSent) res.status(500).send("Error processing session termination");
    }
  });

  // -------------------------------
  // Boot, timers, shutdown
  // -------------------------------
  const { port } = config.httpStream;

  startClientCacheCleanup();
  startSessionCacheCleanup();

  const shutdown = async () => {
    console.error("\n[HTTP transport] Shutting down gracefully...");
    stopClientCacheCleanup();
    stopSessionCacheCleanup();
    sessionManager.cleanupAll();
    cleanupAllClients();
    console.error("[HTTP transport] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise<void>((resolve, reject) => {
    app
      .listen(port, () => {
        console.error(`HTTP transport listening on port ${port}`);
        console.error(`MCP endpoint: http://localhost:${port}${config.httpStream.endpoint}`);
        resolve();
      })
      .on("error", reject);
  });
}
