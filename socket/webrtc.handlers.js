export default function registerWebRTCHandlers(io, socket) {

  // Offer (Caller -> Receiver)
  socket.on("webrtc:offer", ({ callId, sdp }) => {
    if (!callId || !sdp) return;
    const room = `call_${callId}`;
    socket.to(room).emit("webrtc:offer", {
      callId,
      sdp,
      from: socket.id,
    });
  });

  // Answer (Receiver -> Caller)
  socket.on("webrtc:answer", ({ callId, sdp }) => {
    if (!callId || !sdp) return;
    const room = `call_${callId}`;
    socket.to(room).emit("webrtc:answer", {
      callId,
      sdp,
      from: socket.id,
    });
  });

  // ICE Candidates (Both)
  socket.on("webrtc:ice", ({ callId, candidate }) => {
    if (!callId || !candidate) return;
    const room = `call_${callId}`;
    socket.to(room).emit("webrtc:ice", {
      callId,
      candidate,
      from: socket.id,
    });
  });
}
