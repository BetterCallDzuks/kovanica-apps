import { describe, expect, it } from "vitest";

import { NETWORK_PRESETS, presetById, presetFor } from "./networks";

describe("connection network switch", () => {
  it("offers the live chain-2 testnet first", () => {
    expect(NETWORK_PRESETS[0]).toEqual({
      id: "testnet",
      label: "Testnet (Chain 2)",
      chainId: 2,
      rpcUrl: "https://rpc-testnet.kovanica.online/rpc",
    });
  });

  it("keeps mainnet listed and devnet for development", () => {
    expect(presetById("mainnet")?.chainId).toBe(1);
    expect(presetById("devnet")?.chainId).toBe(3);
    expect(presetById("local")).toBeNull();
    expect(presetById("nope")).toBeNull();
  });

  it("matches a saved endpoint including a trailing slash", () => {
    expect(presetFor("https://rpc-testnet.kovanica.online/rpc")?.id).toBe("testnet");
    expect(presetFor("  https://rpc-testnet.kovanica.online/rpc/  ")?.id).toBe("testnet");
    expect(presetFor("http://127.0.0.1:8545/rpc")?.id).toBe("devnet");
    expect(presetFor("http://localhost:9999/rpc")).toBeNull();
  });
});
