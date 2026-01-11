# Git HTTP Backend Specification

A guide for implementing a backend capable of handling Git operations (clone, fetch, push) over HTTP.

## Overview

Git supports two main protocols for HTTP transport:

1. **Dumb HTTP** - Static file serving (deprecated, read-only)
2. **[Smart HTTP][http-protocol]** - Dynamic protocol with bidirectional communication

This specification covers the **Smart HTTP** protocol, which is what modern Git clients expect.

[http-protocol]: https://git-scm.com/docs/http-protocol

## Prerequisites

Your server needs:

- Git installed and accessible via command line
- Bare repositories (created with `git init --bare`)
- Ability to spawn child processes

## Core Concepts

### Bare Repositories

A bare repository has no working directory - it only contains the `.git` internals:

```bash
git init --bare my-repo.git
```

This creates a directory structure like:

```
my-repo.git/
├── HEAD
├── config
├── objects/
├── refs/
└── hooks/
```

### Packet Line Format

Git uses a custom framing protocol called "[packet lines][pkt-line]" (pkt-line):

[pkt-line]: https://git-scm.com/docs/protocol-common#_pkt_line_format

- Each line is prefixed with a 4-character hex length (including the 4 bytes for the length itself)
- A special "flush packet" (`0000`) signals the end of a section
- Maximum line length is 65520 bytes

```
Format: LLLLDATA

Where:
- LLLL = 4-character hex length of the entire line (length + data)
- DATA = the actual content
```

**Examples:**

| Data | Encoded |
|------|---------|
| `hello\n` | `000ahello\n` |
| `# service=git-upload-pack\n` | `001e# service=git-upload-pack\n` |
| (flush) | `0000` |

**Implementation:**

```javascript
function packetLine(data) {
  const length = (data.length + 4).toString(16).padStart(4, '0');
  return length + data;
}

function flushPacket() {
  return '0000';
}
```

## HTTP Endpoints

A Git HTTP backend must implement three endpoints per repository:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/:repo/info/refs?service=<service>` | GET | Reference discovery |
| `/:repo/git-upload-pack` | POST | Fetch/Clone operations |
| `/:repo/git-receive-pack` | POST | Push operations |

## Protocol Flow

### Clone/Fetch Flow

```
┌────────┐                              ┌────────┐
│ Client │                              │ Server │
└───┬────┘                              └───┬────┘
    │                                       │
    │ GET /repo.git/info/refs               │
    │     ?service=git-upload-pack          │
    │ ────────────────────────────────────► │
    │                                       │
    │ ◄──────────────────────────────────── │
    │   200 OK                              │
    │   Content-Type: application/          │
    │     x-git-upload-pack-advertisement   │
    │   Body: refs + capabilities           │
    │                                       │
    │ POST /repo.git/git-upload-pack        │
    │   Content-Type: application/          │
    │     x-git-upload-pack-request         │
    │   Body: wants + haves                 │
    │ ────────────────────────────────────► │
    │                                       │
    │ ◄──────────────────────────────────── │
    │   200 OK                              │
    │   Content-Type: application/          │
    │     x-git-upload-pack-result          │
    │   Body: packfile                      │
    │                                       │
```

### Push Flow

```
┌────────┐                              ┌────────┐
│ Client │                              │ Server │
└───┬────┘                              └───┬────┘
    │                                       │
    │ GET /repo.git/info/refs               │
    │     ?service=git-receive-pack         │
    │ ────────────────────────────────────► │
    │                                       │
    │ ◄──────────────────────────────────── │
    │   200 OK                              │
    │   Content-Type: application/          │
    │     x-git-receive-pack-advertisement  │
    │   Body: refs + capabilities           │
    │                                       │
    │ POST /repo.git/git-receive-pack       │
    │   Content-Type: application/          │
    │     x-git-receive-pack-request        │
    │   Body: ref updates + packfile        │
    │ ────────────────────────────────────► │
    │                                       │
    │ ◄──────────────────────────────────── │
    │   200 OK                              │
    │   Content-Type: application/          │
    │     x-git-receive-pack-result         │
    │   Body: status report                 │
    │                                       │
```

## Endpoint Implementation

### 1. Reference Discovery (`/info/refs`)

This endpoint tells the client what refs (branches, tags) exist and what [capabilities][capabilities] the server supports.

[capabilities]: https://git-scm.com/docs/protocol-capabilities

**Request:**

```http
GET /my-repo.git/info/refs?service=git-upload-pack HTTP/1.1
Host: localhost:3000
```

**Response:**

```http
HTTP/1.1 200 OK
Content-Type: application/x-git-upload-pack-advertisement
Cache-Control: no-cache

