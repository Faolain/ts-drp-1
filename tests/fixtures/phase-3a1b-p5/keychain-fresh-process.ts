import { Keychain } from "../../../packages/keychain/src/keychain.js";

type P5Keychain = Keychain &
	Readonly<{
		localAuthorId: string;
		signWithLocalAuthor(registeredDigest: Uint8Array): Promise<Uint8Array>;
	}>;

const [, , seed, digestHex] = process.argv;

if (seed === undefined || digestHex === undefined || !/^[0-9a-f]{64}$/u.test(digestHex)) {
	throw new Error("usage: keychain-fresh-process <seed> <64-lowercase-hex-digest>");
}

const digest = Uint8Array.from(digestHex.match(/../gu) ?? [], (octet) => Number.parseInt(octet, 16));
const keychain = new Keychain({ private_key_seed: seed }) as P5Keychain;
await keychain.start();
const signature = await keychain.signWithLocalAuthor(digest);

process.stdout.write(
	`${JSON.stringify({
		authorId: keychain.localAuthorId,
		signatureHex: Array.from(signature, (octet) => octet.toString(16).padStart(2, "0")).join(""),
	})}\n`
);
