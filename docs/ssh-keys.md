# SSH key for git

## Requirements

1. A place in Settings to see the public SSH key git uses for `git@host:...` and `ssh://`
   remotes, so the user can copy it into GitHub, GitLab, Bitbucket or any other git server.
2. When no key exists the app does not create one by itself. The user clicks *Generate SSH
   key*.
3. In Docker the key survives container recreation, and the user can mount their own key
   instead.
4. The private key is never sent to the browser, logged or stored by the app outside the key
   file.
5. Later: keep the private key out of reach of the agents running in the same container
   (see *Next step*).

## Design

### Provider interface

`server/modules/ssh-keys/ssh-key-provider.ts` defines `SshKeyProvider`:

```ts
getKey(): Promise<SshKeyInfo>
generateKey({ replace? }): Promise<SshKeyInfo>
```

`SshKeyInfo` carries the status (`present`, `missing`, `unreadable`), origin (`generated` or
`existing`), algorithm, one-line public key, `SHA256:` fingerprint, comment, a display
location, and `canGenerate` / `canReplace` / `reason`. It never contains the private key.

The routes and the UI only use this interface. The current implementation is the **native
provider**; a provider that keeps the key in another container can replace it without
touching them.

### Native provider (`native-ssh-key.provider.ts`)

- The directory is `CLOUDCLI_SSH_DIR`, or `~/.ssh`.
- It looks for `id_ed25519`, `id_ecdsa`, `id_rsa` in that order and reports the first it finds.
- The public key comes from the `.pub` file. If there is none, `ssh-keygen -y -P ""` derives
  it; the empty passphrase makes a protected key fail instead of prompting, and the key is
  reported as `unreadable`.
- The fingerprint is computed in-process (SHA-256 of the key blob, base64 without padding), the
  form git servers display. It does not need `ssh-keygen`.
- **Generating** runs `ssh-keygen -t ed25519 -N ""` with the comment `cloudcli@<hostname>`.
  The pair is created under a temporary name in the same directory and renamed into place, so
  a failure never leaves a half-written key. The directory is created with mode `0700`, the
  private key is `0600`. One generation runs at a time; a second concurrent request gets
  `409 SSH_KEY_EXISTS`.
- **Existing keys are read, never changed.** `generate` over an existing key is `409
  SSH_KEY_EXISTS`. `replace: true` is honoured only for `id_ed25519` whose comment starts with
  `cloudcli@` (a key this app generated); any other key gets `403 SSH_KEY_NOT_REPLACEABLE`.
- A directory that is not writable is reported (`reason: "read-only"`, `canGenerate:
  false`). A missing `ssh-keygen` is `501 SSH_KEYGEN_MISSING`.

### API

Mounted at `/api/ssh-keys` behind the normal authentication.

| Request | Result |
|---|---|
| `GET /api/ssh-keys` | `SshKeyInfo` |
| `POST /api/ssh-keys/generate` with `{ "replace": false }` | The new `SshKeyInfo`, or 409 / 403 / 501 as above. `replace` must be a boolean. |

### UI

Settings > Git has an *SSH key* section (`SshKeySection`):

- no key: an explanation and a *Generate SSH key* button (hidden when the directory is
  read-only, with the reason shown instead);
- key present: type, fingerprint, location, origin, the public key in a read-only box with a
  *Copy* button, and links to the "add an SSH key" page of GitHub, GitLab and Bitbucket;
- a generated key also has *Replace key*, which asks for confirmation and reminds the user to
  swap the key on their git servers;
- a key that is not readable (for example protected by a passphrase) is explained, not shown;
- a standing note that every process in the environment can use the key.

### Docker

- `~/.ssh` is the `ssh-data` volume (`dev-ssh-data` in the dev stack), created in the images
  with mode `0700` and owned by `agent`. The key and `known_hosts` survive recreation.
- `/etc/ssh/ssh_config.d/50-cloudcli.conf` sets `StrictHostKeyChecking accept-new`, so the
  first connection to a server does not stop at a prompt nobody can answer. A host key that
  changes later is refused. This also lets the Source Control remote access check get past
  the first contact instead of reporting `host-key`.
- A user key can be mounted over the volume; it is shown, never replaced.

## Security notes

- The key is not encrypted at rest and has no passphrase: the app must be able to use it
  unattended. File permissions are the protection.
- **Everything running as the same user can read the private key**, including the AI agents'
  shells. The page says so. Use a dedicated key with limited access, such as a deploy key.
- The API only returns the public half. The private key is never read by the app apart from
  asking `ssh-keygen` to derive the public key.

## Next step

A separate container that holds the key and runs `ssh-agent`, with the app talking to it
through a socket, so the agents can use the key to authenticate but cannot read it. The
provider interface above is the seam for that change.
