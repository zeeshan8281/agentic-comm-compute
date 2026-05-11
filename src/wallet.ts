import { type Hex } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { env } from "./config.js";

// v1 wallet: a viem LocalAccount derived from a raw private key. x402-fetch
// accepts a LocalAccount directly as its signer; no wallet client needed.
//
// v2 swaps this for a CDP smart wallet so spend caps move into the policy
// engine instead of agent code. The seam is `getSigner()` — anything that
// satisfies x402's `Wallet` union works.

const chainFor = (network: string) =>
  network === "base" || network === "eip155:8453" ? base : baseSepolia;

export type AgentWallet = {
  address: `0x${string}`;
  chainId: number;
  account: LocalAccount;
};

let cached: AgentWallet | undefined;

export const getWallet = (): AgentWallet => {
  if (cached) return cached;

  if (!env.AGENT_PRIVATE_KEY) {
    throw new Error(
      "AGENT_PRIVATE_KEY is unset. Generate one with `cast wallet new` and fund the address on Base Sepolia.",
    );
  }

  const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex);
  const chain = chainFor(env.X402_NETWORK);
  cached = { address: account.address, chainId: chain.id, account };
  return cached;
};
