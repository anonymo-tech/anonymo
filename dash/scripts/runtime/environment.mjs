import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

const fail = () => {
  throw new Error("RUNTIME_CONFIGURATION_INVALID");
};

function endpoint(value) {
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.username ||
      !url.password ||
      !url.hostname ||
      !/^\/[^/]+$/.test(url.pathname) ||
      url.hash ||
      [...url.searchParams].some(([key, value]) => key !== "sslmode" || value !== "verify-full")
    )
      fail();
    return url;
  } catch {
    fail();
  }
}

export function validateCertificate(bundle) {
  if (typeof bundle !== "string" || Buffer.byteLength(bundle) > 65536) fail();
  const blocks = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (
    !blocks?.length ||
    bundle.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()
  )
    fail();
  try {
    for (const block of blocks) new X509Certificate(block);
  } catch {
    fail();
  }
  return blocks.join("\n") + "\n";
}

export function runtimeMode(env) {
  if (env.CONCLAVE_INFERENCE_ENABLED && !["true", "false"].includes(env.CONCLAVE_INFERENCE_ENABLED))
    fail();
  return env.CONCLAVE_INFERENCE_ENABLED === "true";
}

/** Never logs configuration values. CA material exists only in the running container. */
export async function prepareEnvironment(input, temporaryRoot = tmpdir()) {
  const env = { ...input, TZ: "UTC" };
  const enabled = runtimeMode(env);
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail();
  if (enabled) {
    if (env.CONCLAVE_MODE !== "service") fail();
    const api = endpoint(env.CONCLAVE_DATABASE_URL);
    const worker = endpoint(env.CONCLAVE_WORKER_DATABASE_URL);
    if (
      api.hostname !== worker.hostname ||
      api.port !== worker.port ||
      api.pathname !== worker.pathname ||
      decodeURIComponent(api.username) === decodeURIComponent(worker.username)
    )
      fail();
    const roles = new Set([decodeURIComponent(api.username), decodeURIComponent(worker.username)]);
    for (const name of ["CONCLAVE_RECEIPTS_DATABASE_URL", "CONCLAVE_IMPORTER_DATABASE_URL"]) {
      if (!env[name]) continue;
      const auxiliary = endpoint(env[name]),
        role = decodeURIComponent(auxiliary.username);
      if (
        auxiliary.hostname !== api.hostname ||
        auxiliary.port !== api.port ||
        auxiliary.pathname !== api.pathname ||
        roles.has(role)
      )
        fail();
      roles.add(role);
    }
    if (!env.CONCLAVE_DATABASE_CA_PEM && !env.CONCLAVE_DATABASE_CA_FILE) fail();
  }
  let directory;
  try {
    if (env.CONCLAVE_DATABASE_CA_PEM) {
      if (env.CONCLAVE_DATABASE_CA_FILE) fail();
      const pem = validateCertificate(env.CONCLAVE_DATABASE_CA_PEM);
      directory = await mkdtemp(join(temporaryRoot, "conclave-runtime-"));
      env.CONCLAVE_DATABASE_CA_FILE = join(directory, "database-ca.pem");
      await writeFile(env.CONCLAVE_DATABASE_CA_FILE, pem, {
        mode: 0o600,
        flag: "wx",
      });
    } else if (env.CONCLAVE_DATABASE_CA_FILE) {
      if (!isAbsolute(env.CONCLAVE_DATABASE_CA_FILE)) fail();
      validateCertificate(await readFile(env.CONCLAVE_DATABASE_CA_FILE, "utf8"));
    }
    delete env.CONCLAVE_DATABASE_CA_PEM;
    const auxiliary = Object.fromEntries(
      ["CONCLAVE_RECEIPTS_DATABASE_URL", "CONCLAVE_IMPORTER_DATABASE_URL"].map((name) => [
        name,
        env[name],
      ]),
    );
    const worker = {
      ...env,
      CONCLAVE_DATABASE_URL: env.CONCLAVE_WORKER_DATABASE_URL,
    };
    const web = { ...env };
    for (const child of [web, worker]) {
      delete child.CONCLAVE_WORKER_DATABASE_URL;
      for (const name of Object.keys(child)) {
        if (
          /MIGRAT(?:ION|OR)|ADMIN_DATABASE|DATABASE_ADMIN|SUPABASE_SERVICE_ROLE|SUPABASE_PASSWORD/i.test(
            name,
          ) ||
          (name !== "CONCLAVE_DATABASE_URL" && /DATABASE.*URL|DB_?URL/i.test(name))
        )
          delete child[name];
      }
    }
    Object.assign(
      worker,
      Object.fromEntries(Object.entries(auxiliary).filter(([, value]) => value)),
    );
    delete worker.CONCLAVE_GITHUB_PUBLIC_READ_TOKEN;
    delete web.CONCLAVE_RECEIPT_MASTER_SEED_HEX;
    return {
      enabled,
      web,
      worker,
      cleanup: async () => {
        if (directory) await rm(directory, { recursive: true, force: true });
      },
    };
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true });
    fail();
  }
}