001e# service=git-upload-pack\n
0000
<output from git upload-pack --advertise-refs>
```

**Implementation:**

```javascript
async function handleInfoRefs(req, res, repoPath, service) {
  // Validate service parameter
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400);
    res.end('Invalid service');
    return;
  }

  const serviceName = service.replace('git-', '');

  // Set appropriate content type
  res.writeHead(200, {
    'Content-Type': `application/x-git-${serviceName}-advertisement`,
    'Cache-Control': 'no-cache'
  });

  // Write service announcement (required by protocol)
  res.write(packetLine(`# service=${service}\n`));
  res.write(flushPacket());

  // Let git handle the rest
  const git = spawn('git', [
    serviceName,
    '--stateless-rpc',
    '--advertise-refs',
    repoPath
  ]);

  git.stdout.pipe(res);
}
```

**Key flags:**

- `--stateless-rpc`: Enables HTTP-compatible mode (no persistent connection state)
- `--advertise-refs`: Only output ref advertisement, don't expect input

### 2. Upload Pack (`/git-upload-pack`)

Handles fetch and clone operations using [`git-upload-pack`][upload-pack]. The client sends what it wants, and the server responds with a [packfile][pack-format].

[upload-pack]: https://git-scm.com/docs/git-upload-pack
[pack-format]: https://git-scm.com/docs/pack-format

**Request:**

```http
POST /my-repo.git/git-upload-pack HTTP/1.1
Host: localhost:3000
Content-Type: application/x-git-upload-pack-request

<pkt-line encoded wants/haves>
```

**Response:**

```http
HTTP/1.1 200 OK
Content-Type: application/x-git-upload-pack-result
Cache-Control: no-cache

<NAK or ACK lines>
<packfile data>
```

**Implementation:**

```javascript
async function handleUploadPack(req, res, repoPath) {
  res.writeHead(200, {
    'Content-Type': 'application/x-git-upload-pack-result',
    'Cache-Control': 'no-cache'
  });

  const git = spawn('git', [
    'upload-pack',
    '--stateless-rpc',
    repoPath
  ]);

  // Pipe request body to git stdin
  req.pipe(git.stdin);

  // Pipe git stdout to response
  git.stdout.pipe(res);
}
```

### 3. Receive Pack (`/git-receive-pack`)

Handles push operations using [`git-receive-pack`][receive-pack]. The client sends ref updates and a packfile, and the server applies them.

[receive-pack]: https://git-scm.com/docs/git-receive-pack

**Request:**

```http
POST /my-repo.git/git-receive-pack HTTP/1.1
Host: localhost:3000
Content-Type: application/x-git-receive-pack-request

<pkt-line encoded ref updates>
<packfile data>
```

**Response:**

```http
HTTP/1.1 200 OK
Content-Type: application/x-git-receive-pack-result
Cache-Control: no-cache

<unpack status>
<ref update statuses>
```

**Implementation:**

```javascript
async function handleReceivePack(req, res, repoPath) {
  res.writeHead(200, {
    'Content-Type': 'application/x-git-receive-pack-result',
    'Cache-Control': 'no-cache'
  });

  const git = spawn('git', [
    'receive-pack',
    '--stateless-rpc',
    repoPath
  ]);

  req.pipe(git.stdin);
  git.stdout.pipe(res);

  // Optional: trigger webhooks after push completes
  git.on('close', (code) => {
    if (code === 0) {
      triggerWebhooks(repoPath);
    }
  });
}
```

## Content Types

| Operation | Request Content-Type | Response Content-Type |
|-----------|---------------------|----------------------|
| Ref discovery (upload-pack) | N/A | `application/x-git-upload-pack-advertisement` |
| Ref discovery (receive-pack) | N/A | `application/x-git-receive-pack-advertisement` |
| Upload pack | `application/x-git-upload-pack-request` | `application/x-git-upload-pack-result` |
| Receive pack | `application/x-git-receive-pack-request` | `application/x-git-receive-pack-result` |

## URL Routing

Parse incoming URLs to extract repository name and operation:

```javascript
function parseGitUrl(url) {
  const patterns = {
    infoRefs: /^\/(.+\.git)\/info\/refs$/,
    uploadPack: /^\/(.+\.git)\/git-upload-pack$/,
    receivePack: /^\/(.+\.git)\/git-receive-pack$/
  };

  for (const [type, pattern] of Object.entries(patterns)) {
    const match = url.match(pattern);
    if (match) {
      return { type, repo: match[1] };
    }
  }

  return null;
}
```

## Complete Request Handler

```javascript
async function handleGitRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parsed = parseGitUrl(url.pathname);

  if (!parsed) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const repoPath = path.join(REPOS_DIR, parsed.repo);

  if (!fs.existsSync(repoPath)) {
    res.writeHead(404);
    res.end('Repository not found');
    return;
  }

  switch (parsed.type) {
    case 'infoRefs':
      const service = url.searchParams.get('service');
      await handleInfoRefs(req, res, repoPath, service);
      break;

    case 'uploadPack':
      await handleUploadPack(req, res, repoPath);
      break;

    case 'receivePack':
      await handleReceivePack(req, res, repoPath);
      break;
  }
}
```

## Creating Repositories

To create a new repository that can accept pushes:

```javascript
function createRepository(name) {
  const repoPath = path.join(REPOS_DIR, `${name}.git`);

  // Create bare repository
  execSync(`git init --bare "${repoPath}"`);

  return repoPath;
}
```

## Authentication

Git clients support [HTTP Basic Authentication][http-basic] natively. When a server returns `401 Unauthorized` with a `WWW-Authenticate: Basic` header, Git prompts the user for credentials (or uses a configured [credential helper][credential-helper]).

[http-basic]: https://datatracker.ietf.org/doc/html/rfc7617
[credential-helper]: https://git-scm.com/docs/gitcredentials

### Basic Authentication Flow

```
┌────────┐                              ┌────────┐
│ Client │                              │ Server │
└───┬────┘                              └───┬────┘
    │                                       │
    │ GET /repo.git/info/refs               │
    │ ────────────────────────────────────► │
    │                                       │
    │ ◄──────────────────────────────────── │
    │   401 Unauthorized                    │
    │   WWW-Authenticate: Basic realm="Git" │
    │                                       │
    │ (Git prompts user for credentials)    │
    │                                       │
    │ GET /repo.git/info/refs               │
    │   Authorization: Basic base64(u:p)    │
    │ ────────────────────────────────────► │
    │                                       │
    │ ◄──────────────────────────────────── │
    │   200 OK                              │
    │                                       │
