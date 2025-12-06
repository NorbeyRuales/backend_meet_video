# eisc-video

Servidor de senalizacion WebSocket (Socket.IO) para video y compartir pantalla. Mantiene el estado en memoria por sala y expone un healthcheck simple.

## Requisitos
- Node 18+
- Variables en `.env` (ver `.env.example`)

## Configuracion
1. Copia `.env.example` a `.env` y ajusta:
   - `PORT`: puerto del servidor (9000 por defecto).
   - `ORIGIN`: lista de origenes permitidos separados por coma (URLs del frontend).
   - `MAX_ROOM_SIZE`: limite de usuarios por sala (default 10).
   - `AUTH_SECRET`: opcional, valida token (JWT HS256) en el handshake y usa sus datos de usuario.
   - `REDIS_URL`: opcional, activa adapter Redis para varias instancias de Socket.IO.
2. Instala dependencias: `npm install`

## Ejecucion
- Desarrollo (watch TS): `npm run dev`
- Produccion: `npm run build && npm start`
- Healthcheck: `GET /health` -> `{ "status": "ok" }`

## Eventos Socket.IO
- `join:room(roomId, userId, displayName, photoURL?)`: une a una sala; responde `room:joined` (roomId, existingUsers) y `media:states`; notifica a otros con `user:joined`.
- `signal { to, from, signal, roomId }`: reenvia senal WebRTC entre pares.
- `media:state { roomId, audioEnabled?, videoEnabled? }`: publica estado A/V a la sala -> `media:state`.
- Pantalla:
  - `screen:share { roomId, sharing }`: notifica screen share -> `screen:share`.
  - Legacy: `screen:share-start`, `screen:share-stop`, `screen:signal`.
- Chat en sala: `chat:message { roomId, userId, message }` -> rebote a la sala con timestamp.
- Salida: `leave:room(roomId)` o desconexion -> `user:left`.

## Notas
- El estado (usuarios y flags de media) vive en memoria y se pierde al reiniciar. Si defines `REDIS_URL`, se usara el adapter de pub/sub para multiinstancia.
- Con `AUTH_SECRET`, el servidor exige token en el handshake (`socket.handshake.auth.token` o header `Authorization`) y toma `userId/displayName` del payload; sin `AUTH_SECRET` usa lo que envia el cliente en `join:room`.
# backend_meet_video
