import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { isIP } from 'node:net';

export interface TailnetListener { target: string; close(): Promise<void> }
/** A private loopback backend for the embedded tsnet node, with the original peer preserved. */
export async function listenTailnetProxy(http: HttpServer, peers: WeakMap<Socket, string>): Promise<TailnetListener> {
  // Node starts HTTP header/body timeout tracking only on its real listening lifecycle.
  // This private listener rejects requests without a verified peer; only the PROXY handoff supplies one.
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve(); });
  });
  const closeHttp = async () => {
    http.closeAllConnections();
    if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
  };
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); });
    socket.on('error', () => { socket.destroy(); });
    // The embedded node connects here. Never accept an ordinary HTTP request or an unbounded prefix.
    const timer = setTimeout(() => socket.destroy(), 5000).unref();
    socket.once('close', () => clearTimeout(timer));
    let prefix = Buffer.alloc(0);
    const consume = (chunk: Buffer) => {
      const bytes = Buffer.concat([prefix, chunk]);
      const end = bytes.indexOf('\r\n');
      if (end < 0) {
        if (bytes.length > 106) socket.destroy(); else prefix = bytes;
        return;
      }
      if (end > 106) { socket.destroy(); return; }
      const fields = bytes.subarray(0, end).toString('ascii').split(' ');
      const [signature, family, source, destination, sourcePort, destinationPort] = fields;
      const version = family === 'TCP4' ? 4 : family === 'TCP6' ? 6 : 0;
      const port = (value: string | undefined) => !!value && /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 65535;
      if (fields.length !== 6 || signature !== 'PROXY' || !version || isIP(source ?? '') !== version
          || isIP(destination ?? '') !== version || !port(sourcePort) || !port(destinationPort)) { socket.destroy(); return; }
      socket.pause(); socket.off('data', consume); clearTimeout(timer);
      peers.set(socket, source!);
      if (bytes.length > end + 2) socket.unshift(bytes.subarray(end + 2));
      http.emit('connection', socket);
      socket.resume();
    };
    socket.on('data', consume);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { await closeHttp(); throw error; }
  return {
    target: `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await closeHttp();
    },
  };
}