```

### Implementation

```javascript
function parseBasicAuth(req) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Basic ')) {
    return null;
  }

  const base64 = header.slice(6);
  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  const [username, password] = decoded.split(':');

  return { username, password };
}

function requireAuth(req, res, next) {
  const credentials = parseBasicAuth(req);

  if (!credentials) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Git"'
    });
    res.end('Authentication required');
    return false;
  }

  // Validate credentials against your user store
  if (!validateUser(credentials.username, credentials.password)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Git"'
    });
    res.end('Invalid credentials');
    return false;
  }

  return true;
}
```

### Protecting Push Operations

A common pattern is to allow anonymous clones but require authentication for pushes:

```javascript
async function handleGitRequest(req, res) {
  const parsed = parseGitUrl(req.url);

  // Require auth only for push operations
  if (parsed.type === 'receivePack' ||
      (parsed.type === 'infoRefs' && req.query.service === 'git-receive-pack')) {
    if (!requireAuth(req, res)) {
      return;
    }
  }

  // Continue with normal handling...
}
```

### Token-Based Authentication

For CI/CD systems and automation, support token-based auth as an alternative to passwords:

```javascript
function parseBasicAuth(req) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Basic ')) {
    return null;
  }

  const base64 = header.slice(6);
  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  const [username, password] = decoded.split(':');

  // Support token auth: username is ignored, password is the token
  // Convention: use "x-token" or "x-access-token" as username
  if (username === 'x-token' || username === 'x-access-token') {
    return { type: 'token', token: password };
  }

  return { type: 'basic', username, password };
}
```

**Client usage with tokens:**

```bash
# Using token in URL (not recommended - visible in logs)
git clone http://x-token:mytoken123@localhost:3000/repo.git

# Using credential helper (recommended)
git config credential.helper store
echo "http://x-token:mytoken123@localhost:3000" >> ~/.git-credentials
```

### Per-Repository Access Control

Implement authorization checks after authentication:

```javascript
function canAccess(username, repoName, operation) {
  // operation: 'read' or 'write'
  const permissions = getRepoPermissions(repoName);

  if (operation === 'read') {
    return permissions.public || permissions.readers.includes(username);
  }

  if (operation === 'write') {
    return permissions.writers.includes(username) ||
           permissions.owner === username;
  }

  return false;
}
```

## SSH Authentication

While this spec focuses on HTTP, [SSH is another common transport][git-ssh] for Git. SSH provides stronger security through public key authentication.

[git-ssh]: https://git-scm.com/book/en/v2/Git-on-the-Server-The-Protocols#_the_ssh_protocol

### How Git SSH Works

```
┌────────┐                              ┌────────┐
│ Client │                              │ Server │
└───┬────┘                              └───┬────┘
    │                                       │
    │ SSH connection to git@server          │
    │   (public key authentication)         │
    │ ────────────────────────────────────► │
    │                                       │
    │ Server runs: git-upload-pack 'repo'   │
    │         or: git-receive-pack 'repo'   │
    │                                       │
    │ ◄──────────────────────────────────── │
    │   Git protocol over SSH channel       │
    │                                       │
