import { env } from './env.js';

export const redisConnection = {
  host: env.redis.host,
  port: env.redis.port,
  username: env.redis.username,
  password: env.redis.password,
  tls: env.redis.tls,
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    return Math.min(times * 2000, 15000);
  },
};
