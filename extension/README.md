# CodeShelf (Chrome extension, MV3)

Saves your **Accepted** LeetCode submissions in the extension and backs them up to your CodeShelf account.

## How it works

| File | World | Job |
|---|---|---|
| `injected.js` | page (`MAIN`), `document_start` | Wraps `fetch`/XHR and passively reads copies of `POST /problems/<slug>/submit/` (body has `typed_code`, `lang`, `question_id`; response has `submission_id`), `GET /submissions/detail/<id>/v2/check/` (final poll has `state: "SUCCESS"`, `status_code: 10` = Accepted, `status_runtime`, `status_memory`), and the page's own `submissionDetails` GraphQL response (XHR, read as a Blob). Sends no requests of its own. |
| `content.js` | isolated | Validates what `injected.js` posts, forwards it to the service worker, and shows the **Save to CodeShelf** button in the Accepted panel. |
| `background.js` | service worker | Skips duplicates by submission ID and SHA-256 code hash, stores the full solution in extension storage, then syncs it to Supabase. Failed syncs are retried. |
| `popup.html` / `popup.js` | toolbar popup | Sign in / create account, and lists saved solutions with search, copy, "Open on LeetCode" and **Export JSON**. |

## Load it

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Open any problem on `https://leetcode.com/problems/...` (reload tabs that were already open).

## Accounts and cloud backup

CodeShelf uses one shared Supabase project. Its URL and publishable key are in `CONFIG` at the top of `background.js` (the publishable key is meant to ship in client apps; never put the secret / `service_role` key there).

**For users:** click the CodeShelf toolbar icon → **Sign in** → **Continue with Google**, or enter an email and a password (8+ characters) → **Create account** (or **Sign in** next time). Signing in on another device restores the account's solutions there. Solutions saved before signing in are backed up then. Without an account everything still works, but solutions stay on that browser only. **Delete my cloud data** removes all of the user's rows and signs them out; local copies are kept.

**For the project owner (one-time):**

1. **SQL Editor:** run [`../supabase/schema.sql`](../supabase/schema.sql), then [`../supabase/multi-user.sql`](../supabase/multi-user.sql). Row Level Security means each user can only read, add and delete their own rows.
2. **Authentication → Sign In / Providers:** turn **Allow new users to sign up** on.
3. **Confirm email:** while it's off, accounts work immediately and no emails are sent. Turning it on is recommended for a public release, but Supabase's built-in mailer only sends a few emails per hour, so configure custom SMTP first (**Authentication → Emails → SMTP**, e.g. Resend or Postmark). With it on, new users see "Check your email to confirm it, then sign in."
4. **Google sign-in** (optional):
   - Google Cloud Console → **APIs & Services → OAuth consent screen**: External, app name, support email; default scopes (`openid`, `email`, `profile`). Publish the app, or add test users while it's in Testing.
   - **Credentials → Create credentials → OAuth client ID → Web application**, with the authorized redirect URI `https://<project>.supabase.co/auth/v1/callback`.
   - Supabase **Authentication → Sign In / Providers → Google**: enable it and paste the client ID and secret.
   - Supabase **Authentication → URL Configuration → Redirect URLs**: add `https://oifaefjfbanaojlggppjpiohhfeifidg.chromiumapp.org/**`.
   The extension ID is pinned by the `key` in `manifest.json`, so this redirect URL is the same for every install. The matching private key is in `../keys/` (git-ignored) and is only needed to package a `.crx`.
5. Before publishing, write a privacy policy (the Chrome Web Store requires one): what's stored (solution code, problem metadata, email), where (Supabase), and how to delete it.

The extension keeps only the Supabase session (access and refresh tokens), never the password.

## Test it

1. Submit a solution that gets **Accepted**.
2. A green **Saved & backed up** button appears in the result panel (or **Saved on this browser** when signed out), next to LeetCode's own buttons.
3. When signed in, the popup shows it as **backed up**, and Supabase's **Table Editor → solutions** shows the row.
4. Submit the same code again. The button should say **Same code already saved**, and nothing new is stored.

On every LeetCode page load the console should show `[CodeShelf] Watching submissions on this page`. If it doesn't, the extension isn't loaded into that tab: reload the extension, then the tab.

If it loads but nothing happens after Accepted, run `localStorage.setItem('codeshelf:debug', '1')` in the LeetCode tab's console, reload, and submit again. Lines starting with `[CodeShelf debug]` show every submit, check and GraphQL submission request the page makes. Turn it off with `localStorage.removeItem('codeshelf:debug')`. Clicking a grey **CodeShelf: not captured** button copies a diagnostic report.

## The button

| Label | Meaning | Click |
|---|---|---|
| Saved & backed up | Saved locally and in your CodeShelf account | – |
| Saved on this browser | Saved locally only (not signed in, or it belongs to another account on this browser) | – |
| Same code already saved | Identical code for this problem and language was saved before, so this submission is skipped | – |
| Save to CodeShelf | An older Accepted submission you're viewing, not saved yet | Save it |
| Saved locally · sync pending | Supabase sync failed; it's retried automatically | Retry now |
| CodeShelf: not captured | The extension is running but saw no data for this submission | Copy diagnostics |

The button's position depends on LeetCode's result-panel markup (`data-e2e-locator="submission-result"`). If that changes, the button floats bottom-right for a few seconds after each save instead. Saving itself doesn't depend on the markup.

## Where solutions are kept

- **In the extension:** every saved solution is stored in the extension's own `chrome.storage.local`, under `solution:<submissionId>`. That storage belongs to the extension, not to leetcode.com, so clearing LeetCode's localStorage, cookies or site data doesn't touch it. Click the toolbar icon to browse, or use **Export JSON** for a backup.
- **In the cloud:** the `public.solutions` table, one row per submission per user (primary key `user_id, submission_id`). Re-sending a submission is ignored, so retrying or signing in again never creates duplicates. Failed backups are retried on the next save, on **Sync now**, and when Chrome starts.
- **Several accounts on one browser:** each local solution remembers the account that backed it up and is never uploaded to a different account. Solutions saved while signed out go to the first account that signs in.

`chrome.storage.local.clear()` in the service worker console deletes the local library, so export first.

## Configure

`CONFIG` at the top of `background.js`:

- `SKIP_IDENTICAL_CODE`: skip new submissions whose code is identical to one already saved (ignoring line-ending and trailing-whitespace differences). Set to `false` to keep every Accepted submission. While `true`, reloading the extension also removes identical local copies, keeping the earliest; `supabase/cleanup-duplicates.sql` does the same in Supabase.
- `UPLOAD_BATCH_SIZE`: rows per request when syncing a backlog.

- `SUPABASE_URL` / `SUPABASE_KEY`: the shared project. `host_permissions` in `manifest.json` must match `SUPABASE_URL`.
- `MAX_CODE_LENGTH`: solutions longer than this stay local only (the database rejects them).

## Switching backends later

Everything Supabase-specific is in the "account" and "Supabase" sections of `background.js` plus `supabase/*.sql`. Capture, de-duplication, the local library, the button and the popup don't depend on it.
