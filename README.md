# Ad Preview Capture

A monorepo tool for loading AdUnit / Craftsman+ interactive URLs, interacting with them headlessly, and recording the result to a `.MOV` file.

## Stack

| Layer    | Technology                                      |
|----------|-------------------------------------------------|
| Backend  | Node.js · Express · TypeScript · Puppeteer · fluent-ffmpeg |
| Frontend | React 18 · Vite · TypeScript · Tailwind CSS     |
| Tooling  | npm workspaces · concurrently · ts-node-dev     |

## Project Structure

```
ad-preview-capture/
├── package.json                 # Root – workspace + concurrently scripts
├── packages/
│   ├── backend/
│   │   ├── src/
│   │   │   └── server.ts        # Express API + Puppeteer + ffmpeg recording logic
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── frontend/
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx          # Full capture UI with recording history
│       │   ├── api.ts           # Typed fetch wrappers
│       │   └── types.ts
│       ├── index.html
│       ├── vite.config.ts       # Dev proxy → backend :5000
│       ├── tailwind.config.js
│       └── package.json
```

## Prerequisites

- **Node.js** ≥ 20
- **ffmpeg** installed and on `$PATH` (required by fluent-ffmpeg for `.MOV` encoding)
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt install ffmpeg`

## Getting Started

```bash
# 1. Install all workspace dependencies from the repo root
npm install

# 2. Run backend + frontend concurrently
npm run dev
```

- **Frontend** → [http://localhost:5173](http://localhost:5173)
- **Backend API** → [http://localhost:5000](http://localhost:5000)
- **Health check** → [http://localhost:5000/health](http://localhost:5000/health)

## API Reference

### `POST /api/capture`

Launches a headless Chromium instance, navigates to the given URL, captures frames, and encodes them to a `.MOV` file.

**Request body**

```json
{
  "url": "https://your-adunit-url.com",
  "duration": 10,
  "width": 1280,
  "height": 720
}
```

**Response**

```json
{
  "jobId": "uuid-v4",
  "filename": "uuid-v4.mov",
  "downloadUrl": "/recordings/uuid-v4.mov"
}
```

### `GET /api/recordings`

Returns a list of previously captured `.MOV` files sorted newest-first.

### `GET /recordings/:filename`

Static file download for a recorded `.MOV`.

## Building for Production

```bash
npm run build
```

Backend output lands in `packages/backend/dist/`; frontend output in `packages/frontend/dist/`.
