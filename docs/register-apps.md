# Registering Birddog's own sign-in apps (owner's checklist)

This is for **the maintainer** of Birddog, not for people who install it. Once these apps exist and
their client IDs are in [`src/auth/clients.mjs`](../src/auth/clients.mjs), "Sign in with …" works
for everyone with no registration on their side. Until then, each card falls back to tokens (or
to bringing your own app, see the README).

Every app below is a **public client**: a program on the user's own computer that can't keep a
secret. So:

- Never put a client secret in the repo, Birddog's config defaults or its docs. Google's desktop
  client is the only one that has a secret Birddog needs, and that one is handed out privately
  (see Google below).
- Client IDs are not secrets. They get committed to the public repo, which is expected.
- Name every app **Birddog**, and use the same homepage and privacy policy everywhere:
  - **Homepage:** `https://github.com/marcsalot/birddog`, or your own site (Google verification
    needs a domain you own, see Google below).
  - **Privacy policy:** [`PRIVACY.md`](../PRIVACY.md), e.g. `https://github.com/marcsalot/birddog/blob/main/PRIVACY.md`.
- Birddog listens on `127.0.0.1:4747` by default. The redirect it sends is
  `http://<the host you opened Birddog on>/auth/oauth/<provider>/callback`. Register both the
  `127.0.0.1` and `localhost` forms where the provider matches redirects exactly.

When done, paste the values into `BUILT_IN` in `src/auth/clients.mjs`, run `npm test`, and commit.
Or send them to whoever is making the change.

| Provider | Flow | Paste back |
|---|---|---|
| GitHub | device flow | Client ID |
| GitLab | auth code + PKCE | Application ID |
| Microsoft | auth code + PKCE, public client | Application (client) ID |
| Google | auth code + PKCE, desktop app | Client ID only (the secret is handed out privately) |
| Linear | auth code + PKCE | Client ID |
| PagerDuty | Classic User OAuth + PKCE | Client ID |
| Atlassian, Slack | none: no built-in app | nothing (see the end) |

---

## GitHub (device flow)

1. Open <https://github.com/settings/applications/new> (or your organization → Settings →
   Developer settings → OAuth Apps → New OAuth App, if Birddog should belong to an org).
2. Fill in the form:
   - **Application name:** `Birddog`
   - **Homepage URL:** the homepage above
   - **Authorization callback URL:** `http://127.0.0.1:4747/`. GitHub requires one, but the device
     flow never uses it.
3. Tick **Enable Device Flow**, then **Register application**.
4. Don't generate a client secret.
5. Scopes are asked for at sign-in, not set here: `repo read:org`. GitHub's OAuth Apps have no
   read-only repo scope, so the card says Birddog only reads.
6. **Paste back:** the **Client ID** (starts with `Ov23` or `Iv1.`) into `BUILT_IN.github.clientId`.

Any port works, because there's no redirect. The built-in app is used on github.com only;
GitHub Enterprise users bring their own app (`sources.github.clientId`).

## GitLab (gitlab.com, authorization code + PKCE)

1. Open <https://gitlab.com/-/user_settings/applications>. Use a group's
   Settings → Applications instead if the app should outlive your account.
2. Fill in the form:
   - **Name:** `Birddog`
   - **Redirect URI**, one per line:
     ```
     http://127.0.0.1:4747/auth/oauth/gitlab/callback
     http://localhost:4747/auth/oauth/gitlab/callback
     ```
   - **Confidential:** **untick it.** This is what makes it a public client with PKCE and no secret.
   - **Scopes:** only `read_api`.
3. **Save application.** Ignore the secret GitLab shows.
4. **Paste back:** the **Application ID** into `BUILT_IN.gitlab.clientId`.

GitLab matches redirect URIs exactly, so only the ports you list work. Add lines for other ports
if you want them. Self-managed GitLab users bring their own app; the built-in one only applies to
`https://gitlab.com`.

## Microsoft (Entra ID, public client, work + personal accounts)

1. Open <https://entra.microsoft.com> → **Identity → Applications → App registrations → New registration**.
2. Fill in the form:
   - **Name:** `Birddog`
   - **Supported account types:** *Accounts in any organizational directory and personal
     Microsoft accounts*. That's tenant `common`, which Birddog uses.
   - **Redirect URI:** choose the platform **Public client/native (mobile & desktop)** and enter
     `http://localhost/auth/oauth/microsoft/callback`.
