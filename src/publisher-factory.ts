import COS from "cos-nodejs-sdk-v5";

import {
  CosArtifactPublisher,
  FilesystemArtifactPublisher,
  type ArtifactPublisher,
  type CosClient,
} from "./artifact-publisher.ts";
import type { BotConfig, RuntimeSecrets } from "./config.ts";

type CosCredentials = NonNullable<RuntimeSecrets["cos"]>;
type CosClientFactory = (credentials: CosCredentials) => CosClient;

function defaultCosClientFactory(credentials: CosCredentials): CosClient {
  return new COS({
    SecretId: credentials.secretId,
    SecretKey: credentials.secretKey,
  }) as CosClient;
}

export function createArtifactPublisher(
  config: BotConfig,
  secrets: RuntimeSecrets,
  createCosClient: CosClientFactory = defaultCosClientFactory,
): ArtifactPublisher {
  if (config.artifact.provider === "filesystem") {
    return new FilesystemArtifactPublisher(config.artifact.filesystem);
  }
  if (secrets.cos === undefined) {
    throw new Error("COS 发布模式缺少 COS_SECRET_ID 或 COS_SECRET_KEY");
  }
  return new CosArtifactPublisher(createCosClient(secrets.cos), config.artifact.cos);
}
