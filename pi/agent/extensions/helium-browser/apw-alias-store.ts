import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function isAliasHostname(value: unknown): value is string {
	return typeof value === "string" && value.length <= 253 && value.includes(".") &&
		value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
		!/^\d+(?:\.\d+){3}$/.test(value);
}

function storeDirectory(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "state", "helium-apw-aliases");
}

function pairPath(destination: string, savedHostname: string): string {
	if (!isAliasHostname(destination) || !isAliasHostname(savedHostname)) throw new Error("APW aliases require exact lowercase DNS hostnames.");
	const key = createHash("sha256").update(JSON.stringify([destination, savedHostname])).digest("hex");
	return join(storeDirectory(), `${key}.json`);
}

/** Directed trust only: no reverse or transitive aliases are inferred. */
export async function hasApprovedAlias(destination: string, savedHostname: string): Promise<boolean> {
	if (!isAliasHostname(destination) || !isAliasHostname(savedHostname)) return false;
	try {
		const data = await readFile(pairPath(destination, savedHostname), "utf8");
		if (data.length > 2048) throw new Error("Invalid APW alias record.");
		const value = JSON.parse(data);
		return value.version === 1 && value.destination === destination && value.savedHostname === savedHostname;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error("Cannot read approved APW alias.");
	}
}

/** Call only after interactive approval of this exact directed hostname pair. */
export async function saveApprovedAlias(destination: string, savedHostname: string, signal?: AbortSignal): Promise<void> {
	const path = pairPath(destination, savedHostname);
	signal?.throwIfAborted();
	await mkdir(storeDirectory(), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify({ version: 1, destination, savedHostname }), { mode: 0o600, flag: "wx", signal });
		signal?.throwIfAborted();
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
