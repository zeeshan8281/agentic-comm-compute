import { createHash } from "node:crypto";
import { env } from "./config.js";
import type { AttestationSnapshot } from "./types.js";

// EigenCompute generates a TDX vTPM measurement at boot. The Eigen runtime is
// expected to expose it as ECLOUD_ATTESTATION_HASH (matches the dual402-starter
// pattern). When that env is absent we are running locally — surface that
// honestly rather than fabricating a hash.
//
// Per-receipt: this is read fresh on every call. PRD §10 forbids caching.
export const readAttestation = (): AttestationSnapshot => {
  const hasTeeAttestation = Boolean(env.ECLOUD_ATTESTATION_HASH);

  if (hasTeeAttestation) {
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
