import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export const PERSONA_CATALOGUE_LIMIT = 1024 * 1024;
const ENTRY_LIMIT = 512;
const NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Discovery data only. A catalogue entry does not prove a loaded native plugin. */
export interface CataloguePlugin {
  id: string;
  name: string;
  description?: string;
  revision?: string;
  source?: string;
}
export interface PersonaCatalogue {
  format: "asf-persona-catalogue/v1";
  models: string[];
  tools: string[];
  plugins: CataloguePlugin[];
  marketplace?: { name: string; revision: string; source?: string };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function fields(input: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(input))
    if (!allowed.includes(key))
      throw new Error(`Unknown catalogue field: ${key}`);
}
function text(value: unknown, label: string, limit = 256): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value) > limit
  )
    throw new Error(`${label} must be nonempty text within ${limit} bytes`);
  return value;
}
function name(value: unknown): string {
  const result = text(value, "Catalogue name", 128);
  if (!NAME.test(result))
    throw new Error("Catalogue names require lowercase 1-128 character slugs");
  return result;
}
function description(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > 8192 ||
    value.includes("\0")
  )
    throw new Error("Plugin description must be text within 8192 bytes");
  return value;
}
function sourceUrl(value: unknown): string {
  const source = text(value, "Catalogue source", 2048);
  const url = new URL(source);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    Buffer.byteLength(url.href) > 2048
  )
    throw new Error(
      "Catalogue source requires an HTTPS URL without credentials, query or fragment, within 2048 canonical URL bytes",
    );
  return url.href;
}
function revision(value: unknown, gitOnly = false): string {
  if (
    typeof value !== "string" ||
    value.match(gitOnly ? GIT_SHA : REVISION)?.[0] !== value
  )
    throw new Error(
      `Catalogue revision requires ${gitOnly ? "40" : "40 or 64"} lowercase hex characters`,
    );
  return value;
}
function list(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > ENTRY_LIMIT)
    throw new Error(
      `${label} must be an array of at most ${ENTRY_LIMIT} entries`,
    );
  const result = value.map((entry) => text(entry, label));
  if (new Set(result).size !== result.length)
    throw new Error(`Duplicate ${label} entry`);
  return result;
}
function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > PERSONA_CATALOGUE_LIMIT)
    throw new Error("Persona catalogue exceeds 1 MiB");
}

/** Validate a local catalogue without resolving sources or reading plugin files. */
export function parsePersonaCatalogue(value: unknown): PersonaCatalogue {
  bounded(value);
  const input = record(value, "Persona catalogue");
  fields(input, ["format", "models", "tools", "plugins", "marketplace"]);
  if (input.format !== "asf-persona-catalogue/v1")
    throw new Error("Unsupported persona catalogue format");
  if (!Array.isArray(input.plugins) || input.plugins.length > ENTRY_LIMIT)
    throw new Error(
      "Catalogue plugins must be an array of at most 512 entries",
    );
  const plugins = input.plugins.map((entry): CataloguePlugin => {
    const plugin = record(entry, "Catalogue plugin");
    fields(plugin, ["id", "name", "description", "revision", "source"]);
    const id = text(plugin.id, "Plugin id", 257);
    const parts = id.split("/");
    if (parts.length !== 2 || parts.some((part) => !NAME.test(part)))
      throw new Error("Plugin id must be marketplace/plugin");
    return {
      id,
      name: text(plugin.name, "Plugin name"),
      ...(plugin.description === undefined
        ? {}
        : {
            description: description(plugin.description),
          }),
      ...(plugin.revision === undefined
        ? {}
        : { revision: revision(plugin.revision) }),
      ...(plugin.source === undefined
        ? {}
        : { source: sourceUrl(plugin.source) }),
    };
  });
  if (new Set(plugins.map((plugin) => plugin.id)).size !== plugins.length)
    throw new Error("Duplicate catalogue plugin id");
  const result: PersonaCatalogue = {
    format: "asf-persona-catalogue/v1",
    models: list(input.models, "Catalogue models"),
    tools: list(input.tools, "Catalogue tools"),
    plugins,
  };
  if (input.marketplace !== undefined) {
    const marketplace = record(input.marketplace, "Marketplace provenance");
    fields(marketplace, ["name", "revision", "source"]);
    result.marketplace = {
      name: name(marketplace.name),
      revision: revision(marketplace.revision, true),
      ...(marketplace.source === undefined
        ? {}
        : { source: sourceUrl(marketplace.source) }),
    };
  }
  bounded(result);
  return result;
}

export function emptyPersonaCatalogue(): PersonaCatalogue {
  return {
    format: "asf-persona-catalogue/v1",
    models: [],
    tools: [],
    plugins: [],
  };
}

