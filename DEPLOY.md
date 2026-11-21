# Deploying the backend (Render)

Build: `npm ci --include=dev && npm run build`   Start: `npm start`   Health check path: `/health`
Root directory: `backend` (if the repo holds both `backend` and `app`). Node 22.

## Environment variables
| Name | Value |
|---|---|
| NODE_ENV | production |
| MONGODB_URI | your Atlas string (rotate the password first) |
| JWT_ACCESS_SECRET | long random string: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| SMTP_USER / SMTP_PASS | Gmail address + App Password |
| ENABLE_JOBS | true (on ONE instance only) |
| INVITE_LINK_BASE | https://basera.app/i (placeholder until you own a domain) |
| CLOUDINARY_* | when you have them |

Atlas: Network Access → allow 0.0.0.0/0 (Render has no fixed IP on the free/starter tiers).
App: set `EXPO_PUBLIC_API_URL=https://<your-service>.onrender.com` in `app/.env`, restart Expo.
First deploy: run `npm run db:migrate -- --yes` once from your PC (same MONGODB_URI) only if the DB has old phone-login data.
