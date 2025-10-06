import "./dotenv.js";

// Polyfill for crypto global object (required for @aptos-labs/siwa)
import { webcrypto } from "crypto";
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

import FastifyCors from "@fastify/cors";
import FastifyMultipart from "@fastify/multipart";
import FastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { addressRoutes } from "./src/routes/addressRoutes.js";
import { authRoutes } from './src/routes/authRoutes.js';
import { cctpRoutes } from "./src/routes/cctpRoutes.js";
import { linkRoutes } from "./src/routes/linkRoutes.js";
import { fileRoutes } from "./src/routes/fileRoutes.js";
import { userRoutes } from "./src/routes/userRoutes.js";
import { payRoutes } from "./src/routes/payRoutes.js";
import { txRoutes } from "./src/routes/txRoutes.js";
import { cctpWorkers } from "./src/workers/cctpWorker.js";
import { aptosStealthWorkers } from "./src/workers/aptos/aptosStealthWorkers.js";
import { aptosTokenWorker } from "./src/workers/aptos/aptosTokenWorker.js";

console.log(
  "======================\n======================\nPIVY BACKEND SYSTEM STARTED!\n======================\n======================\n"
);

const fastify = Fastify({
  logger: false,
});

fastify.register(FastifyMultipart, {
  limits: {
    fieldNameSize: 200, // Max field name size in bytes
    fieldSize: 1000000, // Max field value size in bytes (1MB for large JSON configs)
    fields: 100,        // Max number of non-file fields (plenty for your payload)
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 10,         // Max number of file fields
  },
  attachFieldsToBody: true, // Attach fields to request.body
});

fastify.register(FastifyCors, {
  origin: [
    "https://pivy.me",
    "https://www.pivy.me",
    "http://localhost:3000",
    "http://localhost:3001",
    "https://aptos.pivy.me"
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "token",
    "cf-turnstile-response",
    "Accept",
    "Origin",
    "X-Requested-With"
  ],
  credentials: true, // Important if you're sending cookies/auth
  preflightContinue: false, // Let fastify-cors handle preflight
  optionsSuccessStatus: 204 // Some legacy browsers choke on 204
});

// Global rate limiting - 100 requests per minute
await fastify.register(FastifyRateLimit, {
  max: 150,
  timeWindow: '1 minute',
  skipOnError: true, // Don't fail requests if rate limiter has issues
  keyGenerator: (req) => {
    // Use IP address as key for rate limiting
    return req.ip;
  }
});

// Rate-limited 404 handler to prevent URL guessing attacks
fastify.setNotFoundHandler({
  preHandler: fastify.rateLimit({
    max: 10, // Stricter limit for 404s
    timeWindow: '1 minute'
  })
}, (request, reply) => {
  reply.code(404).send({
    success: false,
    message: "Resource not found",
    error: "NOT_FOUND",
    data: null
  });
});

fastify.get("/", async (request, reply) => {
  return reply.status(200).send({
    message: "Hello there!",
    error: null,
    data: null,
  });
});

/* --------------------------------- Routes --------------------------------- */
fastify.register(authRoutes, {
  prefix: '/auth'
})

fastify.register(userRoutes, {
  prefix: '/user'
})

fastify.register(addressRoutes, {
  prefix: '/address'
})

fastify.register(linkRoutes, {
  prefix: '/links'
})

fastify.register(fileRoutes, {
  prefix: '/files'
})

fastify.register(payRoutes, {
  prefix: '/pay'
})

fastify.register(cctpRoutes, {
  prefix: '/cctp'
})

fastify.register(txRoutes, {
  prefix: '/tx'
})


/* --------------------------------- Workers -------------------------------- */
if (process.env.WORKERS_ENABLED === "true") {
  fastify.register(cctpWorkers)
  fastify.register(aptosStealthWorkers)
  fastify.register(aptosTokenWorker)
  // fastify.register(balanceWorker)
}


const start = async () => {
  try {
    const port = process.env.APP_PORT || 3470;
    await fastify.listen({
      port: port,
      host: "0.0.0.0",
    });

    console.log(
      `Server started successfully on port ${fastify.server.address().port}`
    );
    console.log(`http://localhost:${fastify.server.address().port}`);
  } catch (error) {
    console.error("Error starting server: ", error);
    process.exit(1);
  }
};

start();