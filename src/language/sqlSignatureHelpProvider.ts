import * as vscode from 'vscode';
import { SQLParser } from './sqlParser';
import { SqlSchemaRegistry, type RoutineInfo } from './sqlSchemaRegistry';
import {
	findBuiltinFunctions,
	formatBuiltinSignature,
	type BuiltinFunctionSig,
} from './sqlBuiltinFunctions';

function isIntelliSenseEnabled(): boolean {
	return vscode.workspace
		.getConfiguration('pgsql-tools.intelliSense')
		.get<boolean>('enabled', true);
}

function formatRoutineSignature(routine: RoutineInfo, paramLabels: string[]): string {
	const args = paramLabels.length > 0 ? paramLabels.join(', ') : routine.identityArgs;
	return `${routine.name}(${args})`;
}

function builtinToSignature(fn: BuiltinFunctionSig): vscode.SignatureInformation {
	const label = formatBuiltinSignature(fn);
	const sig = new vscode.SignatureInformation(label);
	sig.documentation = fn.documentation
		? new vscode.MarkdownString(fn.documentation)
		: undefined;
	sig.parameters = fn.params.map((p) => {
		const info = new vscode.ParameterInformation(p);
		return info;
	});
	return sig;
}

export class SQLSignatureHelpProvider implements vscode.SignatureHelpProvider {
	constructor(private registry: SqlSchemaRegistry) {}

	async provideSignatureHelp(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken
	): Promise<vscode.SignatureHelp | null> {
		if (!isIntelliSenseEnabled()) {
			return null;
		}
		if (!this.registry.isConnected()) {
			return null;
		}

		await this.registry.ensureFresh();

		const offset = document.offsetAt(position);
		const textBefore = document.getText().slice(0, offset);
		const callCtx = SQLParser.getCallContext(textBefore);
		if (!callCtx?.isInsideCall) {
			return null;
		}

		const signatures: vscode.SignatureInformation[] = [];

		const builtins = findBuiltinFunctions(callCtx.name);
		for (const fn of builtins) {
			signatures.push(builtinToSignature(fn));
		}

		const routines = this.registry.findRoutinesByName(callCtx.name, callCtx.schema);
		for (const routine of routines) {
			const params = await this.registry.getRoutineParameters(
				routine.oid,
				routine.schema,
				routine.specificName
			);
			const paramLabels = params.map((p) => {
				const mode = p.mode && p.mode !== 'IN' ? `${p.mode} ` : '';
				return `${mode}${p.name} ${p.dataType}`.trim();
			});
			const label = formatRoutineSignature(routine, paramLabels);
			const sig = new vscode.SignatureInformation(label);
			sig.documentation = new vscode.MarkdownString(
				`${routine.kind} · ${routine.schema}.${routine.name}`
			);
			sig.parameters = params.map((p) => {
				const labelText = `${p.name}: ${p.dataType}`;
				const info = new vscode.ParameterInformation(labelText);
				info.documentation = p.mode !== 'IN' ? `Mode: ${p.mode}` : undefined;
				return info;
			});
			signatures.push(sig);
		}

		if (signatures.length === 0) {
			return null;
		}

		const activeSignature = this.pickActiveSignature(signatures, callCtx.activeParameterIndex);

		return {
			signatures,
			activeSignature,
			activeParameter: Math.min(
				callCtx.activeParameterIndex,
				(signatures[activeSignature]?.parameters?.length ?? 1) - 1
			),
		};
	}

	private pickActiveSignature(
		signatures: vscode.SignatureInformation[],
		argCount: number
	): number {
		let best = 0;
		let bestScore = -1;
		for (let i = 0; i < signatures.length; i++) {
			const paramCount = signatures[i].parameters?.length ?? 0;
			const score =
				argCount <= paramCount ? paramCount - argCount : -(argCount - paramCount);
			if (score > bestScore) {
				bestScore = score;
				best = i;
			}
		}
		return best;
	}
}
