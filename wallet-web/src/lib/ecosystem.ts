export type EcosystemLink = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
};

export const ECOSYSTEM_LINKS: readonly EcosystemLink[] = Object.freeze([
  { id: "kovanica", label: "Kovanica", href: "https://kovanica.online" },
  { id: "testnet", label: "Testnet", href: "https://testnet.kovanica.online" },
  { id: "explorer", label: "Explorer", href: "https://testnet.kovanica.online/explorer" },
  { id: "swap", label: "Swap", href: "https://testnet.kovanica.online/swap" },
  { id: "pools", label: "Pools", href: "https://testnet.kovanica.online/pools" },
  { id: "rwa", label: "RWA", href: "https://testnet.kovanica.online/rwa" },
  { id: "playground", label: "Playground", href: "https://playground.kovanica.online" },
  { id: "docs", label: "Docs", href: "https://docs.kovanica.online" },
]);
