/**
 * Official Amino DHT bootstrap peers published by the IPFS/libp2p project.
 *
 * The full canonical mainnet set from IPFS autoconfiguration
 * (https://conf.ipfs-mainnet.org/autoconf.json → SystemRegistry.AminoDHT.NativeConfig.Bootstrap):
 * 7 multiaddrs across 6 peer identities (the four `bootstrap.libp2p.io` nodes, the `va1` node, and
 * the long-standing "Mars" static node over both TCP and QUIC). Seeding the node DHT with the full
 * set gives a larger peer population for peer/relay discovery — including circuit-relay overflow
 * discovery — to walk. These are DISCOVERY seeds only; they are not relays (they advertise Relay v2
 * HOP but refuse reservations to arbitrary peers).
 */
export const OFFICIAL_AMINO_BOOTSTRAPPERS = [
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
	"/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8",
	"/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
	"/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
] as const;
