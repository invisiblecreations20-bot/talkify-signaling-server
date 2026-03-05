import express from "express";
import crypto from "crypto";
import userAuth from "../middleware/userAuth.middleware.js";

const router = express.Router();

/**
 * GET /api/turn/credentials
 * Protected (User JWT)
 * Returns ICE servers with time-bound TURN credentials
 */
router.get("/turn/credentials", userAuth, async (req, res) => {
  try {
    // ✅ User from verified JWT (TalkifyAuth)
    const userId = req.user.id;

    // ✅ Reliable role detection (IMPORTANT FIX)
    const role = req.user.isReceiver ? "receiver" : "caller";

    // ⏱ 24 hours validity
    const ttlSeconds = 24 * 60 * 60;
    const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;

    // 👤 TURN username format (coturn standard)
    const username = `${expiry}:${role}_${userId}`;

    // 🔐 Shared secret (MUST match coturn.conf)
    const secret = process.env.TURN_SECRET;
    if (!secret) {
      throw new Error("TURN_SECRET not defined in environment");
    }

    // 🔑 Generate HMAC-SHA1 password
    const password = crypto
      .createHmac("sha1", secret)
      .update(username)
      .digest("base64");

    // 🌍 ICE servers (Production ready)
    const iceServers = [
      {
        urls: [
          "stun:turn1.talkify.app:3478",
        ],
      },
      {
        urls: [
          "turn:turn1.talkify.app:3478?transport=udp",
          "turn:turn1.talkify.app:3478?transport=tcp",
          "turns:turn1.talkify.app:5349?transport=tcp",
        ],
        username,
        credential: password,
      },
    ];

    return res.json({
      success: true,
      iceServers,
      expires_in: ttlSeconds,
    });

  } catch (err) {
    console.error("TURN CREDENTIAL ERROR:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to generate TURN credentials",
    });
  }
});

export default router;
