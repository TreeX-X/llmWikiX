#!/usr/bin/env node
import { promises as fs } from "fs";
import path from "path";
import matter from "gray-matter";

const ROOT = path.resolve(import.meta.dirname, "..");
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-06-18"]);
const KB_SOURCES = [
  { scope: "knowledge-base", dir: "content/knowledge-base" },
  { scope: "wiki", dir: "content/wiki" },
];
const INDEX_TTL_MS = 5 * 60 * 1000;

const MIME_BY_EXT = new Map([
  [".md", "text/markdown"],
  [".mdx", "text/markdown"],
  [".txt", "text/plain"],
  [".json", "application/json"],
]);

function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function stripMarkdown(markdown) {
  return String(markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[>*+-]\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(query) {
  const normalized = normalizeText(query);
  if (!normalized) return [];
  const parts = normalized.split(/[\s,，。！？、;；|/\\]+/).filter(Boolean);
  if (parts.length > 0) return parts;
  return [normalized];
}

function makeUri(scope, relPath) {
  return `kb://${scope}/${encodeURIComponent(toPosixPath(relPath))}`;
}

function parseSourceTitle(markdown, fallback) {
  const firstHeading = String(markdown ?? "").match(/^#\s+(.+)$/m)?.[1]?.trim();
  return firstHeading || fallback;
}

function parseSummary(markdown, fallback = "") {
  const plain = stripMarkdown(markdown);
  if (!plain) return fallback;
  return plain.length <= 180 ? plain : `${plain.slice(0, 180).trim()}...`;
}

async function walkMarkdownFiles(baseDir) {
  const root = path.join(ROOT, baseDir);
  const entries = [];

  async function walk(currentDir) {
    const dirents = await fs.readdir(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const absolute = path.join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(absolute);
        continue;
      }

      const ext = path.extname(dirent.name).toLowerCase();
      if (ext !== ".md" && ext !== ".mdx") continue;

      const relative = toPosixPath(path.relative(ROOT, absolute));
      const raw = await fs.readFile(absolute, "utf8");
      const parsed = matter(raw);
      const stats = await fs.stat(absolute);
      entries.push({
        absolutePath: absolute,
        relativePath: relative,
        body: parsed.content,
        data: parsed.data ?? {},
        mtime: stats.mtime.toISOString(),
        size: stats.size,
      });
    }
  }

  try {
    await walk(root);
  } catch (err) {
    process.stderr.write(`[kb-mcp] warning: failed to walk directory ${root}: ${err instanceof Error ? err.message : String(err)}\n`);
    return entries;
  }
  return entries;
}

async function buildIndex() {
  const items = [];

  for (const source of KB_SOURCES) {
    const files = await walkMarkdownFiles(source.dir);
    for (const file of files) {
      const relWithinSource = toPosixPath(path.relative(path.join(ROOT, source.dir), file.absolutePath));
      const titleFromData = typeof file.data.title === "string" ? file.data.title.trim() : "";
      const title = titleFromData || parseSourceTitle(file.body, path.basename(file.absolutePath, path.extname(file.absolutePath)));
      const descriptionFromData = typeof file.data.description === "string" ? file.data.description.trim() : "";
      const tags = Array.isArray(file.data.tags) ? file.data.tags.filter((tag) => typeof tag === "string") : [];
      const content = file.body.trim();
      const summary = descriptionFromData || parseSummary(content, title);
      const slug = path.basename(file.absolutePath, path.extname(file.absolutePath));
      const uri = makeUri(source.scope, relWithinSource);
      const mimeType = MIME_BY_EXT.get(path.extname(file.absolutePath).toLowerCase()) || "text/markdown";

      items.push({
        uri,
        name: slug,
        title,
        description: summary,
        mimeType,
        scope: source.scope,
        relativePath: relWithinSource,
        absolutePath: file.absolutePath,
        content,
        text: stripMarkdown(content),
        tags,
        mtime: file.mtime,
        size: file.size,
      });
    }
  }

  return items.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
}

function scoreEntry(entry, query) {
  const terms = tokenize(query);
  if (terms.length === 0) return 0;

  const title = normalizeText(entry.title);
  const description = normalizeText(entry.description);
  const content = normalizeText(entry.text);
  const joined = `${title} ${description} ${content}`;

  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (title.includes(term)) score += 8;
    if (description.includes(term)) score += 4;
    if (content.includes(term)) score += 2;
    if (joined.startsWith(term)) score += 1;
  }

  if (normalizeText(query) && joined.includes(normalizeText(query))) {
    score += Math.min(6, Math.max(1, normalizeText(query).length / 4));
  }

  return score;
}

function makeSnippet(entry, query) {
  const terms = tokenize(query);
  const text = entry.text || entry.description || entry.title;
  const normalized = normalizeText(text);
  const bestTerm = terms.find((term) => normalized.includes(term)) || terms[0] || "";
  if (!bestTerm) {
    return text.length <= 240 ? text : `${text.slice(0, 240).trim()}...`;
  }

  const index = normalized.indexOf(bestTerm);
  if (index < 0) {
    return text.length <= 240 ? text : `${text.slice(0, 240).trim()}...`;
  }

  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + bestTerm.length + 140);
  const snippet = text.slice(start, end).trim();
  return start > 0 ? `...${snippet}${end < text.length ? "..." : ""}` : `${snippet}${end < text.length ? "..." : ""}`;
}

