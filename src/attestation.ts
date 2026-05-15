import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { env } from "./config.js";
import type { AttestationSnapshot } from "./types.js";

// EigenCompute layers a `kms-signing-public-key.pem` into the image at deploy
// time. Its presence is proof that the boot ran through the attested KMS
// pipeline (Caddy + tls-keygen + compute-source-env.sh decrypt sealed secrets
// only after the TDX quote is verified). We hash that pem and surface it as
// the attestation hash — anyone can verify against the dashboard at
// verify-sepolia.eigencloud.xyz/app/<ECLOUD_APP_ID>.
const KMS_PEM_PATH = "/usr/local/bin/kms-signing-public-key.pem";

// Per-receipt: read fresh on every call. PRD §10 forbids caching.
export const readAttestation = (): AttestationSnapshot => {
  if (existsSync(KMS_PEM_PATH)) {
    const pem = readFileSync(KMS_PEM_PATH);
    const pemHash = createHash("sha256").update(pem).digest("hex");
    return {
      gitSha: env.GIT_SHA,
      buildTime: env.BUILD_TIME,
      appId: env.ECLOUD_APP_ID || "unknown",
      attestationHash: `sha256:${pemHash}`,
      source: "tee",
    };
  }

  // Explicit override path for non-KMS deployments that still want to assert
  // the TEE source (e.g. injecting both vars manually).
  if (env.ECLOUD_ATTESTATION_HASH) {
    return {
      gitSha: env.GIT_SHA,
      buildTime: env.BUILD_TIME,
      appId: env.ECLOUD_APP_ID,
      attestationHash: env.ECLOUD_ATTESTATION_HASH,
      source: "tee",
    };
  }

  // Local dev surrogate: a deterministic hash over (gitSha, buildTime) so the
  // UI has *something* to render but it is clearly tagged source: "local-dev".
  const surrogate = createHash("sha256")
    .update(`local-dev:${env.GIT_SHA}:${env.BUILD_TIME}`)
    .digest("hex");
  return {
    gitSha: env.GIT_SHA,
    buildTime: env.BUILD_TIME,
    appId: env.ECLOUD_APP_ID || "local",
    attestationHash: `sha256:${surrogate}`,
    source: "local-dev",
  };
};
