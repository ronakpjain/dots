import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHECKPOINT_ENTRY = "git-checkpoint";
const CHECKPOINT_CAPABILITY =
	"[CHECKPOINT CAPABILITY] A Git checkpoint is created before a new /goal. Use /checkpoint to snapshot current work and /rollback to restore a checkpoint after confirmation.";
const GIT_WORKFLOW_CAPABILITY =
	"[GIT WORKFLOW CAPABILITY] After completing a major, coherent change—and before moving to a different task or starting the next major change—run the relevant checks and create a focused Git commit. First inspect git status and the diff, stage only files changed for this work, never include pre-existing unrelated user changes, and follow the repository's recent commit-message style. If a commit is blocked or inappropriate (for example, there is no Git repository or the user prohibited commits), pause and explain instead of silently moving on.";
const CHECKPOINT_VERSION = 1;

type CheckpointManifest = {
	version: number;
	id: string;
	label?: string;
	createdAt: string;
	repoRoot: string;
	head: string;
	branch: string;
	untracked: string[];
};

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function checkpointBase(repoRoot: string): string {
	const key = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
	return join(agentDir(), "checkpoints", key);
}

function safeRepoPath(repoRoot: string, value: string): string {
	const absolute = resolve(repoRoot, value);
	const root = resolve(repoRoot);
	if (absolute !== root && !absolute.startsWith(`${root}/`)) {
		throw new Error(`Git path escapes repository: ${value}`);
	}
	return absolute;
}

async function git(pi: ExtensionAPI, args: string[], cwd: string, timeout = 30_000): Promise<string> {
	const result = await pi.exec("git", args, { cwd, timeout });
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
		throw new Error(detail);
	}
	return result.stdout;
}

async function repoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	return (await git(pi, ["rev-parse", "--show-toplevel"], cwd)).trim();
}

async function untrackedFiles(pi: ExtensionAPI, root: string): Promise<string[]> {
	const output = await git(pi, ["ls-files", "--others", "--exclude-standard", "-z"], root);
	return output
		.split("\0")
		.filter(Boolean)
		.map((value) => {
			const absolute = safeRepoPath(root, value);
			return relative(root, absolute);
		});
}

async function copySnapshotPath(source: string, destination: string): Promise<void> {
	const info = await lstat(source);
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	if (info.isSymbolicLink()) {
		await symlink(await readlink(source), destination);
		return;
	}
	if (info.isFile()) {
		await copyFile(source, destination);
		return;
	}
	throw new Error(`Unsupported untracked path in checkpoint: ${source}`);
}

async function restoreSnapshotPath(source: string, destination: string): Promise<void> {
	const info = await lstat(source);
	await rm(destination, { force: true, recursive: true });
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	if (info.isSymbolicLink()) {
		await symlink(await readlink(source), destination);
		return;
	}
	if (info.isFile()) {
		await copyFile(source, destination);
		return;
	}
	throw new Error(`Unsupported checkpoint path: ${source}`);
}

async function writePatch(path: string, content: string): Promise<void> {
	await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
}

function manifestPath(directory: string): string {
	return join(directory, "manifest.json");
}

async function readManifest(path: string): Promise<CheckpointManifest | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as Partial<CheckpointManifest>;
		if (
			value.version !== CHECKPOINT_VERSION ||
			typeof value.id !== "string" ||
			typeof value.createdAt !== "string" ||
			typeof value.repoRoot !== "string" ||
			typeof value.head !== "string" ||
			typeof value.branch !== "string" ||
			!Array.isArray(value.untracked) ||
			!value.untracked.every((item) => typeof item === "string")
		)
			return undefined;
		return value as CheckpointManifest;
	} catch {
		return undefined;
	}
}

async function appendCheckpoint(pi: ExtensionAPI, manifest: CheckpointManifest): Promise<void> {
	pi.appendEntry(CHECKPOINT_ENTRY, {
		id: manifest.id,
		label: manifest.label,
		createdAt: manifest.createdAt,
		repoRoot: manifest.repoRoot,
		head: manifest.head,
		branch: manifest.branch,
	});
}