/** Read at most the metadata bound, even if a local file grows during the read. */
function readMetadata(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile())
      throw new Error("Catalogue input must be a regular JSON file");
    const buffer = Buffer.alloc(PERSONA_CATALOGUE_LIMIT + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > PERSONA_CATALOGUE_LIMIT)
      throw new Error("Persona catalogue exceeds 1 MiB");
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8")) as unknown;
  } finally {
    closeSync(fd);
  }
}
export function loadPersonaCatalogue(path: string): PersonaCatalogue {
  return parsePersonaCatalogue(readMetadata(path));
}

/** Project Claude marketplace metadata; never load components or execute sources. */
export function importClaudeMarketplace(
  value: unknown,
  provenance: { revision: string; source?: string },
): PersonaCatalogue {
  bounded(value);
  const input = record(value, "Marketplace");
  const marketplace = name(input.name);
  const indexRevision = revision(provenance.revision, true);
  const owner = record(input.owner, "Marketplace owner");
  text(owner.name, "Marketplace owner name");
  if (!Array.isArray(input.plugins) || input.plugins.length > ENTRY_LIMIT)
    throw new Error(
      "Marketplace plugins must be an array of at most 512 entries",
    );
  const plugins = input.plugins.map((entry): CataloguePlugin => {
    const plugin = record(entry, "Marketplace plugin");
    const pluginName = name(plugin.name);
    let pin: string | undefined;
    let source: string | undefined;
    if (typeof plugin.source === "string") {
      const path = plugin.source;
      const root =
        input.metadata &&
        record(input.metadata, "Marketplace metadata").pluginRoot;
      const relative =
        path === "." ||
        path.startsWith("./") ||
        (!path.includes("/") &&
          typeof root === "string" &&
          root.startsWith("./"));
      if (
        !relative ||
        path.includes("\\") ||
        path.split("/").includes("..") ||
        /[\u0000-\u001f]/.test(path)
      )
        throw new Error(
          "Marketplace plugin path must stay inside its repository",
        );
      if (
        root !== undefined &&
        (typeof root !== "string" ||
          !root.startsWith("./") ||
          root.includes("\\") ||
          root.split("/").includes(".."))
      )
        throw new Error("Invalid marketplace pluginRoot");
      pin = indexRevision;
    } else {
      const native = record(plugin.source, "Marketplace plugin source");
      const kind = text(native.source, "Marketplace source kind");
      if (["github", "url", "git-subdir"].includes(kind)) {
        if (kind === "github") {
          const repo = text(native.repo, "Plugin repository");
          if (
            !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
            repo.split("/").some((part) => part === "." || part === "..")
          )
            throw new Error("Invalid GitHub plugin repository");
          source = `https://github.com/${repo}`;
        } else {
          source = sourceUrl(native.url);
          if (kind === "git-subdir") {
            const path = text(native.path, "Git plugin subdirectory", 2048);
            if (
              path.startsWith("/") ||
              path.includes("\\") ||
              path.split("/").includes("..")
            )
              throw new Error(
                "Git plugin subdirectory must stay inside its repository",
              );
          }
        }
        if (native.sha !== undefined) pin = revision(native.sha, true);
      }
      // npm ranges, archive URLs and command output are browse-only in this importer.
    }
    return {
      id: `${marketplace}/${pluginName}`,
      name: text(plugin.displayName ?? pluginName, "Plugin name"),
      ...(plugin.description === undefined
        ? {}
        : {
            description: description(plugin.description),
          }),
      ...(pin === undefined ? {} : { revision: pin }),
      ...(source === undefined ? {} : { source }),
    };
  });
  return parsePersonaCatalogue({
    ...emptyPersonaCatalogue(),
    plugins,
    marketplace: {
      name: marketplace,
      revision: indexRevision,
      ...(provenance.source === undefined ? {} : { source: provenance.source }),
    },
  });
}

/** Fetch only an immutable public GitHub marketplace index. No redirects or plugin fetches. */
export async function loadClaudeMarketplace(
  options: { file?: string; source?: string; revision: string },
  fetchMetadata: typeof fetch = fetch,
): Promise<PersonaCatalogue> {
  const pin = revision(options.revision, true);
  if ((!options.file && !options.source) || (options.file && options.source))
    throw new Error("Provide exactly one marketplace --file or --source");
  if (options.file)
    return importClaudeMarketplace(readMetadata(options.file), {
      revision: pin,
    });
  const source = sourceUrl(options.source);
  const url = new URL(source);
  const match =
    /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/([a-f0-9]{40})\/\.claude-plugin\/marketplace\.json$/.exec(
      url.pathname,
    );
  if (
    url.hostname !== "raw.githubusercontent.com" ||
    !match ||
    match[3] !== pin
  )
    throw new Error(
      "Marketplace source requires raw.githubusercontent.com/owner/repo/40SHA/.claude-plugin/marketplace.json matching --revision",
    );
  const response = await fetchMetadata(source, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    credentials: "omit",
  });
  if (!response.ok || !response.body)
    throw new Error("Marketplace metadata fetch failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > PERSONA_CATALOGUE_LIMIT)
        throw new Error("Persona catalogue exceeds 1 MiB");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return importClaudeMarketplace(
    JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    { revision: pin, source },
  );
}
