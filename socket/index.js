
import jwt from "jsonwebtoken";
import { emitCallAnalytics } from "../utils/callAnalytics.js";
import fetch from "node-fetch";

async function sendAnalyticsEvent(token, payload) {
  try {
    await fetch(`${process.env.AUTH_BACKEND_URL}/api/call/analytics/event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("📊 Analytics send failed:", err.message);
  }
}


async function notifyCallEnd(callId, token) {
  try {
    await fetch(`${process.env.AUTH_BACKEND_URL}/api/call/end`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ callId }),
    });
  } catch (err) {
    console.error("❌ Failed to notify auth backend call end:", err.message);
  }
}

// In-memory maps (NO DB)
const activeUsers = new Map(); // userId -> socketId
const busyReceivers = new Map(); // receiverId -> callerId
const lastSeen = new Map(); 
const callTimers = new Map(); 


const socketRateMap = new Map(); // socketId -> { count, ts }
// ---------- ABUSE PROTECTION ----------
const abuseCount = new Map(); // userId -> count
const tempBlockedUsers = new Map(); // userId -> unblockAt

const ABUSE_LIMIT = 5;                 // max abuses
const TEMP_BLOCK_TIME = 5 * 60 * 1000; // 5 minutes

// ---------- RATE LIMIT CONFIG ----------
const RATE_LIMIT_WINDOW = 10 * 1000; // 10 seconds
const MAX_EVENTS_PER_WINDOW = 30;

function isRateLimited(socket) {
  const now = Date.now();
  const entry = socketRateMap.get(socket.id);

  if (!entry) {
    socketRateMap.set(socket.id, { count: 1, ts: now });
    return false;
  }

  if (now - entry.ts > RATE_LIMIT_WINDOW) {
    socketRateMap.set(socket.id, { count: 1, ts: now });
    return false;
  }

  entry.count += 1;

  return entry.count > MAX_EVENTS_PER_WINDOW;
}

function isTempBlocked(userId) {
  const unblockAt = tempBlockedUsers.get(userId);
  if (!unblockAt) return false;

  if (Date.now() > unblockAt) {
    tempBlockedUsers.delete(userId);
    abuseCount.delete(userId);
    return false;
  }
  return true;
}

function registerAbuse(userId, reason = "unknown") {
  const count = (abuseCount.get(userId) || 0) + 1;
  abuseCount.set(userId, count);

  console.warn(`🚨 Abuse ${count} by user ${userId} (${reason})`);

  if (count >= ABUSE_LIMIT) {
    tempBlockedUsers.set(userId, Date.now() + TEMP_BLOCK_TIME);

    console.error(`⛔ User ${userId} TEMP BLOCKED`);
  }
}
function forceDisconnectCall(io, callId, reason) {
  const room = `call_${callId}`;

  io.to(room).emit("force_disconnect", {
    callId,
    reason,
  });

  // clear timers
  const timers = callTimers.get(callId);
  if (timers) {
    if (timers.muteTimer) clearTimeout(timers.muteTimer);
    if (timers.holdTimer) clearTimeout(timers.holdTimer);
    callTimers.delete(callId);
  }

  // free receiver
  for (const [receiverId] of busyReceivers.entries()) {
    busyReceivers.delete(receiverId);
    console.log(`🟢 Receiver ${receiverId} freed due to ${reason}`);
  }

  console.log(`⛔ Call ${callId} force disconnected (${reason})`);
}
export default function initSocket(io) {
  // 🔐 SOCKET AUTH MIDDLEWARE
  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(" ")[1];

      if (!token) {
        return next(new Error("AUTH_REQUIRED"));
      }

      const payload = jwt.verify(
        token,
        process.env.ACCESS_TOKEN_SECRET
      );

      // ✅ attach user to socket
      socket.userId = payload.id;
      socket.userRole = payload.role || "user";

      return next();
    } catch (err) {
      return next(new Error("INVALID_TOKEN"));
    }
  });

  io.on("connection", (socket) => {
    // 🔥 AUTO REGISTER USER AS ONLINE IN SIGNALING
    if (socket.userId) {
    activeUsers.set(socket.userId, socket.id);
    console.log("🟢 activeUsers auto-add:", socket.userId, socket.id);
    }
    // --- Call quality runtime counters ---
    socket.reconnectCount = 0;
    console.log("🔐 Authenticated socket:", socket.id);

    /* ===============================
       JOIN CALL (register user)
       =============================== */
   socket.on("join_call", ({ userId }) => {
    if (!userId) return;

    // 🔥 remove old socket if exists
    const oldSocketId = activeUsers.get(userId);
    if (oldSocketId && oldSocketId !== socket.id) {
    console.log("♻️ Replacing old socket for user", userId);
    }
    if (oldSocketId && oldSocketId !== socket.id) {
    io.sockets.sockets.get(oldSocketId)?.disconnect(true);
    }
    activeUsers.set(userId, socket.id);
    socket.userId = userId;

    console.log(`👤 User ${userId} joined with socket ${socket.id}`);
    });
    /* ===============================
   HEARTBEAT (keep alive)
   =============================== */
    socket.on("heartbeat", () => {
    if (!socket.userId) return;
    lastSeen.set(socket.userId, Date.now());
    });
    /* ===============================
   CALL REQUEST (Relay Only)
   =============================== */
    socket.on("call_request", ({ callId, callerId, receiverId }) => {

    // 🔐 BASIC VALIDATION
    if (!callId || !callerId || !receiverId) {
    registerAbuse(socket.userId, "invalid_call_request_payload");
    return;
    }

    // ⛔ TEMP BLOCK CHECK
    if (isTempBlocked(socket.userId)) {
    socket.emit("blocked", {
      message: "Temporarily blocked due to abuse",
    });
    return;
    }

    // 🚨 RATE LIMIT (call spam protection)
    if (isRateLimited(socket)) {
    registerAbuse(socket.userId, "call_rate_limit");
    socket.emit("rate_limited", {
      message: "Too many call attempts. Slow down.",
    });
    return;
    }

    // 🚫 RECEIVER BUSY CHECK (socket-level safety)
    if (busyReceivers.has(receiverId)) {
    emitCallAnalytics("call_failed", {
    callId,
    callerId,
    receiverId,
    reason: "receiver_busy",
    });
    registerAbuse(socket.userId, "call_to_busy_receiver");
    socket.emit("call_busy", {
      receiverId,
      message: "Receiver is busy",
    });
    return;
    }

    // 📡 RECEIVER ONLINE CHECK
    const receiverSocket = activeUsers.get(receiverId);
    console.log(
    "📡 ACTIVE USERS MAP:",
    Array.from(activeUsers.entries())
    );

    console.log(
    "🔍 CHECK receiverSocket for receiverId =",
    receiverId,
    "=>",
    receiverSocket
    );
    if (!receiverSocket) {
     console.log("❌ RECEIVER OFFLINE (SERVER SIDE):", receiverId);
    emitCallAnalytics("call_failed", {
    callId,
    callerId,
    receiverId,
    reason: "receiver_offline",
    });

    registerAbuse(socket.userId, "call_to_offline_receiver");
    socket.emit("call_unavailable", {
      receiverId,
      message: "Receiver offline",
    });
    return;
    }

      // ✅ MARK RECEIVER BUSY (SIGNALING SIDE)
      // busyReceivers.set(receiverId, callerId);

      // 🔗 SAVE CURRENT CALL CONTEXT
    socket.currentCallId = callId;


    const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.split(" ")[1];

    if (token) {
    sendAnalyticsEvent(token, {
    callId,
    callerId,
    receiverId,
    eventType: "call_initiated",
    eventReason: "caller_requested",
    socketId: socket.id,
    });
    }

    // 📞 RELAY CALL TO RECEIVER
    io.to(receiverSocket).emit("incoming_call", {
    callId,
    callerId,
    });
    console.log(
    `📞 Call relayed | callId=${callId} | ${callerId} → ${receiverId}`
    );
    });


/* ===============================
   JOIN CALL ROOM (NEW - ADD)
   =============================== */
socket.on("call:join", ({ callId }) => {
  if (!callId) return;
socket.currentCallId = callId;
  const room = `call_${callId}`;
  socket.join(room);

  console.log(`🧩 Socket ${socket.id} joined room ${room}`);

  socket.to(room).emit("call:peer_joined", {
    userId: socket.userId,
    callId,
  });
});

    /* ===============================
       WEBRTC OFFER
       =============================== */
    socket.on("webrtc_offer", ({ callId, offer }) => {
  if (!callId || !offer) return;
  socket.to(`call_${callId}`).emit("webrtc_offer", {
    fromUserId: socket.userId,
    offer,
  });
});


    /* ===============================
       WEBRTC ANSWER
       =============================== */
    socket.on("webrtc_answer", ({ callId, answer }) => {
  if (!callId || !answer) return;
  socket.to(`call_${callId}`).emit("webrtc_answer", {
    fromUserId: socket.userId,
    answer,
  });
});


    /* ===============================
       ICE CANDIDATE
       =============================== */
    socket.on("webrtc_ice_candidate", ({ callId, candidate }) => {
  // 🚨 ICE flood protection + abuse tracking
  if (isRateLimited(socket)) {
    registerAbuse(socket.userId, "ice_flood");
    return;
  }

  if (!callId || !candidate) return;

  socket.to(`call_${callId}`).emit("webrtc_ice_candidate", {
    fromUserId: socket.userId,
    candidate,
  });
});
/* ===============================
   ICE / CONNECTION STATE TRACKING
   =============================== */

// ICE state update from client
socket.on("ice_state", ({ callId, state }) => {
  if (!callId || !state) return;

  console.log(
    `🧊 ICE STATE | callId=${callId} | user=${socket.userId} | state=${state}`
  );
});

// Peer connection state
socket.on("pc_state", ({ callId, state }) => {
  if (!callId || !state) return;

  console.log(
    `🔗 PC STATE | callId=${callId} | user=${socket.userId} | state=${state}`
  );

  if (state === "disconnected" || state === "failed") {
    socket.reconnectCount += 1;
    console.warn(
      `⚠️ Reconnect detected | callId=${callId} | count=${socket.reconnectCount}`
    );
  }
});
    /* ===============================
       RINGING
       =============================== */
    socket.on("ringing", ({ callerId }) => {
      const callerSocket = activeUsers.get(callerId);
      if (!callerSocket) return;

      io.to(callerSocket).emit("ringing", {
        receiverId: socket.userId,
      });

      console.log(`🔔 Ringing: ${socket.userId} → ${callerId}`);
    });

    /* ===============================
       ACCEPT CALL
       =============================== */
     socket.on("accept_call", ({ callerId }) => {

      const callerSocket = activeUsers.get(callerId);
      if (!callerSocket) return;

      io.to(callerSocket).emit("call_accepted", {
        receiverId: socket.userId,
      });
      // 🔥 यही सही जगह है BUSY mark करने की
        busyReceivers.set(socket.userId, callerId);
        callTimers.set(socket.currentCallId, {
      muteTimer: null,
      holdTimer: null,
      });

      console.log(
      `🔒 Receiver ${socket.userId} marked BUSY after accept_call`
      );
      // 🔥 ADMIN — REAL LIVE CONNECTED CALL (AFTER ACCEPT)
try {
  io.to("admins").emit("admin:call_update", {
    type: "CALL_CONNECTED",
    callId: socket.currentCallId,
    receiverId: socket.userId,
    callerId,
    connectedAt: new Date().toISOString(),
  });
} catch (e) {
  console.warn("admin CALL_CONNECTED emit failed:", e.message);
}
      const token =
  socket.handshake.auth?.token ||
  socket.handshake.headers?.authorization?.split(" ")[1];

if (token && socket.currentCallId) {
  sendAnalyticsEvent(token, {
    callId: socket.currentCallId,
    callerId,
    receiverId: socket.userId,
    eventType: "call_connected",
    eventReason: "receiver_accepted",
    socketId: socket.id,
  });
}

      emitCallAnalytics("call_connected", {
  callId: socket.currentCallId,
  callerId,
  receiverId: socket.userId,
});
      console.log(`✅ Call accepted by ${socket.userId}`);
    });

    /* ===============================
   BACKEND CALL ID RELAY
   =============================== */
socket.on("backend_call_id", ({ receiverId, backendCallId }) => {
  const receiverSocket = activeUsers.get(receiverId);
  if (!receiverSocket) {
    console.log("❌ backend_call_id: receiver offline", receiverId);
    return;
  }

  io.to(receiverSocket).emit("backend_call_id", {
    backendCallId,
  });

  console.log(
    "📦 backendCallId relayed to receiver",
    receiverId,
    backendCallId
  );
});


    /* ===============================
   RECEIVER MUTE TRACK (10 sec)
   =============================== */
socket.on("receiver_muted", ({ callId }) => {
  if (!callId) return;

  console.log(
    `🔇 receiver_muted received | callId=${callId} | user=${socket.userId}`
  );

  // safety: agar timer map me call hi nahi hai
  const timers = callTimers.get(callId);
  if (!timers) {
    console.warn("⚠️ No callTimers entry for callId", callId);
    return;
  }

  // agar pehle se koi mute timer chal raha ho, clear karo
  if (timers.muteTimer) {
    clearTimeout(timers.muteTimer);
  }

  // 🔥 10 second ka mute timer
  timers.muteTimer = setTimeout(() => {
    console.error(
      `⛔ Auto disconnect: receiver muted too long | callId=${callId}`
    );

    forceDisconnectCall(io, callId, "receiver_muted_too_long");
  }, 10 * 1000);
});

socket.on("receiver_unmuted", ({ callId }) => {
  const timers = callTimers.get(callId);
  if (timers?.muteTimer) {
    clearTimeout(timers.muteTimer);
    timers.muteTimer = null;
  }

  console.log(`🔊 Receiver unmuted | callId=${callId}`);
});

socket.on("receiver_hold", ({ callId }) => {
  if (!callId) return;

  const timers = callTimers.get(callId);
  if (!timers) return;

  if (timers.holdTimer) clearTimeout(timers.holdTimer);

  timers.holdTimer = setTimeout(() => {
    forceDisconnectCall(io, callId, "receiver_hold_too_long");
  }, 30 * 1000);

  console.log(`⏸️ Receiver on hold | callId=${callId}`);
});


socket.on("receiver_resume", ({ callId }) => {
  const timers = callTimers.get(callId);
  if (timers?.holdTimer) {
    clearTimeout(timers.holdTimer);
    timers.holdTimer = null;
  }

  console.log(`▶️ Receiver resumed | callId=${callId}`);
});
/* ===============================
   HOLD / RESUME RINGTONE (RELAY ONLY)
   =============================== */
socket.on("hold_ringtone", ({ callId, by }) => {
  if (!callId || !by) return;

  const room = `call_${callId}`;
  console.log("📡 hold_ringtone received", { callId, by, from: socket.userId });

  // 🔥 RELAY TO OTHER PEER IN SAME ROOM
  socket.to(room).emit("hold_ringtone", { by });
});

socket.on("resume_ringtone", ({ callId }) => {
  if (!callId) return;

  const room = `call_${callId}`;
  console.log("📡 resume_ringtone received", { callId, from: socket.userId });

  socket.to(room).emit("resume_ringtone");
});
    /* ===============================
       REJECT CALL
       =============================== */
    socket.on("reject_call", ({ callerId }) => {
      busyReceivers.delete(socket.userId);
      console.log(`🟢 Receiver ${socket.userId} freed on reject_call`);
      emitCallAnalytics("call_failed", {
      callId: socket.currentCallId,
      callerId,
      receiverId: socket.userId,
      reason: "receiver_rejected",
      });
      const callerSocket = activeUsers.get(callerId);
      if (callerSocket) {
        io.to(callerSocket).emit("call_rejected", {
          receiverId: socket.userId,
        });
      }
      console.log(`❌ Call rejected by ${socket.userId}`);
      });

    /* ===============================
       MISSED CALL
       =============================== */
    socket.on("missed_call", ({ receiverId }) => {
      busyReceivers.delete(receiverId);
      console.log(`🟢 Receiver ${receiverId} freed on missed_call`);
      emitCallAnalytics("call_failed", {
  callId: socket.currentCallId,
  callerId: socket.userId,
  receiverId,
  reason: "missed_call",
});
      const receiverSocket = activeUsers.get(receiverId);
      if (receiverSocket) {
        io.to(receiverSocket).emit("missed_call", {
          callerId: socket.userId,
        });
      }
      console.log(`⏰ Missed call: ${socket.userId} → ${receiverId}`);
    });

   /* ===============================
   CANCEL CALL (BEFORE ACCEPT)
   =============================== */
socket.on("cancel_call", ({ receiverId, callId }) => {
  console.log("❌ cancel_call received", {
    from: socket.userId,
    to: receiverId,
    callId,
  });

  if (!receiverId) return;

  const receiverSocket = activeUsers.get(receiverId);

  if (receiverSocket) {
    io.to(receiverSocket).emit("call_cancelled", {
      callId,
      fromUserId: socket.userId,
    });

    console.log("📤 call_cancelled emitted to receiver", receiverId);
  }

  // safety cleanup
  busyReceivers.delete(receiverId);
  socket.currentCallId = null;
});
     /* ===============================
       END CALL
       =============================== */
   socket.on("end_call", async ({ receiverId, callId }) => {
  if (!receiverId || !callId) return;

    // 🔥 MUST: clear busy
  if (busyReceivers.has(receiverId)) {
    busyReceivers.delete(receiverId);
    socket.currentCallId = null;
    console.log(`🟢 Receiver ${receiverId} freed on end_call`);
  }
  socket.currentCallId = null;
  // 🧹 CLEAR CALL TIMERS (mute / hold)
if (callId && callTimers.has(callId)) {
  const timers = callTimers.get(callId);
  if (timers?.muteTimer) clearTimeout(timers.muteTimer);
  if (timers?.holdTimer) clearTimeout(timers.holdTimer);
  callTimers.delete(callId);

  console.log(`🧹 Call timers cleared on end_call | callId=${callId}`);
}
  const receiverSocket = activeUsers.get(receiverId);
  if (receiverSocket) {
    io.to(receiverSocket).emit("call_ended", {
      fromUserId: socket.userId,
    });
  }

  // 🔥 AUTH BACKEND KO INFORM KARO
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.split(" ")[1];

  if (token) {
    await notifyCallEnd(callId, token);
  }
emitCallAnalytics("call_ended", {
  callId,
  callerId: socket.userId,
  receiverId,
  reason: "ended_by_user",
});

  console.log(`📴 Call ended, receiver ${receiverId} free`);

  if (callId) {
  socket.leave(`call_${callId}`);
}

});

/* ===============================
   CALLER BLOCKED BY RECEIVER
   (Backend → Caller Dialog Trigger)
   =============================== */
socket.on("caller_blocked_by_receiver", ({ callId, receiverId, message }) => {
  console.log(
    "⛔ caller_blocked_by_receiver received on signaling",
    callId,
    receiverId
  );

  socket.emit("caller_blocked_by_receiver", {
    callId,
    receiverId,
    message,
  });
});
    /* ===============================
       DISCONNECT
       =============================== */
    socket.on("disconnect", async () => {
  if (socket.userId) {
    for (const [receiverId, callerId] of busyReceivers.entries()) {
      if (callerId === socket.userId || receiverId === socket.userId) {
        busyReceivers.delete(receiverId);
        console.log(`🟢 Receiver ${receiverId} freed on disconnect`);
        // 🧹 CLEAR CALL TIMERS ON DISCONNECT
if (socket.currentCallId && callTimers.has(socket.currentCallId)) {
  const timers = callTimers.get(socket.currentCallId);
  if (timers?.muteTimer) clearTimeout(timers.muteTimer);
  if (timers?.holdTimer) clearTimeout(timers.holdTimer);
  callTimers.delete(socket.currentCallId);

  console.log(
    `🧹 Call timers cleared on disconnect | callId=${socket.currentCallId}`
  );
}
        // 🔥 FORCE END CALL IN AUTH BACKEND
        const token =
          socket.handshake.auth?.token ||
          socket.handshake.headers?.authorization?.split(" ")[1];
          emitCallAnalytics("call_ended", {
           callId: socket.currentCallId,
             callerId: socket.userId,
            reason: "socket_disconnect",
           });

        if (token && socket.currentCallId) {
          await notifyCallEnd(socket.currentCallId, token);
        }
        if (token && socket.currentCallId) {
  sendAnalyticsEvent(token, {
    callId: socket.currentCallId,
    callerId: socket.userId,
    eventType: "call_ended",
    eventReason: "socket_disconnect",
    socketId: socket.id,
  });
}
        console.log(`🔓 Receiver ${receiverId} auto-freed`);
      }
    }
    socket.currentCallId = null;
    // final safety cleanup
if (socket.currentCallId && callTimers.has(socket.currentCallId)) {
  callTimers.delete(socket.currentCallId);
}
    busyReceivers.delete(socket.userId);

   const currentSocketId = activeUsers.get(socket.userId);
if (currentSocketId === socket.id) {
  activeUsers.delete(socket.userId);
  console.log("🔴 activeUsers removed:", socket.userId);
}
   
  }

  socketRateMap.delete(socket.id);
  abuseCount.delete(socket.userId);
  tempBlockedUsers.delete(socket.userId);
});

  });
}


// ===============================
// AUTO CLEANUP (every 30 seconds)
// ===============================
setInterval(() => {
  const now = Date.now();
  const TIMEOUT = 30 * 1000; // 30 sec

  for (const [userId, ts] of lastSeen.entries()) {
    if (now - ts > TIMEOUT) {
      // user considered dead
      lastSeen.delete(userId);
      activeUsers.delete(userId);

      // free receiver if busy
      for (const [receiverId, callerId] of busyReceivers.entries()) {
        if (callerId === userId || receiverId === userId) {
          busyReceivers.delete(receiverId);
          console.log(`🧹 Auto freed receiver ${receiverId}`);
        }
      }

      console.log(`💀 Cleaned dead user ${userId}`);
    }
  }
}, 30 * 1000);