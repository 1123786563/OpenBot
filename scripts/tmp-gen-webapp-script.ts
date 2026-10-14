import { buildWebappBootstrapScript } from "../server/src/craft/nextjs-dev";
process.stdout.write(buildWebappBootstrapScript({
  sessionDirectory: process.argv[2] as string,
  port: Number(process.argv[3]),
}));
