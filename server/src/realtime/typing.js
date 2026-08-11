const TYPING_TTL_MS = 6000;

/** userId -> { roomKey -> timeout } so we never leak stale "is typing" state. */
const timers = new Map();

function roomFor(payload) {
  if (payload?.channelId) return `channel:${payload.channelId}`;
  if (payload?.conversationId) return `conversation:${payload.conversationId}`;
  return null;
}

export function registerTypingHandlers(socket) {
  const { userId } = socket.data;

  socket.on('typing:start', (payload) => {
    const room = roomFor(payload);
    // A socket only receives events for rooms it has joined, so membership is
    // already enforced — refuse anything else.
    if (!room || !socket.rooms.has(room)) return;

    socket.to(room).emit('typing:start', {
      userId,
      channelId: payload.channelId ?? null,
      conversationId: payload.conversationId ?? null,
    });

    if (!timers.has(userId)) timers.set(userId, new Map());
    const userTimers = timers.get(userId);
    clearTimeout(userTimers.get(room));
    userTimers.set(
      room,
      setTimeout(() => {
        socket.to(room).emit('typing:stop', {
          userId,
          channelId: payload.channelId ?? null,
          conversationId: payload.conversationId ?? null,
        });
        userTimers.delete(room);
      }, TYPING_TTL_MS),
    );
  });

  socket.on('typing:stop', (payload) => {
    const room = roomFor(payload);
    if (!room || !socket.rooms.has(room)) return;
    const userTimers = timers.get(userId);
    if (userTimers) {
      clearTimeout(userTimers.get(room));
      userTimers.delete(room);
    }
    socket.to(room).emit('typing:stop', {
      userId,
      channelId: payload.channelId ?? null,
      conversationId: payload.conversationId ?? null,
    });
  });

  socket.on('disconnect', () => {
    const userTimers = timers.get(userId);
    if (!userTimers) return;
    for (const timer of userTimers.values()) clearTimeout(timer);
    timers.delete(userId);
  });
}