3. **Register.** Then go to **Authentication**:
   - Under *Mobile and desktop applications*, also add `http://127.0.0.1/auth/oauth/microsoft/callback`,
     and for Microsoft Teams `http://localhost/auth/oauth/teams/callback` and
     `http://127.0.0.1/auth/oauth/teams/callback` (Teams signs in separately, with the same app),
     for Microsoft To Do `http://localhost/auth/oauth/mstodo/callback` and
     `http://127.0.0.1/auth/oauth/mstodo/callback`, and for Outlook mail
     `http://localhost/auth/oauth/msmail/callback` and `http://127.0.0.1/auth/oauth/msmail/callback`
     (same app, each with its own sign-in).
     If the portal refuses `http://127.0.0.1`, add it in the **Manifest** under `replyUrlsWithType`
     with `"type": "InstalledClient"`.
   - **Any port works:** for loopback redirects on this platform, Microsoft ignores the port.
   - Under **Advanced settings**, set **Allow public client flows** to **Yes**. Save.
4. **API permissions → Add a permission → Microsoft Graph → Delegated:** `User.Read`,
   `Calendars.Read` and `offline_access`, for Teams `Chat.Read` and `ChatMessage.Send`, and for
   To Do `Tasks.Read` and `Tasks.ReadWrite`, and for Outlook mail `Mail.ReadBasic` and `Mail.Read`
   (asked for only when someone turns on Read message text). Don't grant admin consent; users consent for
   themselves (Teams only asks for `ChatMessage.Send` once someone turns on Allow replies, To Do
   only asks for `Tasks.ReadWrite` once someone turns on Sync done). Teams chats need a work or
   school account; To Do works with personal accounts too.
5. Don't create a client secret or certificate.
6. **Paste back:** the **Application (client) ID** (a GUID) into `BUILT_IN.microsoft.clientId`.

Many work tenants block user consent to apps from unverified publishers. For those users to sign
in without an admin, complete **Publisher verification**: Branding & properties → Publisher
domain, plus a Microsoft Partner Network ID. Personal accounts work without it.

## Google (Calendar, desktop app + PKCE)

1. Open <https://console.cloud.google.com/> and create a project named **Birddog**.
2. **APIs & Services → Library**: enable the **Google Calendar API**, the **Google Tasks API** and the
   **Gmail API** (Google Tasks and Gmail sign in separately, with the same desktop client).
3. **Google Auth Platform**, also called the OAuth consent screen:
   - **Branding:**
     - **App name:** `Birddog`
     - **User support email:** your address
     - **App home page:** the homepage
     - **Privacy policy:** `PRIVACY.md`'s URL
     - **Authorized domains:** the homepage's domain
     - **Developer contact:** your address
   - **Audience:** **External**. Then **Publish app** to move it to *In production*. In *Testing*,
     only listed test users can sign in and refresh tokens expire after 7 days.
   - **Data access → Add or remove scopes:** add
     `https://www.googleapis.com/auth/calendar.readonly`, `https://www.googleapis.com/auth/tasks.readonly`,
     `https://www.googleapis.com/auth/tasks` (asked for only after someone turns on Sync done) and
     `email` (to show which account is signed in), `https://www.googleapis.com/auth/gmail.metadata`,
     and `https://www.googleapis.com/auth/gmail.readonly` (asked for instead of metadata only when
     someone turns on Read message text).
     Google classes the calendar and tasks scopes as **sensitive** and `gmail.metadata` as
     **restricted** (so is `gmail.readonly`): a public app using them needs Google's verification and an annual security
     assessment. Until then, Sign in with Gmail works only for the app's test users. Leave it
     out if you don't want that; everything else keeps working.
4. **Clients → Create client → Application type: Desktop app**, named `Birddog`.
   - There's nothing to register for redirects: desktop clients accept loopback redirects on
     **any port** (`http://127.0.0.1:<port>/…`).
5. **Paste back:** only the **Client ID** (`….apps.googleusercontent.com`) into
   `BUILT_IN.google.clientId`.
6. **Keep the client secret out of Birddog.** Google's token exchange for desktop clients needs it,
   but it doesn't go in the code, config defaults or docs. Keep it in the Google Cloud console
   (or your password manager) and give it privately to each person who should be able to sign in.

### Giving someone the Google secret

Without the secret, the Calendar card doesn't show a broken button. It shows one step: get the
secret from whoever runs the Birddog Google project, then store it locally. Send them the value
privately (a password manager share, not chat or email in plain text), and they run **one** of:

- **Keychain (usual):**
  ```
  birddog secret set google-client-secret
  ```
  Birddog asks for the value at a hidden prompt, or reads it from stdin
  (`pbpaste | birddog secret set google-client-secret`). It never takes the value as a
  command-line argument, so it can't end up in shell history or `ps`.
- **Environment:** `BIRDDOG_GOOGLE_CLIENT_SECRET`, or `BIRDDOG_GOOGLE_CLIENT_SECRET_FILE` pointing
  at a file that holds it (for example a Docker secret at `/run/secrets/google_client_secret`).
  Restart Birddog after setting either.

