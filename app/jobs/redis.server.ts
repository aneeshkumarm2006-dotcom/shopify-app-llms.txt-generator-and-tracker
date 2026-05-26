// Single shared ioredis connection used by both the queue (producer) and the
// worker (consumer). BullMQ requires `maxRetriesPerRequest: null` for
// connections used by Workers — without it, blocking commands time out and
// the worker errors. The same connection is safe for the producer.

import IORedis, { type Redis } from "ioredis";

let cached: Redis | null = null;

export class RedisNotConfiguredError extends Error {
  constructor() {
    super(
      "REDIS_URL is not set. Configure it in .env (local) or your host's " +
        "environment variables. BullMQ requires a Redis instance.",
    );
    this.name = "RedisNotConfiguredError";
  }
}

export function getRedis(): Redis {
  if (cached) return cached;
  const url = process.env.REDIS_URL;
  if (!url) throw new RedisNotConfiguredError();
  cached = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return cached;
}

// For tests / shutdown — drain the connection cleanly.
export async function closeRedis() {
  if (!cached) return;
  await cached.quit();
  cached = null;
}
