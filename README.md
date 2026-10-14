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

## Safe sending (throttle, daily cap, replies)

- Pressing Send queues a step. Nothing sends in a long request loop.
- Each connected Gmail account has `users.next_send_at`. Every send first claims that slot with one atomic `UPDATE ... WHERE next_send_at IS NULL OR next_send_at <= now()`, and moves it 30 to 40 seconds ahead (Settings: gap and jitter). Overlapping ticks cannot double send.
- Daily cap (default 200) counts `campaign_recipients.sent_at` since midnight Africa/Nairobi for that sender. Over the cap, emails stay queued and resume after midnight.
- Ticks come from: the open app (`POST /sending/tick` every 10 s, sends only what is due), `GET /cron/send-tick` (Bearer `CRON_SECRET`, keeps sending for up to about 50 s), a daily Vercel Cron, and an optional GitHub Actions schedule (copy `docs/send-tick.workflow.yml` to `.github/workflows/`). On Vercel Pro you can change the cron in `vercel.json` to `* * * * *`.
- Gmail rate limit, policy, suspension or auth errors pause the sender. A campaign with more than 5% hard bounces after 20 sends pauses itself. Both show a banner with Resume.
- Inbox sync classifies replies: human replies stop follow-ups, opt outs mark the contact do not contact, auto replies are only counted.
- Tests: `npm test`. The scheduler integration test runs only with `TEST_DATABASE_URL` pointing at a throwaway database.
