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

## SendGrid (optional second sender)

SendGrid can send next to Gmail. It is off until a workspace owner switches it on in **Settings → SendGrid (second sender)**.

- Server env: `SENDGRID_API_KEY` (Mail Send access, never stored in the database or shown in the app), optional `SENDGRID_FROM_EMAIL` and `SENDGRID_FROM_NAME` as defaults for the From address and name, and `SENDGRID_WEBHOOK_VERIFICATION_KEY` for the signed Event Webhook. `SENDGRID_DRY_RUN` is no longer used for sending.
- The From address must be on a domain authenticated in SendGrid. Set a Reply-To you read (for example your Gmail), because the domain may not receive mail.
- When on, Gmail and SendGrid work through the same queue at the same time, each with its own gap slot and rolling 24 hour cap (SendGrid default 100, the free plan limit). A short claim per contact makes sure two senders never email the same person. Each send row records its sender in `campaign_recipients.sender_account_id`; SendGrid uses one shared `gmail_accounts` row with email `sendgrid` for its gap, count and holds.
- Follow ups thread only when they go out from the same Gmail as the earlier step. A follow up from SendGrid, or after a SendGrid email, goes out as a new email.
- Event Webhook: in SendGrid, Settings → Mail Settings → Event Webhook, set the URL to `https://<your app>/webhooks/sendgrid` and select Bounced, Dropped, Spam Reports, Unsubscribe and Group Unsubscribe. Turn on Signed Event Webhook and put its verification key in `SENDGRID_WEBHOOK_VERIFICATION_KEY`. Without the key, an event is only accepted when it carries the SendGrid message id of a send DeliverIQ recorded.

## What is included

- Login, workspace, and partner invites
- CSV import and recipient notes
- Gmail OAuth sending without a domain
- Template picker, send, and test send
- Bounce handling and unsubscribe links
- Live dashboard from Postgres

## Safe sending (throttle, daily cap, replies)

- Pressing Send queues the step, sends the first email at once if the account's slot is free, and starts a background run on the server (`waitUntil`), so sending keeps going after the tab is closed or minimized.
- Each connected Gmail account has `users.next_send_at`. Every send first claims that slot with one atomic `UPDATE ... WHERE next_send_at IS NULL OR next_send_at <= now()` and moves it forward by the gap plus random jitter (Settings, default 10 s + up to 5 s, minimum 5 s). Overlapping runs can never double send or break the gap.
- A background run keeps sending until about 25 s before the function deadline (`maxDuration` 300 s in `vercel.json`, the Hobby maximum with Fluid compute, read at runtime with `getDeadline()`). If it sent something and work is left, it starts the next run by calling `/cron/send-tick` on itself. A lease row (`scheduler_leases`) keeps it to one run at a time.
- Triggers (any of them is enough, extra ones are harmless): the Send button, the open app (every 10 s), the self chain, `.github/workflows/send-tick.yml` (every 5 min), the daily Vercel Cron, and optionally an every minute external pinger such as cron-job.org calling `GET https://deliveriq-eosin.vercel.app/cron/send-tick` with header `Authorization: Bearer <CRON_SECRET>`.
- Daily cap (default 200) counts `campaign_recipients.sent_at` since midnight Africa/Nairobi for that sender. Over the cap, emails stay queued and continue after midnight (next cron or pinger call).
- Throughput at defaults is about 250 emails per hour per account (about 23 minutes for 100). The app shows an estimated finish time.
- Gmail rate limit, policy, suspension or auth errors pause the sender. A campaign with more than 5% hard bounces after 20 sends pauses itself. Settings has Pause all sending. Every email gets a last-second check (deleted, stopped, paused, opted out, replied, kill switch).
- Inbox sync classifies replies: human replies stop follow-ups, opt outs mark the contact do not contact, auto replies are only counted.
- Env: `CRON_SECRET` (required for the cron endpoint and self chain), `SEND_RUN_SECONDS` (default 270), `SEND_SELF_CHAIN=false` to turn chaining off.
- Tests: `npm test`. Database tests run only with `TEST_DATABASE_URL` pointing at a throwaway database.
