import { createClient } from "redis";

export async function createRedisClients() {

  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

  const pubClient = createClient({
    url: redisUrl
  });

  const subClient = pubClient.duplicate();

  pubClient.on("error", (err) =>
    console.error("❌ Redis Pub Error:", err)
  );

  subClient.on("error", (err) =>
    console.error("❌ Redis Sub Error:", err)
  );

  await pubClient.connect();
  await subClient.connect();

  console.log("✅ Redis Pub/Sub connected");

  return { pubClient, subClient };
}