async function loadIndex() {
  const items = await buildIndex();
  const byUri = new Map(items.map((item) => [item.uri, item]));
  return { items, byUri };
}

async function getIndexMtimes() {
  const mtimes = new Map();
  for (const source of KB_SOURCES) {
    const root = path.join(ROOT, source.dir);
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        try {
          const stats = await fs.stat(path.join(root, entry.name));
          mtimes.set(`${source.scope}/${entry.name}`, stats.mtimeMs);
        } catch {
          // ignore inaccessible files
        }
      }
    } catch {
      // directory may not exist
    }
  }
  return mtimes;
}

function mtimesChanged(oldMtimes, newMtimes) {
  if (!oldMtimes || oldMtimes.size !== newMtimes.size) return true;
  for (const [key, value] of newMtimes) {
    if (oldMtimes.get(key) !== value) return true;
  }
  return false;
}

function asTextResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function parseUri(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "kb:") return null;
    const scope = parsed.hostname;
    const decodedPath = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    return { scope, path: decodedPath };
  } catch {
    return null;
  }
}

async function main() {
  const stdin = process.stdin;
  const stdout = process.stdout;
  let indexCache = null;

  let buffer = Buffer.alloc(0);
  let expectedLength = null;

  function findHeaderEnd(data) {
    const crlf = data.indexOf(Buffer.from("\r\n\r\n"));
    if (crlf >= 0) return { end: crlf, size: 4 };
    const lf = data.indexOf(Buffer.from("\n\n"));
    if (lf >= 0) return { end: lf, size: 2 };
    return null;
  }

  function send(message) {
    const json = JSON.stringify(message);
    stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }

  async function getIndex(forceRefresh = false) {
    const now = Date.now();

    if (!forceRefresh && indexCache) {
      const age = now - indexCache.builtAt;
      if (age < INDEX_TTL_MS) {
        const currentMtimes = await getIndexMtimes();
        if (!mtimesChanged(indexCache.mtimes, currentMtimes)) {
          return indexCache;
        }
      }
    }

    const { items, byUri } = await loadIndex();
    const mtimes = await getIndexMtimes();
    indexCache = { items, byUri, builtAt: now, mtimes };
    return indexCache;
  }

  async function handleMessage(message) {
    if (!message || message.jsonrpc !== "2.0") return;

    if (message.method === "initialize") {
      const requestedVersion = String(message.params?.protocolVersion ?? "");
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : "2025-06-18";

      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
          },
          serverInfo: {
            name: "llmwiki-kb-mcp",
            version: "1.0.0",
          },
          instructions: "Use tools to search the LLM wiki knowledge base and resources to read entries.",
        },
      });
      return;
    }

    if (message.method === "initialized") return;

    if (message.method === "tools/list") {
      const index = await getIndex();
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "search_knowledge_base",
              description: "Search the wiki knowledge base by keyword.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Search query" },
                  limit: { type: "number", minimum: 1, maximum: 20, default: 5 },
                  scope: {
                    type: "string",
                    enum: ["all", "knowledge-base", "wiki"],
                    default: "all",
                  },
                },
                required: ["query"],
                additionalProperties: false,
              },
            },
            {
              name: "read_knowledge_base_entry",
              description: "Read a knowledge base or wiki entry by URI or relative path.",
              inputSchema: {
                type: "object",
                properties: {
                  uri: { type: "string", description: "kb:// URI or relative file path" },
                },
                required: ["uri"],
                additionalProperties: false,
              },
            },
            {
              name: "list_knowledge_base_entries",
              description: "List available knowledge base and wiki entries.",
              inputSchema: {
                type: "object",
                properties: {
                  scope: {
                    type: "string",
                    enum: ["all", "knowledge-base", "wiki"],
                    default: "all",
                  },
                  limit: { type: "number", minimum: 1, maximum: 200, default: 100 },
                },
                additionalProperties: false,
              },
            },
            {
              name: "refresh_index",
              description: "Force refresh the knowledge base and wiki index to pick up recent changes.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        },
      });
      return;
    }

    if (message.method === "tools/call") {
      const index = await getIndex();
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};

      if (name === "search_knowledge_base") {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        const limit = Math.max(1, Math.min(Number(args.limit ?? 5) || 5, 20));
        const scope = typeof args.scope === "string" ? args.scope : "all";
        const matches = index.items
          .filter((entry) => scope === "all" || entry.scope === scope)
          .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, "zh-Hans-CN"))
          .slice(0, limit)
          .map(({ entry, score }) => ({
            uri: entry.uri,
            title: entry.title,
            description: entry.description,
            scope: entry.scope,
            score,
            snippet: makeSnippet(entry, query),
          }));

        send({
          jsonrpc: "2.0",
          id: message.id,
          result: asTextResult({
            query,
            count: matches.length,
            results: matches,
          }),
        });
        return;
      }

      if (name === "read_knowledge_base_entry") {
        const raw = typeof args.uri === "string" ? args.uri.trim() : "";
        let entry = index.byUri.get(raw);
        if (!entry && raw && !raw.includes("://")) {
          const normalized = raw.replace(/^\/+/, "");
          entry = index.items.find((item) => item.relativePath === normalized || item.absolutePath.endsWith(normalized));
        }
        if (!entry && raw.startsWith("kb://")) {
          const parsed = parseUri(raw);
          if (parsed) {
            entry = index.items.find((item) => item.scope === parsed.scope && item.relativePath === parsed.path);
          }
        }

        if (!entry) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32602,
              message: `Entry not found: ${raw}`,
            },
          });
          return;
        }

        send({
          jsonrpc: "2.0",
          id: message.id,
          result: asTextResult({
            uri: entry.uri,
            title: entry.title,
            scope: entry.scope,
            description: entry.description,
            relativePath: entry.relativePath,
            mimeType: entry.mimeType,
            tags: entry.tags,
            mtime: entry.mtime,
            content: entry.content,
          }),
        });
        return;
      }

      if (name === "list_knowledge_base_entries") {
        const scope = typeof args.scope === "string" ? args.scope : "all";
        const limit = Math.max(1, Math.min(Number(args.limit ?? 100) || 100, 200));
        const entries = index.items
          .filter((entry) => scope === "all" || entry.scope === scope)
          .slice(0, limit)
          .map((entry) => ({
            uri: entry.uri,
            title: entry.title,
            description: entry.description,
            scope: entry.scope,
            relativePath: entry.relativePath,
            mtime: entry.mtime,
          }));

        send({
          jsonrpc: "2.0",
          id: message.id,
          result: asTextResult({
            count: entries.length,
            entries,
          }),
        });
        return;
      }

      if (name === "refresh_index") {
        const refreshed = await getIndex(true);
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: asTextResult({ status: "refreshed", entries: refreshed.items.length }),
        });
        return;
      }

      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Unknown tool: ${String(name)}`,
        },
      });
      return;
    }

    if (message.method === "resources/list") {
      const index = await getIndex();
      const limit = Math.max(1, Math.min(Number(message.params?.limit ?? 100) || 100, 200));
      const resources = index.items.slice(0, limit).map((entry) => ({
        uri: entry.uri,
        name: entry.title,
        title: entry.title,
        description: entry.description,
        mimeType: entry.mimeType,
        annotations: {
          audience: ["assistant"],
          priority: entry.scope === "wiki" ? 0.7 : 1,
          lastModified: entry.mtime,
        },
      }));

      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          resources,
        },
      });
      return;
    }

    if (message.method === "resources/read") {
      const index = await getIndex();
      const uri = typeof message.params?.uri === "string" ? message.params.uri : "";
      const entry = index.byUri.get(uri);
      if (!entry) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32602,
            message: `Resource not found: ${uri}`,
          },
        });
        return;
      }

      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          contents: [
            {
              uri: entry.uri,
              mimeType: entry.mimeType,
              text: entry.content,
            },
          ],
        },
      });
      return;
    }

    if (message.method === "shutdown") {
      send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }

    if (message.id != null) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Method not found: ${String(message.method)}`,
        },
      });
    }
  }

  stdin.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")]);

    while (true) {
      if (expectedLength == null) {
        const header = findHeaderEnd(buffer);
        if (!header) break;
        const headerBlock = buffer.toString("utf8", 0, header.end);
        const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(header.end + header.size);
          continue;
        }
        expectedLength = Number.parseInt(match[1], 10);
        buffer = buffer.slice(header.end + header.size);
      }

      if (buffer.length < expectedLength) break;
      const body = buffer.subarray(0, expectedLength).toString("utf8");
      buffer = buffer.slice(expectedLength);
      expectedLength = null;

      let message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        process.stderr.write(`[kb-mcp] invalid JSON: ${error instanceof Error ? error.message : String(error)}\n`);
        continue;
      }

      await handleMessage(message);
    }
  });

  stdin.resume();
}

main().catch((error) => {
  process.stderr.write(`[kb-mcp] fatal: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
