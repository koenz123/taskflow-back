import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { callInteractiveRoutes } from "./api/routes/callInteractive.js";

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((s) => s.trim()),
  });

  await app.register(callInteractiveRoutes);

  app.get("/", async (_req, reply) => {
    return reply.send({
      name: "telephone-bot-api",
      version: "1.0",
      endpoints: {
        health: "GET /",
        testDialog: "POST /api/test-dialog",
        callInteractive: "GET|POST /telphin/call-interactive",
      },
      baseUrl: config.baseUrl,
    });
  });

  app.listen({ port: config.port, host: "0.0.0.0" }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`Server listening at ${address}`);
    app.log.info(`Call Interactive URL: ${config.baseUrl}/telphin/call-interactive`);
  });
}

main();
