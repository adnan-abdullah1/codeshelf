# Install CodeShelf (without the Chrome Web Store)

CodeShelf saves every LeetCode solution you get **Accepted**, so you can find it again later. It isn't on the Chrome Web Store yet, so you install it by hand. It takes about two minutes.

You need **Google Chrome** (or another Chromium browser such as Brave or Edge) on a computer.

## 1. Download

1. Open the latest release: **https://github.com/adnan-abdullah1/codeshelf/releases/latest**
2. Under **Assets**, download **`codeshelf-<version>-unpacked.zip`**.
3. Unzip it. You get a folder called **`CodeShelf`**.
4. Move that folder somewhere it can stay, for example your Documents folder. Chrome runs the extension from this folder, so **don't delete or move it later**.

## 2. Add it to Chrome

1. In the address bar, go to **`chrome://extensions`**.
2. Turn on **Developer mode** (switch in the top-right corner).
3. Click **Load unpacked** and choose the **`CodeShelf`** folder from step 1.
4. CodeShelf now appears in the list. Click the puzzle-piece icon in Chrome's toolbar and **pin** CodeShelf, so its blue icon is always visible.

## 3. Use it

1. Open any problem on **leetcode.com** (if LeetCode was already open, refresh the tab).
2. Submit your solution as usual.
3. When LeetCode says **Accepted**, a CodeShelf button appears next to LeetCode's result:
   - **Saved on this browser**: saved on this computer.
   - **Saved & backed up**: saved and backed up to your account.
4. Click the CodeShelf icon to see, search and copy your saved solutions, or **Export JSON** to download them.

Submitting the same code again is skipped (the button says **Same code already saved**), so you won't get duplicates.

## 4. Back up your solutions (recommended)

Without an account, your solutions only live in this browser. To back them up and get them on other computers:

1. Click the CodeShelf icon → **Sign in**.
2. Click **Continue with Google** (or use an email and password, then **Create account**).

Solutions you saved before signing in are backed up straight away. Sign in on another computer and they're downloaded there too.

## Updating to a new version

1. Download the new `-unpacked.zip` from the releases page.
2. Unzip it and **replace the contents** of your existing `CodeShelf` folder with the new files.
3. Go to `chrome://extensions` and click the **↻ reload** icon on CodeShelf.
4. Refresh any open LeetCode tabs.

Don't use **Remove** to update: removing the extension deletes the solutions saved on this computer (anything backed up to your account is safe and comes back when you sign in).

## Good to know

- **"Disable developer mode extensions" warning:** Chrome may show this when it starts, because CodeShelf isn't from the Web Store. Click the **×** to close it, and **don't** click Disable.
- **The button says "Reload page to save":** CodeShelf was updated or reloaded while LeetCode was open. Click the button to refresh the page; your solution is saved after the refresh.
- **The button says "CodeShelf: not captured":** something on LeetCode's side didn't match. Click the button (it copies a short diagnostic, without your code) and send it to the developer.
- **Privacy:** CodeShelf only reads your own submissions on leetcode.com. See the [privacy policy](PRIVACY.md).

CodeShelf is an independent project and is not affiliated with LeetCode.
