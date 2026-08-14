import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export type ArtifactMetadata = {
  sizeBytes: number;
  sha256: string;
};

export type PublishedArtifact = ArtifactMetadata & {
  filename: string;
  downloadUrl: string;
};

export interface ArtifactPublisher {
  publish(artifactPath: string, taskId: string): Promise<PublishedArtifact>;
}

export interface CosClient {
  uploadFile(params: {
    Bucket: string;
    Region: string;
    Key: string;
    FilePath: string;
  }): Promise<unknown>;
  getObjectUrl(params: {
    Bucket: string;
    Region: string;
    Key: string;
    Sign: true;
    Expires: number;
    Protocol: "https:";
  }): string;
}

export async function readArtifactMetadata(artifactPath: string): Promise<ArtifactMetadata> {
  const fileStat = await stat(artifactPath);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(artifactPath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return { sizeBytes: fileStat.size, sha256: hash.digest("hex") };
}

type FilesystemOptions = {
  directory: string;
  downloadBaseUrl: string;
};

export class FilesystemArtifactPublisher implements ArtifactPublisher {
  readonly options: FilesystemOptions;

  constructor(options: FilesystemOptions) {
    this.options = options;
  }

  async publish(artifactPath: string, taskId: string): Promise<PublishedArtifact & { storedPath: string }> {
    const filename = basename(artifactPath);
    const taskDirectory = join(this.options.directory, taskId);
    const storedPath = join(taskDirectory, filename);
    await mkdir(taskDirectory, { recursive: true });
    await copyFile(artifactPath, storedPath);
    const metadata = await readArtifactMetadata(storedPath);
    const baseUrl = this.options.downloadBaseUrl.replace(/\/$/, "");
    const downloadUrl = `${baseUrl}/${encodeURIComponent(taskId)}/${encodeURIComponent(filename)}`;
    return { filename, downloadUrl, storedPath, ...metadata };
  }
}

type CosOptions = {
  bucket: string;
  region: string;
  keyPrefix: string;
  urlExpiresSeconds: number;
};

export class CosArtifactPublisher implements ArtifactPublisher {
  readonly client: CosClient;
  readonly options: CosOptions;

  constructor(
    client: CosClient,
    options: CosOptions,
  ) {
    this.client = client;
    this.options = options;
  }

  async publish(
    artifactPath: string,
    taskId: string,
    knownMetadata?: ArtifactMetadata,
  ): Promise<PublishedArtifact> {
    const filename = basename(artifactPath);
    const keyPrefix = this.options.keyPrefix.replace(/^\/+|\/+$/g, "");
    const key = `${keyPrefix}/${taskId}/${filename}`;
    const common = {
      Bucket: this.options.bucket,
      Region: this.options.region,
      Key: key,
    };
    await this.client.uploadFile({ ...common, FilePath: artifactPath });
    const downloadUrl = this.client.getObjectUrl({
      ...common,
      Sign: true,
      Expires: this.options.urlExpiresSeconds,
      Protocol: "https:",
    });
    const metadata = knownMetadata ?? (await readArtifactMetadata(artifactPath));
    return { filename, downloadUrl, ...metadata };
  }
}
