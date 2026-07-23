import type { RegistryServer } from "@ts-drp/rendezvous";
import { createRegistryHttpService } from "@ts-drp/rendezvous/service";

declare const server: RegistryServer;

async function serviceContract(): Promise<void> {
	const service = await createRegistryHttpService({ host: "127.0.0.1", port: 0, server });
	const url: string = service.url;
	const closed: Promise<void> = service.close();

	void url;
	void closed;
}

void serviceContract;
