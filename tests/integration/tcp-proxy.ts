import net from 'node:net';

export interface TcpProxy {
  /** `redis://` URL pointing at the proxy rather than at the real server. */
  url: string;
  /** Drops every live connection and stops forwarding new ones. */
  fail: () => void;
  /** Forwards again; the client reconnects on its own schedule. */
  restore: () => void;
  close: () => Promise<void>;
}

/**
 * An in-process TCP proxy, so a test can take Redis away from one application
 * instance without stopping the container the rest of the suite shares. Failing
 * mode accepts the connection and then says nothing, which is the sick-but-
 * reachable store ADR 0019 cares most about.
 */
export async function startTcpProxy(target: string): Promise<TcpProxy> {
  const { hostname, port } = new URL(target);
  let forwarding = true;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('error', () => client.destroy());
    client.on('close', () => sockets.delete(client));
    if (!forwarding) return; // accepted, then silence
    const upstream = net.connect(Number(port), hostname);
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => sockets.delete(upstream));
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const listening = server.address() as net.AddressInfo;

  const destroyAll = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };

  return {
    url: `redis://127.0.0.1:${listening.port}`,
    fail: () => {
      forwarding = false;
      destroyAll();
    },
    restore: () => {
      forwarding = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        destroyAll();
        server.close(() => resolve());
      }),
  };
}
