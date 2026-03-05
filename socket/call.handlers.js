export default function registerCallHandlers(io, socket) {

  // Join a call room
  socket.on("call:join", ({ callId, role }) => {
    if (!callId || !role) return;

    const room = `call_${callId}`;
    socket.join(room);
    socket.data.joinedCalls.add(room);

    // notify peer
    socket.to(room).emit("call:peer_joined", {
      callId,
      role,
      socketId: socket.id,
    });
  });

  // Leave / End call
  socket.on("call:end", ({ callId }) => {
    if (!callId) return;

    const room = `call_${callId}`;
    socket.to(room).emit("call:ended", { callId });
    socket.leave(room);
    socket.data.joinedCalls.delete(room);
  });
}