export async function createGitCheckpoint(
	pi: ExtensionAPI,
	cwd: string,
	label = "manual",
): Promise<CheckpointManifest> {
	const root = await repoRoot(pi, cwd);
	const head = (await git(pi, ["rev-parse", "HEAD"], root)).trim();
	const branch = (await git(pi, ["branch", "--show-current"], root)).trim() || "detached HEAD";
	const stagedPatch = await git(pi, ["diff", "--cached", "--binary"], root);
	const unstagedPatch = await git(pi, ["diff", "--binary"], root);
	const untracked = await untrackedFiles(pi, root);
	const createdAt = new Date().toISOString();
	const id = `${createdAt.replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
	const directory = join(checkpointBase(root), id);

	await mkdir(join(directory, "untracked"), { recursive: true, mode: 0o700 });
	await writePatch(join(directory, "staged.patch"), stagedPatch);
	await writePatch(join(directory, "unstaged.patch"), unstagedPatch);
	for (const path of untracked) {
		await copySnapshotPath(safeRepoPath(root, path), join(directory, "untracked", path));
	}

	const manifest: CheckpointManifest = {
		version: CHECKPOINT_VERSION,
		id,
		label,
		createdAt,
		repoRoot: root,
		head,
		branch,
		untracked,
	};
	await writeFile(manifestPath(directory), `${JSON.stringify(manifest, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return manifest;
}

async function checkpointList(repoRootValue: string): Promise<CheckpointManifest[]> {
	const base = checkpointBase(repoRootValue);
	let entries;
	try {
		entries = await readdir(base, { withFileTypes: true });
	} catch {
		return [];
	}
	const manifests = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => readManifest(manifestPath(join(base, entry.name)))),
	);
	return manifests
		.filter((manifest): manifest is CheckpointManifest => Boolean(manifest && manifest.repoRoot === repoRootValue))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function applyPatch(pi: ExtensionAPI, root: string, path: string, index: boolean): Promise<void> {
	const info = await lstat(path);
	if (!info.isFile() || info.size === 0) return;
	const args = ["apply", "--binary"];
	if (index) args.push("--index");
	args.push(path);
	await git(pi, args, root);
}

async function restoreGitCheckpoint(pi: ExtensionAPI, manifest: CheckpointManifest, cwd: string): Promise<void> {
	const root = await repoRoot(pi, cwd);
	if (resolve(root) !== resolve(manifest.repoRoot))
		throw new Error("Checkpoint belongs to a different Git repository");

	const directory = join(checkpointBase(root), manifest.id);
	const currentUntracked = await untrackedFiles(pi, root);
	await git(pi, ["reset", "--hard", manifest.head], root);
	for (const path of currentUntracked) {
		await rm(safeRepoPath(root, path), { force: true, recursive: true });
	}

	await applyPatch(pi, root, join(directory, "staged.patch"), true);
	await applyPatch(pi, root, join(directory, "unstaged.patch"), false);
	for (const path of manifest.untracked) {
		await restoreSnapshotPath(join(directory, "untracked", path), safeRepoPath(root, path));
	}
}

function formatCheckpoint(manifest: CheckpointManifest): string {
	return `${manifest.id} · ${manifest.branch} · ${manifest.label ?? "checkpoint"} · ${manifest.createdAt}`;
}

function latestSessionEntry(ctx: ExtensionContext): string | undefined {
	const entry = [...ctx.sessionManager.getBranch()].reverse().find((candidate) => "id" in candidate);
	return entry && typeof entry.id === "string" ? entry.id : undefined;
}

export default function checkpointExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${CHECKPOINT_CAPABILITY}\n\n${GIT_WORKFLOW_CAPABILITY}`,
	}));

	pi.registerCommand("checkpoint", {
		description: "Create or list Git worktree checkpoints",
		handler: async (args, ctx) => {
			try {
				const command = args.trim().toLowerCase();
				const root = await repoRoot(pi, ctx.cwd);
				if (command === "list") {
					const checkpoints = await checkpointList(root);
					ctx.ui.notify(
						checkpoints.length > 0
							? `Git checkpoints:\n${checkpoints.slice(0, 8).map(formatCheckpoint).join("\n")}`
							: "No Git checkpoints found.",
						"info",
					);
					return;
				}
				const manifest = await createGitCheckpoint(pi, ctx.cwd);
				await appendCheckpoint(pi, manifest);
				const entryId = latestSessionEntry(ctx);
				if (entryId) pi.setLabel(entryId, `checkpoint:${manifest.id}`);
				ctx.ui.notify(`Git checkpoint created: ${formatCheckpoint(manifest)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("rollback", {
		description: "Restore the latest Git checkpoint after confirmation",
		handler: async (args, ctx) => {
			try {
				const root = await repoRoot(pi, ctx.cwd);
				if (args.trim().toLowerCase() === "list") {
					const checkpoints = await checkpointList(root);
					ctx.ui.notify(
						checkpoints.length > 0
							? `Git checkpoints:\n${checkpoints.slice(0, 8).map(formatCheckpoint).join("\n")}`
							: "No Git checkpoints found.",
						"info",
					);
					return;
				}
				const requested = args.trim();
				const checkpoints = await checkpointList(root);
				const checkpoint = requested
					? checkpoints.find((candidate) => candidate.id === requested || candidate.id.startsWith(requested))
					: checkpoints[0];
				if (!checkpoint) {
					ctx.ui.notify(
						requested
							? `No Git checkpoint matched: ${requested}`
							: "No Git checkpoint exists for this repository.",
						"warning",
					);
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(
						"Rollback requires interactive confirmation and is unavailable in this mode.",
						"error",
					);
					return;
				}
				const approved = await ctx.ui.confirm(
					"Rollback Git worktree?",
					`Restore ${formatCheckpoint(checkpoint)}. Current tracked changes and non-ignored untracked files will be replaced. A safety checkpoint will be created first.`,
				);
				if (!approved) return;

				const safety = await createGitCheckpoint(pi, ctx.cwd, "pre-rollback");
				try {
					await restoreGitCheckpoint(pi, checkpoint, ctx.cwd);
					await appendCheckpoint(pi, safety);
					ctx.ui.notify(`Rolled back to ${checkpoint.id}. Safety checkpoint: ${safety.id}`, "info");
				} catch (error) {
					ctx.ui.notify(
						`Rollback failed. Safety checkpoint: ${safety.id}\n${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			} catch (error) {
				ctx.ui.notify(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
