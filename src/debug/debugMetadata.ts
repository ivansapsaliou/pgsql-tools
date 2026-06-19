import * as vscode from 'vscode';

/** Метаданные открытой routine DDL для отладки и breakpoints. */
export interface RoutineDebugMetadata {
	connectionName: string;
	schema: string;
	objectName: string;
	objectType: 'function' | 'procedure';
	specificName: string;
	oid?: number;
}

const uriToMeta = new Map<string, RoutineDebugMetadata>();

export function setRoutineDebugMetadata(uri: vscode.Uri, meta: RoutineDebugMetadata): void {
	uriToMeta.set(uri.toString(), meta);
}

export function getRoutineDebugMetadata(uri: vscode.Uri): RoutineDebugMetadata | undefined {
	return uriToMeta.get(uri.toString());
}

export function clearRoutineDebugMetadata(uri: vscode.Uri): void {
	uriToMeta.delete(uri.toString());
}
