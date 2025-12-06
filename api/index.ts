import http from "http";
import express from "express";
import cors from "cors";
import { Server, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import jwt from "jsonwebtoken";
import "dotenv/config";

const origins =
  process.env.ORIGIN
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) || [
    "http://localhost:5173",
    "https://plataforma-de-video-conferencias.vercel.app",
  ];

const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE ?? 10);
const PORT = Number(process.env.PORT ?? 9000);
const AUTH_SECRET = process.env.AUTH_SECRET;
const REDIS_URL = process.env.REDIS_URL;

const app = express();
app.use(
  cors({
    origin: origins,
    methods: ["GET", "POST"],
  })
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use((_req, res) => {
  res.status(404).json({ message: "Not found" });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: origins,
    methods: ["GET", "POST"],
  },
});

if (REDIS_URL) {
  const pubClient = new Redis(REDIS_URL);
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));

  pubClient.on("error", (err) => console.error("Redis pub client error", err));
  subClient.on("error", (err) => console.error("Redis sub client error", err));
}

type RoomUser = {
  socketId: string;
  userId: string;
  displayName: string;
  photoURL?: string;
};

type MediaState = {
  audioEnabled: boolean;
  videoEnabled: boolean;
  isScreenSharing?: boolean;
};

const rooms: Record<string, Record<string, RoomUser>> = {};
const mediaStates: Record<string, Record<string, MediaState>> = {};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

type AuthedUser = {
  userId: string;
  displayName: string;
  photoURL?: string;
};

const bearerToken = (raw: unknown): string => {
  if (Array.isArray(raw)) {
    raw = raw[0];
  }
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
};

