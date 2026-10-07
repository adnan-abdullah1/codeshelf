# Chrome Web Store submission – CodeShelf 1.0.0

Copy each section into the matching field of the Chrome Web Store Developer Dashboard.
Upload: `dist/codeshelf-1.0.0.zip` (build it with `./scripts/package.sh`).

## Store listing

**Name:** CodeShelf

**Summary** (max 132 characters):
> Automatically saves your Accepted LeetCode solutions and backs them up to your account. Browse, search and export them anytime.

**Category:** Developer Tools  **Language:** English

**Description:**

> CodeShelf keeps every solution you get Accepted on LeetCode, so you never lose a working answer again.
>
> HOW IT WORKS
> • Submit a solution on leetcode.com as usual. When it's Accepted, CodeShelf saves the exact code you submitted, with the problem, language, runtime and memory.
> • A "Saved & backed up" badge appears next to LeetCode's result, so you know it worked.
> • Identical resubmissions are skipped, so your shelf stays clean.
>
> YOUR LIBRARY
> • Click the toolbar icon to browse, search and copy your saved solutions.
> • Export everything as JSON at any time.
>
> BACKUP AND SYNC (OPTIONAL)
> • Sign in with Google or email to back up your solutions and get them on any computer.
> • Without an account, everything stays on your device.
>
> PRIVACY
> • CodeShelf only reads your own submissions on leetcode.com. It sends no extra requests to LeetCode and has no ads or tracking.
> • Delete your cloud data from the popup whenever you like.
>
> CodeShelf is an independent project and is not affiliated with LeetCode.

**Graphics:**
- Store icon 128×128: `extension/icons/icon128.png`
- Screenshots (1280×800, at least 1): take them on real LeetCode pages – e.g. the Accepted panel with the "Saved & backed up" button, and the popup listing your solutions.
- Small promo tile 440×280: optional.

## Privacy practices tab

**Single purpose:**
> Save the user's own Accepted LeetCode solutions to a personal library, with optional cloud backup to the user's CodeShelf account.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Keeps the user's saved solutions and sign-in session in the extension's local storage. |
| `unlimitedStorage` | A long-time user's library of solutions can exceed the default local storage quota. |
| `identity` | Opens Google sign-in (`chrome.identity.launchWebAuthFlow`) so the user can sign in to back up their solutions. |
| Host permission `https://qgvnwztoiitphhdfroxd.supabase.co/*` | Backs up and restores the signed-in user's solutions, and handles sign-in, via the CodeShelf backend. |
| Content scripts on `https://leetcode.com/*` | Detects when the user's own submission is Accepted, reads that submission's code and result from the page's own network responses, and shows the save status next to LeetCode's result. |

**Remote code:** No, I am not using remote code. (All JavaScript is in the package; the backend is only called for data.)

**Data usage – what's collected:**
- [x] Personally identifiable information (email address, when the user signs in)
- [x] Authentication information (sign-in session tokens)
- [x] User activity (network monitoring – limited to the user's own LeetCode submission requests and results)
- [x] Website content (the user's submitted code and the problem's title/metadata)
- Everything else: not collected.

**Certifications** (tick all three):
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** the public URL where `PRIVACY.md` is hosted.

## Distribution

- Visibility: **Public** (or **Unlisted** for a soft launch – only people with the link can install it).
- Regions: all.

## Notes for the reviewer (Test instructions tab)

> 1. Log in to leetcode.com (any account) and open a problem, e.g. https://leetcode.com/problems/two-sum/.
> 2. Submit a correct solution. When LeetCode shows "Accepted", a "Saved on this browser" button appears next to LeetCode's result buttons.
> 3. Click the CodeShelf toolbar icon to see the saved solution. Signing in (Google or email) is optional and backs the solution up.
