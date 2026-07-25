import path from "node:path";

import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";

import { requestLogger } from "./request-log.mjs";

process.env.NODE_ENV ??= "production";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const build = await import("../build/server/index.js");
const clientDirectory = path.resolve("build/client");
const app = express();

app.disable("x-powered-by");
// The supported deployment has a single local nginx hop. This lets React Router reconstruct the
// public HTTPS request without trusting forwarded headers from non-loopback clients.
app.set("trust proxy", "loopback");
app.use(compression());
app.use(requestLogger);
app.use(
  "/assets",
  express.static(path.join(clientDirectory, "assets"), {
    immutable: true,
    maxAge: "1y",
  }),
);
app.use(express.static(clientDirectory, { maxAge: "1h" }));
app.all(
  "/{*splat}",
  createRequestHandler({ build, mode: process.env.NODE_ENV }),
);

const onListen = () => {
  const host = process.env.HOST ?? "localhost";
  console.info(`harnesst listening on http://${host}:${port}`);
};
const server = process.env.HOST
  ? app.listen(port, process.env.HOST, onListen)
  : app.listen(port, onListen);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close());
}
