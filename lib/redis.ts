import { Redis } from "@upstash/redis";

// Upstash's client talks to Redis over REST (plain HTTPS requests, no
// persistent TCP connection to manage), so creating it at module scope
// is cheap and safe to do once per serverless instance. Reads
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN from the
// environment.
export const redis = Redis.fromEnv();
