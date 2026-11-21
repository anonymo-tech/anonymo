// WS11 · Ventures deploy (Ventures Backend spec, PART 7 "static: ... + Arweave copy"): the permanent copy of a site.
//
// Each file goes to the bundler as its own upload, then one Arweave path manifest (`arweave/paths` v0.2.0) maps the
// site paths to those transaction ids; the manifest's id is what an ArNS name points at. Signing the ANS-104 data
// items with the venture wallet is left to the bundler adapter behind the configured endpoint: this client sends raw
// bytes with a content type and never holds wallet keys.

import { authHeader, errorText, httpError, joinUrl, type Endpoint, type Fetch } from "./http.ts";
import { checkSitePath, toBytes, type SiteFiles } from "./ipfs.ts";

export type ArweavePathManifest = {
  manifest: "arweave/paths";
  version: "0.2.0";
  index: { path: string };
  paths: Record<string, { id: string }>;
};

export const MANIFEST_CONTENT_TYPE = "application/x.arweave-manifest+json";

export type ArweaveUpload = { id: string; manifest: ArweavePathManifest } | { skipped: string };

export interface ArweaveUploader {
  readonly name: string;
  /** Upload every file, then the path manifest; returns the manifest's transaction id. */
  upload(input: { files: SiteFiles; index?: string }): Promise<ArweaveUpload>;
}

/** An Arweave transaction / data item id: 32 bytes, base64url, 43 characters. */
export const isArweaveId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{43}$/.test(id);

export function buildPathManifest(index: string, ids: Record<string, string>): ArweavePathManifest {
  if (!(index in ids)) throw new Error(`manifest index ${JSON.stringify(index)} is not one of the uploaded paths`);
  const paths: Record<string, { id: string }> = {};
  for (const p of Object.keys(ids).sort()) paths[checkSitePath(p)] = { id: ids[p] };
  return { manifest: "arweave/paths", version: "0.2.0", index: { path: index }, paths };
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  xml: "application/xml",
  webmanifest: "application/manifest+json",
};

export function contentTypeFor(path: string): string {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

/**
 * POST `${url}/tx` once per file (raw bytes, Content-Type = the file's type) and once for the manifest, each answered
 * with `{ "id": "<43-char data item id>" }`. The token goes in the Authorization header only.
 */
export class HttpBundlerUploader implements ArweaveUploader {
  readonly name: string;
  constructor(
    private readonly endpoint: Endpoint,
    private readonly opts: { fetch?: Fetch } = {},
  ) {
    this.name = endpoint.name;
    joinUrl(endpoint.url, "/tx"); // validate up front
  }

  private async post(body: Uint8Array, contentType: string): Promise<string> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(joinUrl(this.endpoint.url, "/tx"), { method: "POST", headers: { "content-type": contentType, ...authHeader(this.endpoint.token) }, body });
    if (!res.ok) throw new Error(await httpError(this.name, res, this.endpoint.token));
    const { id } = (await res.json()) as { id?: unknown };
    if (!isArweaveId(id)) throw new Error(`${this.name}: bundler returned no valid data item id`);
    return id;
  }

  async upload(input: { files: SiteFiles; index?: string }): Promise<ArweaveUpload> {
    const index = input.index ?? "index.html";
    try {
      const ids: Record<string, string> = {};
      for (const p of Object.keys(input.files).map(checkSitePath).sort()) ids[p] = await this.post(toBytes(input.files[p]), contentTypeFor(p));
      const manifest = buildPathManifest(index, ids);
      const id = await this.post(new TextEncoder().encode(JSON.stringify(manifest)), MANIFEST_CONTENT_TYPE);
      return { id, manifest };
    } catch (err) {
      throw new Error(errorText("arweave", err, this.endpoint.token));
    }
  }
}

/** Used when no bundler is configured: the deploy records that the Arweave copy was skipped, and why. */
export class NullUploader implements ArweaveUploader {
  readonly name = "none";
  constructor(private readonly reason = "not configured") {}
  async upload(): Promise<ArweaveUpload> {
    return { skipped: `skipped: ${this.reason}` };
  }
}
