# Bank Frontend

Standalone bank verification portal — a single static HTML file with vanilla JavaScript. No npm, no build step, no React.

## Why vanilla JS?

The main `frontend/` uses Create React App, which has a transitive dependency conflict (`fork-ts-checker-webpack-plugin` → `ajv-keywords`) that cannot be fixed via npm overrides. Rather than maintain a second CRA project with the same conflict, the bank portal is a self-contained HTML file served by a plain Nginx container.

## File structure

```
bank-frontend/
├── public/
│   └── index.html    # entire bank portal — HTML + CSS + JS in one file
└── Dockerfile        # nginx image; sed substitutes __API_URL__ at build time
```

## What it does

Step-by-step verification flow:

1. **Login** — `POST /api/auth/login` with `bank` role credentials; stores JWT
2. **Start Verification** — `POST /api/bank/invitation` → renders QR code (QRCode.js loaded inline via data URI)
3. **Scan QR** — user scans with BC Wallet; portal polls `GET /api/bank/connection/:oobId` until connected
4. **Send Proof Request** — `POST /api/bank/proof-request` with `age ≥ 18` AnonCreds predicate
5. **Poll Result** — `GET /api/bank/proof-result/:presExId` until done; displays **"Identity Verified"** or **"Verification Failed"**

No PII is shown — only the ZKP predicate result (age ≥ 18 confirmed or denied).

## Configuration

The API URL is injected at Docker build time:

```bash
# Dockerfile uses sed to replace __API_URL__ in the HTML
docker compose build \
  --build-arg REACT_APP_API_URL=https://your-domain.example.com \
  bank-frontend
```

In development, the HTML file references `http://localhost:3000` by default. Edit the `BASE_URL` constant at the top of `index.html` directly.

## Ports

| Context | Port |
|---------|------|
| Docker container (internal) | 3002 |
| Nginx host binding | 4000 (via docker-compose `ports`) |
| Nginx SSL proxy (production) | 443 on a separate subdomain, or `https://domain:4000` |

## Development

Open `bank-frontend/public/index.html` directly in a browser, or serve it with any static file server:

```bash
# Python (no install needed)
python3 -m http.server 4000 --directory bank-frontend/public

# Then open http://localhost:4000
```

Make sure the backend is running and CORS allows `http://localhost:4000`.

## Docker

```bash
docker compose build bank-frontend
docker compose up -d --force-recreate bank-frontend
docker compose logs -f bank-frontend
```
