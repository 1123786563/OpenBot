/**
 * The object-store seam craft snapshots write through — the OpenBot replacement for onyx's
 * FileStore abstraction (`backend/onyx/file_store/file_store.py`). Snapshots are small gzip
 * archives addressed by a key like `sandbox-snapshots/{botId}/{snapshotId}.tar.gz`; the object
 * store owns the bytes, and the `craft_snapshots` row owns the key + size.
 *
 * Two backends behind one interface, so a single-node dev box and a MinIO/S3 cluster are the
 * same call. onyx's FileStore wraps S3 + GCS + local + in-memory impls; OpenBot's first cut
 * ships the two the deployment actually asked for — local (default, nothing to stand up) and
 * S3/MinIO — behind exactly the four verbs a snapshot needs:
 *
 *   put(key, bytes)   get(key) → bytes | null   has(key)   delete(key)
 *
 * `get` returning null (rather than throwing) is the honest "absent" that lets `has` be an
 * optimization rather than a required round-trip, and lets a restore whose blob was evicted
 * degrade to "regenerate" instead of surfacing a phantom error.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { CraftStorageConfig } from "../config";

export type ObjectStoreMetadata = Record<string, string>;

export type ObjectStore = {
  /** Write bytes at key, creating any parents. */
  put(
    key: string,
    bytes: Uint8Array,
    metadata?: ObjectStoreMetadata,
  ): Promise<void>;
  /** Read bytes at key, or null when absent. */
  get(key: string): Promise<Uint8Array | null>;
  /** Whether the key exists — an optimization, never a required round-trip. */
  has(key: string): Promise<boolean>;
  /** Delete the object; idempotent on absence. */
  delete(key: string): Promise<void>;
};

/** The one (backend, config) → store factory craft's wiring calls. */
export function createObjectStore(config: CraftStorageConfig): ObjectStore {
  return config.backend === "s3"
    ? new S3ObjectStore(config)
    : new LocalObjectStore(config.localDirectory);
}

// ── local: a directory on disk ───────────────────────────────────────────────

/**
 * Keys become paths under one root. A key may hold only forward-slash-separated path segments;
 * `.` and empty segments are dropped, `..` and absolute keys are refused. Craft generates the
 * keys itself (`sandbox-snapshots/{botId}/{id}.tar.gz`), so the refusal is a tripwire, not a
 * load-bearing filter.
 */
function localPath(root: string, key: string): string {
  if (isAbsolute(key)) {
    throw new Error(`Snapshot key must be relative: ${key}`);
  }
  const segments = key.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(`Snapshot key escapes the storage root: ${key}`);
  }
  return join(root, ...segments);
}

class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = localPath(this.root, key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const buffer = await readFile(localPath(this.root, key));
      return new Uint8Array(buffer);
    } catch {
      return null;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await stat(localPath(this.root, key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(localPath(this.root, key), { force: true });
  }
}

// ── s3 / MinIO: @aws-sdk/client-s3, loaded lazily ────────────────────────────

/** s3's absent-object errors answer 404 (NotFound) or a NoSuchKey code — both mean "null". */
function isNotFound(error: unknown): boolean {
  const code = (error as { name?: unknown })?.name;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } })
    ?.$metadata?.httpStatusCode;
  return code === "NotFound" || code === "NoSuchKey" || status === 404;
}

type S3Client = {
  send(command: unknown): Promise<unknown>;
};

class S3ObjectStore implements ObjectStore {
  private readonly config: CraftStorageConfig;
  private client: S3Client | null = null;

  constructor(config: CraftStorageConfig) {
    this.config = config;
  }

  /**
   * The lazily-built client. Delayed so the local-backend deployment (the default) never loads
   * the S3 SDK, and so a missing endpoint fails at first use, not at boot.
   */
  private async getClient(): Promise<S3Client> {
    if (this.client) return this.client;
    const { S3Client } = await import("@aws-sdk/client-s3");
    this.client = new S3Client({
      region: this.config.s3Region || "us-east-1",
      endpoint: this.config.s3Endpoint || undefined,
      forcePathStyle: this.config.s3ForcePathStyle,
      credentials: this.config.s3AccessKeyId
        ? {
            accessKeyId: this.config.s3AccessKeyId,
            secretAccessKey: this.config.s3SecretAccessKey,
          }
        : undefined,
    }) as S3Client;
    return this.client;
  }

  async put(
    key: string,
    bytes: Uint8Array,
    metadata?: ObjectStoreMetadata,
  ): Promise<void> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.getClient()).send(
      new PutObjectCommand({
        Bucket: this.config.s3Bucket,
        Key: key,
        Body: Buffer.from(bytes),
        Metadata: metadata,
      }) as never,
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const response = await (await this.getClient())
      .send(
        new GetObjectCommand({
          Bucket: this.config.s3Bucket,
          Key: key,
        }) as never,
      )
      .catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
    if (response === null) return null;
    const body = (
      response as { Body?: { transformToByteArray(): Promise<Uint8Array> } }
    ).Body;
    if (!body) return null;
    return new Uint8Array(await body.transformToByteArray());
  }

  async has(key: string): Promise<boolean> {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const result = await (await this.getClient())
      .send(
        new HeadObjectCommand({
          Bucket: this.config.s3Bucket,
          Key: key,
        }) as never,
      )
      .catch((error: unknown) => {
        if (isNotFound(error)) return false;
        throw error;
      });
    return result !== false;
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.getClient())
      .send(
        new DeleteObjectCommand({
          Bucket: this.config.s3Bucket,
          Key: key,
        }) as never,
      )
      .catch((error: unknown) => {
        if (isNotFound(error)) return;
        throw error;
      });
  }
}