Note for Docker: sign-ins aren't available in the container at all, because there's no keychain
to keep the tokens in. The variables are read there, but people running Birddog in Docker should
use the calendar's iCal link instead.

The person must also be on the test-user list while the app is in Testing (below). Birddog never
sends the secret to the browser, an API response or a log.

Set `BUILT_IN.google.status` to match the app's publishing status. It drives the notice next to
the button:

- **`'testing'`** (publishing status *Testing*). Only the test users listed under Audience can
  sign in; anyone else gets `access_denied` / "has not completed the Google verification process",
  which Birddog turns into "invite-only, use an iCal link". Google also ends test users' refresh
  tokens after **7 days**, so they sign in again weekly. Google won't let you publish until the
  homepage and privacy policy are on a domain you can verify (not github.com; your
  `<you>.github.io` works).
- **`'unverified'`** (*In production*, not verified). Every user sees Google's **"Google hasn't
  verified this app"** screen and has to choose **Advanced → Go to Birddog (unsafe)**, and only
  **100 users** can ever sign in. That's Google's lifetime cap for unverified apps that ask for
  sensitive scopes like `calendar.readonly`.
- **`'verified'`**: no notice.

Until a person has stored the secret, their Calendar card shows the step from "Giving someone
the Google secret" above instead of the button.

To lift both:
1. Submit the app for **verification**: Google Auth Platform → Verification Center.
2. Google needs:
   - a homepage on a domain you own, verified in Google Search Console (a GitHub Pages site on
     your own domain or `<you>.github.io` works)
   - a privacy policy on that domain that describes how Birddog uses Google user data, and states
     that Birddog complies with the Google API Services User Data Policy, including the Limited
     Use requirements. [`PRIVACY.md`](../PRIVACY.md) has this text.
   - a short demo video of the sign-in and of what the scope is used for
3. Sensitive scopes don't need a security assessment.
4. When Google approves, set `status: 'verified'` in `BUILT_IN.google` and the notice goes away.

## Linear (authorization code + PKCE)

1. Open <https://linear.app/settings/api/applications/new>. You need to be a workspace admin.
2. Fill in the form:
   - **Application name:** `Birddog`
   - **Developer name:** your name
   - **Developer URL:** the homepage
   - **Description:** "Read-only 'what needs me next?' inbox. Runs on your own computer."
   - **Callback URLs:**
     ```
     http://127.0.0.1:4747/auth/oauth/linear/callback
     http://localhost:4747/auth/oauth/linear/callback
     ```
   - **Public:** turn it **on**, so people in other workspaces can authorize it.
3. **Create.** Don't use the client secret.
4. Linear's docs say it's optional with PKCE, and a PKCE token refreshes with `client_id` only.
   Birddog asks for the `read` scope at sign-in.
5. **Paste back:** the **Client ID** into `BUILT_IN.linear.clientId`.

Linear's docs don't say whether other ports match, so register every port you want to work.

## PagerDuty (Classic User OAuth + PKCE)

1. In PagerDuty, go to **Integrations → App Registration → New App**
   (`https://<your-subdomain>.pagerduty.com/developer/apps`).
2. Fill in the form:
   - **Name:** `Birddog`
   - **Description:** "Read-only personal inbox: your incidents and on-call shifts."
   - **Category:** Productivity (or the closest)
3. Under **Functionality**, add **OAuth 2.0** and choose **Classic User OAuth** (not Scoped OAuth,
   which can't be a public client).
4. Set the permission to **Read-only access**.
5. Set the **Redirect URLs:**
   ```
   http://127.0.0.1:4747/auth/oauth/pagerduty/callback
   http://localhost:4747/auth/oauth/pagerduty/callback
   ```
6. Save. Don't use the client secret. PagerDuty's docs say a non-confidential client omits it and
   must use PKCE.
7. **Paste back:** the **Client ID** into `BUILT_IN.pagerduty.clientId`.

Two things aren't confirmed by PagerDuty's docs:
- **Refresh without a secret.** Access tokens last 30 days. When a refresh is refused, Birddog
  marks PagerDuty stale and shows **Sign in again**.
- **Use by other accounts.** Whether people in *other* PagerDuty accounts can use an app registered
  in yours, before it's listed publicly. Test it with a second account before relying on it.

## Atlassian (Jira) and Slack: no built-in app

Both need a **confidential client secret** for their OAuth flows, and a downloadable app can't
keep one. So Birddog ships no app for them:

- **Jira:** the API token (site, email, token) is the main way in. Advanced users can register
  their own Atlassian OAuth 2.0 (3LO) integration. See the README, "Sign in instead of pasting
  tokens".
- **Slack:** a user token (`xoxp-…`) from the user's own Slack app, with read-only scopes.

## iCloud

Apple has no OAuth for calendars. Users make an app-specific password at appleid.apple.com.
There's nothing to register.
