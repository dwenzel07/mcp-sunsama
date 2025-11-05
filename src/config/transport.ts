import { z } from "zod";

export type TransportType = "stdio" | "http";

export type TransportConfig =
  | { transportType: "stdio" }
  | {
      transportType: "http";
      httpStream: {
        port: number;
        endpoint: `/${string}`;
      };
    };

const TransportEnvSchema = z.object({
  TRANSPORT_MODE: z.enum(["stdio", "http"]).default("stdio"),
  PORT: z.string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().min(1).max(65535))
    .default("8080"),
  HTTP_ENDPOINT: z.string()
    .refine(val => val.startsWith("/"), {
      message: "HTTP_ENDPOINT must start with '/'"
    })
    .transform(val => val as `/${string}`)
    .default("/mcp"),
  MCP_AUTH_TOKEN: z.string().optional()
});

export function getTransportConfig(): TransportConfig {
  const env = TransportEnvSchema.parse(process.env);

  if (env.TRANSPORT_MODE === "http") {
    return {
      transportType: "http",
      httpStream: {
        port: env.PORT,
        endpoint: env.HTTP_ENDPOINT
      }
    };
  }

  return { transportType: "stdio" };
}

/**
 * Get the optional MCP authentication token for HTTP transport
 */
export function getMcpAuthToken(): string | undefined {
  const env = TransportEnvSchema.parse(process.env);
  return env.MCP_AUTH_TOKEN;
}