const resolveUser = (
  socket: Socket,
  provided: AuthedUser
): AuthedUser | null => {
  if (!AUTH_SECRET) {
    return provided;
  }

  const token =
    bearerToken(socket.handshake.auth?.token) ||
    bearerToken(socket.handshake.headers.authorization);

  if (!isNonEmptyString(token)) {
    socket.emit("auth:error", "Missing auth token");
    return null;
  }

  try {
    const payload = jwt.verify(token, AUTH_SECRET) as jwt.JwtPayload | string;
    if (typeof payload === "string") {
      return {
        userId: payload,
        displayName: provided.displayName,
        photoURL: provided.photoURL,
      };
    }
    const userId =
      payload.uid || payload.sub || payload.userId || payload.user_id || provided.userId;
    const displayName =
      payload.name ||
      payload.displayName ||
      payload.username ||
      payload.email ||
      provided.displayName;
    const photoURL = (payload as Record<string, unknown>).picture as string | undefined;

    if (!isNonEmptyString(userId) || !isNonEmptyString(displayName)) {
      socket.emit("auth:error", "Invalid token payload");
      return null;
    }

    return {
      userId,
      displayName,
      photoURL: photoURL ?? provided.photoURL,
    };
  } catch (error) {
    console.error("Auth token verification failed:", error);
    socket.emit("auth:error", "Invalid auth token");
    return null;
  }
};

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on(
    "join:room",
    (roomId: string, userId: string, displayName: string, photoURL?: string) => {
      if (!isNonEmptyString(roomId) || !isNonEmptyString(userId) || !isNonEmptyString(displayName)) {
        socket.emit("room:error", "Missing roomId, userId or displayName");
        return;
      }

      const resolvedUser = resolveUser(socket, { userId, displayName, photoURL });
      if (!resolvedUser) {
        return;
      }

      const currentCount = rooms[roomId] ? Object.keys(rooms[roomId]).length : 0;
      if (currentCount >= MAX_ROOM_SIZE) {
        socket.emit("room:full");
        return;
      }

      socket.join(roomId);

      if (!rooms[roomId]) {
        rooms[roomId] = {};
      }
      if (!mediaStates[roomId]) {
        mediaStates[roomId] = {};
      }

      rooms[roomId][socket.id] = {
        socketId: socket.id,
        userId: resolvedUser.userId,
        displayName: resolvedUser.displayName,
        photoURL: resolvedUser.photoURL,
      };
      mediaStates[roomId][socket.id] = {
        audioEnabled: true,
        videoEnabled: true,
        isScreenSharing: false,
      };

      const existingUsers = Object.entries(rooms[roomId])
        .filter(([id]) => id !== socket.id)
        .map(([id, info]) => ({
          socketId: id,
          userId: info.userId,
          displayName: info.displayName,
          photoURL: info.photoURL,
        }));

      socket.emit("room:joined", { roomId, existingUsers });
      socket.emit("media:states", mediaStates[roomId]);

      socket
        .to(roomId)
        .emit("user:joined", {
          socketId: socket.id,
          userId: resolvedUser.userId,
          displayName: resolvedUser.displayName,
          photoURL: resolvedUser.photoURL,
        });

      console.log(`User ${socket.id} joined room ${roomId}. Total users: ${Object.keys(rooms[roomId]).length}`);
    }
  );

  socket.on("signal", (data: { to: string; from: string; signal: unknown; roomId: string }) => {
    const { to, from, signal, roomId } = data;
    if (!signal || !isNonEmptyString(to) || !isNonEmptyString(from) || !isNonEmptyString(roomId)) return;
    const senderInfo = rooms[roomId]?.[from];

    io.to(to).emit("signal", {
      from,
      signal,
      displayName: senderInfo?.displayName,
      userId: senderInfo?.userId,
      photoURL: senderInfo?.photoURL,
      roomId,
    });
  });

  socket.on("media:state", (data: { roomId: string; audioEnabled?: boolean; videoEnabled?: boolean }) => {
    const { roomId, audioEnabled, videoEnabled } = data;
    if (!isNonEmptyString(roomId)) return;
    if (!mediaStates[roomId]) {
      mediaStates[roomId] = {};
    }
    const current = mediaStates[roomId][socket.id] || {
      audioEnabled: true,
      videoEnabled: true,
      isScreenSharing: false,
    };
    mediaStates[roomId][socket.id] = {
      audioEnabled: audioEnabled ?? current.audioEnabled,
      videoEnabled: videoEnabled ?? current.videoEnabled,
      isScreenSharing: current.isScreenSharing ?? false,
    };

    socket.to(roomId).emit("media:state", {
      socketId: socket.id,
      audioEnabled: mediaStates[roomId][socket.id].audioEnabled,
      videoEnabled: mediaStates[roomId][socket.id].videoEnabled,
    });
  });

  socket.on("screen:share", ({ roomId, sharing }: { roomId: string; sharing: boolean }) => {
    if (!isNonEmptyString(roomId)) return;

    if (mediaStates[roomId]?.[socket.id]) {
      mediaStates[roomId][socket.id].isScreenSharing = sharing;
    }

    const senderInfo = rooms[roomId]?.[socket.id];

    socket.to(roomId).emit("screen:share", {
      socketId: socket.id,
      sharing,
      displayName: senderInfo?.displayName,
      photoURL: senderInfo?.photoURL,
    });
  });

  // Legacy screen-share events kept for compatibility (safe to remove when clients migrate to screen:share)
  socket.on("screen:share-start", ({ roomId }) => {
    if (!isNonEmptyString(roomId)) return;

    if (mediaStates[roomId]?.[socket.id]) {
      mediaStates[roomId][socket.id].isScreenSharing = true;
    }

    const senderInfo = rooms[roomId]?.[socket.id];

    socket.to(roomId).emit("peer:screen-share-start", {
      socketId: socket.id,
      displayName: senderInfo?.displayName,
      photoURL: senderInfo?.photoURL,
    });
  });

  socket.on("screen:share-stop", ({ roomId }) => {
    if (!isNonEmptyString(roomId)) return;

    if (mediaStates[roomId]?.[socket.id]) {
      mediaStates[roomId][socket.id].isScreenSharing = false;
    }

    socket.to(roomId).emit("peer:screen-share-stop", {
      socketId: socket.id,
    });
  });

  socket.on("screen:signal", ({ to, from, signal, roomId }) => {
    if (!isNonEmptyString(roomId) || !isNonEmptyString(to) || !isNonEmptyString(from) || !signal) return;

    io.to(to).emit("screen:signal", {
      from,
      signal,
    });
  });

  socket.on("leave:room", (roomId: string) => {
    if (!isNonEmptyString(roomId)) return;
    if (rooms[roomId]?.[socket.id]) {
      delete rooms[roomId][socket.id];
      delete mediaStates[roomId]?.[socket.id];
      socket.to(roomId).emit("user:left", socket.id);
      socket.leave(roomId);

      if (Object.keys(rooms[roomId]).length === 0) {
        delete rooms[roomId];
        delete mediaStates[roomId];
      }

      console.log(`User ${socket.id} left room ${roomId}`);
    }
  });

  socket.on("chat:message", (data: { roomId: string; userId: string; message: string }) => {
    const { roomId, userId, message } = data;
    if (!isNonEmptyString(roomId) || !isNonEmptyString(userId) || !isNonEmptyString(message)) return;

    const outgoingMessage = {
      userId,
      message: message.trim(),
      timestamp: new Date().toISOString(),
    };

    io.to(roomId).emit("chat:message", outgoingMessage);
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      if (rooms[roomId][socket.id]) {
        delete rooms[roomId][socket.id];
        delete mediaStates[roomId]?.[socket.id];
        socket.to(roomId).emit("user:left", socket.id);

        if (Object.keys(rooms[roomId]).length === 0) {
          delete rooms[roomId];
          delete mediaStates[roomId];
        }
      }
    }

    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Video signaling server running on port ${PORT}`);
});
