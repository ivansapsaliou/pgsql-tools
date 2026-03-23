import * as net from 'net';
import { Client as SshClient, ConnectConfig, ClientChannel } from 'ssh2';

export interface SshConfig {
	host: string;
	port: number;
	username: string;
	password?: string;
	privateKey?: string | Buffer;
	passphrase?: string;
}

export interface TunnelInfo {
	localPort: number;
	close: () => void;
}

export function openSshTunnel(
	sshConfig: SshConfig,
	remoteHost: string,
	remotePort: number
): Promise<TunnelInfo> {
	return new Promise((resolve, reject) => {
		const sshClient = new SshClient();
		const sockets: net.Socket[] = [];
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		const server = net.createServer((localSocket: net.Socket) => {
			sockets.push(localSocket);

			sshClient.forwardOut(
				'127.0.0.1',
				0,
				remoteHost,
				remotePort,
				(err: Error | undefined, stream: ClientChannel) => {
					if (err) {
						localSocket.destroy();
						return;
					}
					// ClientChannel extends Duplex — pipe напрямую
					localSocket.pipe(stream as unknown as NodeJS.WritableStream);
					(stream as unknown as NodeJS.ReadableStream).pipe(localSocket);

					const cleanup = () => {
						try { localSocket.destroy(); } catch { /* ignore */ }
						try { stream.destroy(); } catch { /* ignore */ }
					};
					stream.on('close', cleanup);
					stream.on('error', cleanup);
					localSocket.on('close', () => { try { stream.destroy(); } catch { /* ignore */ } });
					localSocket.on('error', () => { try { stream.destroy(); } catch { /* ignore */ } });
				}
			);
		});

		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as net.AddressInfo;

			const cfg: ConnectConfig = {
				host:     sshConfig.host,
				port:     sshConfig.port,
				username: sshConfig.username,
			};

			if (sshConfig.privateKey) {
				cfg.privateKey  = sshConfig.privateKey;
				cfg.passphrase  = sshConfig.passphrase;
			} else {
				cfg.password = sshConfig.password;
			}

			sshClient.connect(cfg);

			sshClient.on('ready', () => {
				settle(() =>
					resolve({
						localPort: addr.port,
						close: () => {
							sockets.forEach(s => { try { s.destroy(); } catch { /* ignore */ } });
							try { server.close(); } catch { /* ignore */ }
							try { sshClient.end(); } catch { /* ignore */ }
						},
					})
				);
			});

			sshClient.on('error', (err: Error) => {
				settle(() => {
					try { server.close(); } catch { /* ignore */ }
					reject(new Error(`SSH connection error: ${err.message}`));
				});
			});
		});

		server.on('error', (err: Error) => {
			settle(() => reject(new Error(`Tunnel server error: ${err.message}`)));
		});
	});
}