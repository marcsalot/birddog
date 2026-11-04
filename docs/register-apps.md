# Registering Birddog's own sign-in apps (owner's checklist)

This is for **the maintainer** of Birddog, not for people who install it. Once these apps exist and
their client IDs are in [`src/auth/clients.mjs`](../src/auth/clients.mjs), "Sign in with …" works
for everyone with no registration on their side. Until then, each card falls back to tokens (or
to bringing your own app, see the README).

Every app below is a **public client**: a program on the user's own computer that can't keep a
secret. So:

- Never create or paste a client secret, except Google's desktop one (Google says it isn't
  confidential for that client type).
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
| Google | auth code + PKCE, desktop app | Client ID **and** client secret |
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
   - Under *Mobile and desktop applications*, also add `http://127.0.0.1/auth/oauth/microsoft/callback`.
     If the portal refuses `http://127.0.0.1`, add it in the **Manifest** under `replyUrlsWithType`
     with `"type": "InstalledClient"`.
   - **Any port works:** for loopback redirects on this platform, Microsoft ignores the port.
   - Under **Advanced settings**, set **Allow public client flows** to **Yes**. Save.
4. **API permissions → Add a permission → Microsoft Graph → Delegated:** `User.Read`,
   `Calendars.Read` and `offline_access`. Don't grant admin consent; users consent for themselves.
5. Don't create a client secret or certificate.
6. **Paste back:** the **Application (client) ID** (a GUID) into `BUILT_IN.microsoft.clientId`.

Many work tenants block user consent to apps from unverified publishers. For those users to sign
in without an admin, complete **Publisher verification**: Branding & properties → Publisher
domain, plus a Microsoft Partner Network ID. Personal accounts work without it.

## Google (Calendar, desktop app + PKCE)

1. Open <https://console.cloud.google.com/> and create a project named **Birddog**.
2. **APIs & Services → Library**: enable the **Google Calendar API**.
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
   - **Data access → Add or remove scopes:** add only
     `https://www.googleapis.com/auth/calendar.readonly`. Google classes it as **sensitive**.
4. **Clients → Create client → Application type: Desktop app**, named `Birddog`.
   - There's nothing to register for redirects: desktop clients accept loopback redirects on
     **any port** (`http://127.0.0.1:<port>/…`).
5. **Paste back:** both values into `BUILT_IN.google`:
   - the **Client ID** (`….apps.googleusercontent.com`)
   - the **Client secret** (`GOCSPX-…`). For desktop clients Google says the secret isn't
     confidential, so it may ship in the code. Birddog still never sends it to the browser, an API
     response or a log.

Until Google verifies the app:
- Every user sees Google's **"Google hasn't verified this app"** screen, and has to choose
  **Advanced → Go to Birddog (unsafe)**. Birddog shows a notice about this next to the button
  while `BUILT_IN.google.verified` is `false`.
- Only **100 users** can ever sign in. That's Google's lifetime cap for unverified apps that ask
  for sensitive scopes like `calendar.readonly`.

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
4. When Google approves, set `verified: true` in `BUILT_IN.google` and the notice goes away.

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
