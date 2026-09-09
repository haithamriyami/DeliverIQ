# DeliverIQ

Smart global campaigns, clean lists, guaranteed delivery.

## Setup

```bash
docker compose up -d
npm install
npx prisma migrate deploy
npm run db:seed
npm run dev
npm run dev:worker
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Log in, then invite a partner from **Settings**.

## Send with Gmail (no domain, free)

You do **not** need a custom domain. Connect Gmail and campaigns send as that Google address (about 500/day on a personal Gmail).

1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project → **APIs & Services** → enable **Gmail API**
3. **OAuth consent screen**: External, app name DeliverIQ, add your Gmail as a **test user**
4. **Credentials** → Create OAuth client ID → **Web application**
5. Authorized redirect URI (must match exactly):

```
http://127.0.0.1:3000/auth/google/callback
```

6. Put these in `.env`:

```
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=....
GOOGLE_REDIRECT_URI=http://127.0.0.1:3000/auth/google/callback
```

7. Restart the API, log in as owner, open **Settings → Connect Gmail**

If you later host for free (Render/Railway), add that URL as a second redirect URI, e.g. `https://your-app.onrender.com/auth/google/callback`. Still no custom domain.

## SendGrid (optional)

Only needed if you later buy a domain and want higher volume. Until Gmail is connected or SendGrid is live, jobs are logged locally.

## What is included

- Login, workspace, and partner invites
- CSV import and recipient notes
- Gmail OAuth sending without a domain
- Template picker, send, and test send
- Bounce handling and unsubscribe links
- Live dashboard from Postgres