```

### SSH URL Format

```bash
# Standard format
git clone git@github.com:user/repo.git

# Explicit SSH format
git clone ssh://git@github.com/user/repo.git

# Custom port
git clone ssh://git@github.com:2222/user/repo.git
```

### Server-Side Implementation

SSH Git hosting requires:

1. **SSH Server** (OpenSSH)
2. **Restricted Shell** to limit commands to git operations
3. **Authorized Keys** management

**Example: Restricted git-shell**

The [`git-shell`][git-shell] command restricts users to Git operations only:

[git-shell]: https://git-scm.com/docs/git-shell

```bash
# Add user with git-shell
sudo useradd -m -s $(which git-shell) git

# Add client's public key
sudo -u git mkdir -p /home/git/.ssh
sudo -u git cat >> /home/git/.ssh/authorized_keys << EOF
ssh-rsa AAAAB3... user@client
EOF
```

**Example: Custom SSH Command Handler**

For more control, use SSH's `command=` option in `authorized_keys`:

```
# /home/git/.ssh/authorized_keys
command="/usr/local/bin/git-auth-wrapper $SSH_ORIGINAL_COMMAND",no-port-forwarding,no-agent-forwarding ssh-rsa AAAAB3... user@client
```

```bash
#!/bin/bash
# /usr/local/bin/git-auth-wrapper

# Parse the Git command
if [[ "$1" =~ ^git-(upload|receive)-pack\ \'([^\']+)\'$ ]]; then
    CMD="${BASH_REMATCH[0]}"
    REPO="${BASH_REMATCH[2]}"

    # Validate repository path
    REPO_PATH="/home/git/repos/$REPO"
    if [[ -d "$REPO_PATH" ]]; then
        exec git-shell -c "$CMD"
    fi
fi

echo "Invalid command" >&2
exit 1
```

### SSH vs HTTP Comparison

| Feature | SSH | HTTP |
|---------|-----|------|
| Authentication | Public key (strong) | Basic auth / tokens |
| Encryption | Built-in | Requires HTTPS |
| Firewall-friendly | Port 22 often blocked | Port 443 usually open |
| Anonymous access | Not supported | Supported |
| Setup complexity | Higher | Lower |
| CI/CD integration | Requires key management | Easier with tokens |

### Hybrid Approach

Many Git hosts offer both:

```bash
# Clone via HTTPS (anonymous)
git clone https://github.com/user/repo.git

# Push via SSH (authenticated)
git remote set-url --push origin git@github.com:user/repo.git
```

## Security Considerations

1. **Path Traversal**: Validate repository names to prevent `../` attacks
2. **HTTPS**: Always use HTTPS in production - Basic Auth sends credentials base64-encoded (not encrypted)
3. **Rate Limiting**: Protect against brute-force attacks on authentication
4. **Credential Storage**: Hash passwords with bcrypt/argon2, never store plaintext
5. **SSH Key Rotation**: Implement key expiration and rotation policies

**Example path validation:**

```javascript
function isValidRepoName(name) {
  // Only allow alphanumeric, dash, underscore, and .git suffix
  return /^[a-zA-Z0-9_-]+\.git$/.test(name) && !name.includes('..');
}
```

## Testing Your Implementation

```bash
# Create a repository
curl -X POST http://localhost:3000/api/repos \
  -H "Content-Type: application/json" \
  -d '{"name": "test-repo"}'

# Clone it
git clone http://localhost:3000/test-repo.git

# Make changes and push
cd test-repo
echo "Hello" > README.md
git add .
git commit -m "Initial commit"
git push origin main
```

## References

### Git Protocol Documentation
- [Git HTTP Transport Protocol](https://git-scm.com/docs/http-protocol) - Official Smart HTTP spec
- [Protocol Common](https://git-scm.com/docs/protocol-common) - Packet line format details
- [Protocol Capabilities](https://git-scm.com/docs/protocol-capabilities) - Capability negotiation
- [Pack Protocol](https://git-scm.com/docs/pack-protocol) - Pack negotiation and transfer
- [Pack Format](https://git-scm.com/docs/pack-format) - Packfile binary format

### Git Commands
- [git-upload-pack](https://git-scm.com/docs/git-upload-pack) - Server-side fetch/clone
- [git-receive-pack](https://git-scm.com/docs/git-receive-pack) - Server-side push
- [git-shell](https://git-scm.com/docs/git-shell) - Restricted shell for SSH
- [git-http-backend](https://git-scm.com/docs/git-http-backend) - CGI program for HTTP

### Authentication
- [Git Credentials](https://git-scm.com/docs/gitcredentials) - Credential helper system
- [RFC 7617 - HTTP Basic Auth](https://datatracker.ietf.org/doc/html/rfc7617) - Basic authentication spec
- [OpenSSH authorized_keys](https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT) - SSH key configuration
