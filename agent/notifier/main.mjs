// notifier entry point.
import http from "node:http";
import { env, intEnv, requireEnv } from "../shared/config.mjs";
import { logger } from "../shared/log.mjs";
import { createNotifier } from "./server.mjs";

const log = logger("notifier");
const handler = createNotifier({ token: requireEnv("NOTIFIER_TOKEN"), webhookUrl: env("GCHAT_WEBHOOK_URL"), log });
const server = http.createServer(handler);
server.listen(intEnv("PORT", 8080), () => log.info("notifier started", { webhook: !!env("GCHAT_WEBHOOK_URL") }));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
