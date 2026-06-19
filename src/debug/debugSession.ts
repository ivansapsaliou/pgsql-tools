import * as pg from 'pg';
import { ConnectionManager } from '../database/connectionManager';
import { QueryExecutor } from '../database/queryExecutor';
import type { GitDdlObjectKind } from '../database/queryExecutor';
import { DebugControlConnection } from './debugConnection';
import { parseDebugNotice, type DebugTraceEvent } from './debugProtocol';
import type { BreakpointKey } from './debugBreakpoints';
import { DebugBreakpointStore } from './debugBreakpoints';
import { buildDebugDoBlock, instrumentPlpgsqlBody, type InstrumentMode } from './plpgsqlInstrumenter';
import { parseRoutineDdl, PlpgsqlParseError } from './plpgsqlParse';
import { collectTraceableVariableNames } from './traceVariables';
import { rewriteReturnsForDo } from './plpgsqlTransform';
import { canCaptureFunctionReturn } from './routineReturn';

export interface DebugSessionTarget {
	connectionName: string;
	schema: string;
	routineName: string;
	kind: GitDdlObjectKind;
	specificName?: string;
}

export interface DebugSessionOptions {
	mode: InstrumentMode;
	/** SQL-фрагменты для := (по порядку IN/INOUT параметров). */
	argAssignments: string[];
	/** Конкретная перегрузка после выбора в sidebar. */
	specificName: string;
}

export type DebugSessionState = 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'error';

export interface DebugSessionCallbacks {
	onStateChange: (state: DebugSessionState) => void;
	onTrace: (event: DebugTraceEvent) => void;
	onError: (message: string) => void;
	/** Список отслеживаемых переменных (после разбора DDL). */
	onPrepared?: (traceVariableNames: string[]) => void;
}

export class PlpgsqlDebugSession {
	private state: DebugSessionState = 'idle';
	private sessionKey = Math.floor(Math.random() * 0x7fffffff);
	private lastDebugSql = '';
	private runClient: pg.Client | null = null;
	private pausedLine: number | null = null;
	private target?: DebugSessionTarget;
	private breakpointKey?: BreakpointKey;

	constructor(
		private readonly connectionManager: ConnectionManager,
		private readonly queryExecutor: QueryExecutor,
		private readonly control: DebugControlConnection,
		private readonly breakpoints: DebugBreakpointStore,
		private readonly callbacks: DebugSessionCallbacks
	) {}

	getState(): DebugSessionState {
		return this.state;
	}

	getPausedLine(): number | null {
		return this.pausedLine;
	}

	getSessionKey(): number {
		return this.sessionKey;
	}

	getLastDebugSql(): string {
		return this.lastDebugSql;
	}

	async start(target: DebugSessionTarget, options: DebugSessionOptions): Promise<void> {
		if (this.state === 'running' || this.state === 'paused') {
			await this.stop();
		}
		this.target = target;
		this.sessionKey = Math.floor(Math.random() * 0x7fffffff);
		this.pausedLine = null;
		this.setState('running');

		const client = this.connectionManager.getConnectionByName(target.connectionName);
		if (!client) {
			this.fail('Подключение не активно');
			return;
		}
		this.runClient = client;

		try {
			const resolved = await this.queryExecutor.resolveRoutineOnClient(
				client,
				target.schema,
				target.routineName,
				target.kind,
				options.specificName || target.specificName
			);
			if (resolved.length === 0) {
				this.fail('Функция/процедура не найдена');
				return;
			}
			const routine =
				resolved.find(
					(r) =>
						r.specificName ===
						(options.specificName || target.specificName || r.specificName)
				) ?? resolved[0];

			if (routine.language !== 'plpgsql') {
				this.fail(`Язык ${routine.language} не поддерживается`);
				return;
			}

			this.breakpointKey = {
				connectionName: target.connectionName,
				schema: target.schema,
				specificName: routine.specificName,
			};

			const parsed = parseRoutineDdl(routine.ddl);
			const varNames = collectTraceableVariableNames(parsed);
			this.callbacks.onPrepared?.(varNames);
			const bpLines = this.breakpoints.getLinesFor(this.breakpointKey);

			let body = parsed.body;
			if (canCaptureFunctionReturn(parsed)) {
				body = rewriteReturnsForDo(body, '_pgsql_tools_result');
			}

			const instrumented = instrumentPlpgsqlBody(body, {
				mode: options.mode,
				breakpointLines: bpLines,
				parsed,
				sessionKey: this.sessionKey,
				varNames,
			});

			const sql = buildDebugDoBlock(parsed, instrumented.code, options.argAssignments);
			this.lastDebugSql = sql;

			await this.control.acquire(target.connectionName);

			const result = await this.queryExecutor.executeWithNotices(client, sql, (msg) => {
				const ev = parseDebugNotice(msg);
				if (!ev) {
					return;
				}
				this.callbacks.onTrace(ev);
				if (ev.type === 'pause') {
					this.pausedLine = ev.line;
					this.setState('paused');
				}
			});

			if (result.error) {
				this.fail(result.error.message);
				return;
			}
			if (this.state === 'paused') {
				return;
			}
			this.setState('completed');
		} catch (err) {
			if (err instanceof PlpgsqlParseError) {
				this.fail(err.message);
			} else {
				this.fail(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (this.state !== 'paused') {
				await this.control.release();
			}
		}
	}

	async continue(): Promise<void> {
		if (this.state !== 'paused' || this.pausedLine === null) {
			return;
		}
		try {
			await this.control.unlockAdvisory(this.sessionKey, this.pausedLine);
			this.pausedLine = null;
			this.setState('running');
		} catch (err) {
			this.callbacks.onError(err instanceof Error ? err.message : String(err));
		}
	}

	async stop(): Promise<void> {
		const client = this.runClient;
		if (client) {
			try {
				const pidRes = await client.query('SELECT pg_backend_pid() AS pid');
				const pid = pidRes.rows[0]?.pid;
				if (pid) {
					await this.control.acquire(this.target?.connectionName ?? '');
					await this.control.cancelBackend(Number(pid));
				}
			} catch {
				/* ignore */
			}
		}
		if (this.pausedLine !== null) {
			try {
				await this.control.unlockAdvisory(this.sessionKey, this.pausedLine);
			} catch {
				/* ignore */
			}
		}
		this.pausedLine = null;
		await this.control.release();
		this.setState('stopped');
	}

	private setState(s: DebugSessionState): void {
		this.state = s;
		this.callbacks.onStateChange(s);
	}

	private fail(message: string): void {
		this.callbacks.onError(message);
		this.setState('error');
	}
}
