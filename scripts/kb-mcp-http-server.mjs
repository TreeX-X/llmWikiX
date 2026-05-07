#!/usr/bin/env node
import http from "http";
import { spawn } from "child_process";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number.parseInt(process.env.MCP_HTTP_PORT || "8787", 10);
const HOST = process.env.MCP_HTTP_HOST || "127.0.0.1";
const SERVER_ENTRY = path.join(ROOT, "scripts", "kb-mcp-server.mjs");

class PersistentMcpClient {
  constructor() {
    this.child = null;
    this.requestId = 0;
    this.pending = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.expectedLength = null;
    this.starting = null;
  }

  async ensureStarted() {
    if (this.child && !this.child.killed) return;
    if (this.starting) {
      return this.starting;
    }
    this.starting = this._start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  _start() {
    return new Promise((resolve, reject) => {
      this.child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.stdoutBuffer = Buffer.alloc(0);
      this.expectedLength = null;

      this.child.on("error", (error) => {
        process.stderr.write(`[kb-mcp-http] child error: ${error.message}\n`);
        this.rejectAll(new Error(`MCP child error: ${error.message}`));
        this.child = null;
        reject(error);
      });

      this.child.on("exit", (code) => {
        process.stderr.write(`[kb-mcp-http] child exited with code ${code}\n`);
        this.rejectAll(new Error(`MCP child exited (code ${code})`));
        this.child = null;
      });

      this.child.stderr.on("data", (chunk) => {
        process.stderr.write(`[kb-mcp-stderr] ${chunk.toString("utf8")}`);
      });

      this.child.stdout.on("data", (chunk) => {
        this._handleData(chunk);
      });

      // MCP initialize handshake
      const initId = String(++this.requestId);
      const initMessage = {
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "llmwiki-mcp-http", version: "1.0.0" },
        },
      };

      this.pending.set(initId, {
        resolve: () => {
          this._sendRaw({ jsonrpc: "2.0", method: "initialized" });
          resolve();
        },
        reject,
        timer: setTimeout(() => {
          this.pending.delete(initId);
          reject(new Error("MCP initialize timed out"));
        }, 15000),
      });

      this._writeMessage(initMessage);
    });
  }

  _handleData(chunk) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

    while (true) {
      if (this.expectedLength == null) {
        const crlf = this.stdoutBuffer.indexOf(Buffer.from("\r\n\r\n"));
        const lf = this.stdoutBuffer.indexOf(Buffer.from("\n\n"));
        let headerEnd = -1;
        let headerSize = 0;

        if (crlf >= 0 && (lf < 0 || crlf < lf)) {
          headerEnd = crlf;
          headerSize = 4;
        } else if (lf >= 0) {
          headerEnd = lf;
          headerSize = 2;
        } else {
          break;
        }

        const headerBlock = this.stdoutBuffer.toString("utf8", 0, headerEnd);
        const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.stdoutBuffer = this.stdoutBuffer.slice(headerEnd + headerSize);
          continue;
        }
        this.expectedLength = Number.parseInt(match[1], 10);
        this.stdoutBuffer = this.stdoutBuffer.slice(headerEnd + headerSize);
      }

      if (this.stdoutBuffer.length < this.expectedLength) break;
      const body = this.stdoutBuffer.subarray(0, this.expectedLength).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.slice(this.expectedLength);
      this.expectedLength = null;

      try {
        const message = JSON.parse(body);
        this._handleMessage(message);
      } catch (error) {
        process.stderr.write(`[kb-mcp-http] invalid JSON from child: ${error.message}\n`);
      }
    }
  }

  _handleMessage(message) {
    if (message.id != null) {
      const id = String(message.id);
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(message.error.message || "MCP error"));
        } else {
          pending.resolve(message);
        }
      }
    }
  }

  _writeMessage(message) {
    if (!this.child || this.child.killed) return;
    const json = JSON.stringify(message);
    const framed = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
    this.child.stdin.write(framed);
  }

  _sendRaw(message) {
    if (!this.child || this.child.killed) return;
    this._writeMessage(message);
  }

  rejectAll(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(message) {
    await this.ensureStarted();

    const isNotification = !Object.prototype.hasOwnProperty.call(message ?? {}, "id");
    if (isNotification) {
      this._sendRaw(message);
      return null;
    }

    const id = String(message.id);
    const messageWithId = { ...message, id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP request timed out"));
      }, 15000);

      this.pending.set(id, { resolve, reject, timer });
      this._writeMessage(messageWithId);
    });
  }

  async shutdown() {
    if (!this.child || this.child.killed) return;
    try {
      await this.request({ jsonrpc: "2.0", method: "shutdown" });
    } catch {
      // ignore shutdown errors
    }
    this.child.kill();
    this.child = null;
  }
}

const mcpClient = new PersistentMcpClient();

function writeJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(payload == null ? "" : JSON.stringify(payload));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body.length ? JSON.parse(body) : null);
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

async function handleRpc(payload) {
  if (Array.isArray(payload)) {
    const results = [];
    for (const message of payload) {
      const result = await mcpClient.request(message);
      if (result != null) results.push(result);
    }
    return results;
  }
  return mcpClient.request(payload);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("X-MCP-Transport", "http-jsonrpc");

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  if (req.method === "GET" && req.url === "/mcp") {
    writeJson(res, 200, {
      name: "llmwiki-kb-mcp-http",
      version: "1.0.0",
      endpoint: "/mcp",
      transport: "http-jsonrpc",
      methods: ["POST"],
      health: "/health",
    });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/mcp") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }

  try {
    const payload = await parseJsonBody(req);
    if (payload == null) {
      writeJson(res, 400, {
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: "Request body is required",
        },
        id: null,
      });
      return;
    }

    const response = await handleRpc(payload);
    if (
      response == null ||
      (Array.isArray(response) && response.length === 0)
    ) {
      res.writeHead(204);
      res.end();
      return;
    }

    writeJson(res, 200, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    process.stderr.write(`[kb-mcp-http] request error: ${message}\n`);

    if (message === "Request body too large") {
      writeJson(res, 413, {
        jsonrpc: "2.0",
        error: { code: -32600, message },
        id: null,
      });
      return;
    }

    writeJson(res, 500, {
      jsonrpc: "2.0",
      error: { code: -32603, message },
      id: null,
    });
  }
});

function cleanup() {
  mcpClient.shutdown().catch(() => { });
  server.close();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

server.listen(PORT, HOST, () => {
  process.stdout.write(`[kb-mcp-http] listening on http://${HOST}:${PORT}/mcp\n`);
});
