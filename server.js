import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { Server } from "socket.io";
import initSocket from "./socket/index.js";
import { createAdapter } from "@socket.io/redis-adapter";
import { createRedisClients } from "./redis.js";
import turnRoutes from "./routes/turn.routes.js";

// 🔴 JWT IMPORT ADD KARO
import jwt from "jsonwebtoken";

const app = express();
app.use("/api", turnRoutes);

app.get("/", (req, res) => {
  res.send("Talkify Signaling Server Running");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 🔴 DEBUG LOGS ADD KARO (YAHAN)
console.log("🚀 Signaling Server starting...");
console.log("🔐 ENV Check:");
console.log("   ACCESS_TOKEN_SECRET:", process.env.ACCESS_TOKEN_SECRET ? "SET" : "NOT SET");
console.log("   JWT_ACCESS_SECRET:", process.env.JWT_ACCESS_SECRET ? "SET" : "NOT SET");
console.log("   JWT_SECRET:", process.env.JWT_SECRET ? "SET" : "NOT SET");
console.log("   TURN_SECRET:", process.env.TURN_SECRET ? "SET" : "NOT SET");

// 🔴 SIRF YE NAYA AUTH MIDDLEWARE RAHE (line 67-108)
io.use((socket, next) => {
  //  console.log("\n=== 🔐 NEW CONNECTION ATTEMPT ===");
   // console.log("📦 Socket ID:", socket.id);
   // console.log("🔗 Handshake query:", socket.handshake.query);
   // console.log("🔑 Handshake auth object:", socket.handshake.auth);
   // console.log("🔑 Handshake auth keys:", Object.keys(socket.handshake.auth));
   // console.log("📦 Full handshake.query:", JSON.stringify(socket.handshake.query));
   // console.log("🔑 Full handshake.auth:", JSON.stringify(socket.handshake.auth));
    
    // Pehle query params check karo
    const query = socket.handshake.query;
    // Check ALL query params
    console.log("🔍 Query params check:");
    for (const key in query) {
        console.log(`   ${key}: ${query[key]}`);
    }
    
    // Token query se ya auth se
    const token = query.authToken || query.token || socket.handshake.auth.token;
       console.log("🔍 Looking for token in: authToken, token, handshake.auth");
    
    if (token) {
         console.log("✅ Token found (length):", token.length);
        console.log("✅ Token first 50 chars:", token.substring(0, 50) + "...");
        try {
            const secret = process.env.ACCESS_TOKEN_SECRET;
            const decoded = jwt.verify(token, secret);
            socket.userId = decoded.sub || decoded.userId || decoded.id;
            console.log("🎉 Auth SUCCESS - User ID:", socket.userId);
            return next();
        } catch (err) {
            console.log("❌ Token verification failed:", err.message);
            console.log("❌ Token value:", token);
        }
    } else {
          console.log("❌ NO token found in query or auth");
    }
    
    // UserId directly from query (temporary fallback)
    const userId = query.userId;
    if (userId) {
        console.log("📝 Using userId from query:", userId);
        socket.userId = userId;
        return next();
    }
    
    console.log("⚠️ No auth, connection rejected");
    return next(new Error("AUTH_REQUIRED"));
});

// ---- Redis Adapter Setup ----
try {
  const { pubClient, subClient } = await createRedisClients();
  io.adapter(createAdapter(pubClient, subClient));
  console.log("✅ Redis adapter connected");
} catch (err) {
  console.error("❌ Redis adapter failed:", err.message);
}

// attach socket logic
initSocket(io);

const PORT = process.env.PORT || 7000;

server.listen(PORT, () => {
  console.log("🚀 Signaling Server running on port", PORT);
});