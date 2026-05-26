import * as fs from 'fs';
import * as path from 'path';
import type { GitDdlObjectKind } from '../database/queryExecutor';
import { getKindFolderCandidates, resolveExistingGitFolderForKind } from './gitPaths';

export type GitFileKey = `${GitDdlObjectKind}:${string}`;

function toKey(kind: GitDdlObjectKind, name: string): GitFileKey {
	return `${kind}:${name}`;
}

export class GitFileIndexer {
	private fileMap = new Map<GitFileKey, string>();

	constructor(private root: string) {}

	get rootPath(): string {
		return this.root;
	}

	async rescan(): Promise<void> {
		this.fileMap.clear();
		if (!this.root) {
			return;
		}
		const kinds: GitDdlObjectKind[] = ['table', 'function', 'procedure'];
		for (const kind of kinds) {
			for (const folder of getKindFolderCandidates(kind)) {
				const dir = path.join(this.root, folder);
				await this.scanDir(kind, dir);
			}
		}
	}

	private async scanDir(kind: GitDdlObjectKind, dir: string): Promise<void> {
		try {
			const entries = await fs.promises.readdir(dir, { withFileTypes: true });
			for (const ent of entries) {
				if (!ent.isFile()) {
					continue;
				}
				const lower = ent.name.toLowerCase();
				if (!lower.endsWith('.sql')) {
					continue;
				}
				const name = ent.name.slice(0, -4);
				const key = toKey(kind, name);
				if (!this.fileMap.has(key)) {
					this.fileMap.set(key, path.join(dir, ent.name));
				}
			}
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== 'ENOENT') {
				throw err;
			}
		}
	}

	hasFile(kind: GitDdlObjectKind, objectName: string): boolean {
		return this.fileMap.has(toKey(kind, objectName));
	}

	getFilePath(kind: GitDdlObjectKind, objectName: string): string | undefined {
		return this.fileMap.get(toKey(kind, objectName));
	}

	async readFile(kind: GitDdlObjectKind, objectName: string): Promise<string | undefined> {
		const filePath = this.getFilePath(kind, objectName);
		if (!filePath) {
			return undefined;
		}
		return fs.promises.readFile(filePath, 'utf8');
	}

	async writeFile(kind: GitDdlObjectKind, objectName: string, content: string): Promise<string> {
		let filePath = this.getFilePath(kind, objectName);
		if (!filePath) {
			const dir = await resolveExistingGitFolderForKind(this.root, kind);
			filePath = path.join(dir, `${objectName}.sql`);
		}
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await fs.promises.writeFile(filePath, content, 'utf8');
		this.fileMap.set(toKey(kind, objectName), filePath);
		return filePath;
	}
}
