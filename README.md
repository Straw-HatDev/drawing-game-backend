# Live Drawing Game — Backend (Render / Node.js)

Authoritative Node.js + Express + Socket.IO game server for the 3D real-time multiplayer drawing and guessing game.

## Local Setup

```bash
npm install
npm start
```

The server listens on `http://localhost:3000` by default (`process.env.PORT || 3000`).

## Environment Variables (Render)

- `PORT`: Automatically provided by Render.
- `CORS_ORIGIN`: Optional comma-separated allowed frontend origins (e.g., `https://your-username.github.io`). Defaults to `*`.
