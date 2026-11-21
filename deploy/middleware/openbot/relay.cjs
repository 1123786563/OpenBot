const { rmSync } = require("node:fs");
const { createConnection, createServer } = require("node:net");

const socketPath = "/socket/openbot.sock";
process.umask(0o077);
rmSync(socketPath, { force: true });

createServer((client) => {
  const upstream = createConnection({ host: "127.0.0.1", port: 3001 });
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.pipe(upstream).pipe(client);
}).listen(socketPath);
