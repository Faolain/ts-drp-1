/** Public IPFS/libp2p infrastructure explicitly reviewed for public-only experiments. */
export const REVIEWED_DELEGATED_ROUTING_ENDPOINTS = ["https://delegated-ipfs.dev/routing/v1"] as const;

/** Official Amino DHT bootstrap peers published by the IPFS/libp2p project. */
export const OFFICIAL_AMINO_BOOTSTRAPPERS = [
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
] as const;
