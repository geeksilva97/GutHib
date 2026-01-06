# Legit

A lightweight, self-hosted Git server written in Node.js with zero external dependencies.

## Features

- **Full Git Protocol Support** - Clone, fetch, and push via standard Git commands over HTTP
- **Web Interface** - Browse repositories, commits, branches, tags, and file trees
- **Webhook System** - Trigger external services on push events with optional HMAC-SHA256 signing
- **Zero Dependencies** - Uses only Node.js built-in modules
- **SQLite Storage** - Persistent metadata and webhook configuration

## Requirements

- Node.js 22.0.0 or higher
- Git installed on the system

## Installation

```bash
git clone <repo-url>
cd legit
npm start
```

The server starts at `http://localhost:3000` by default.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `REPOS_DIR` | `./repos` | Directory for bare git repositories |

Example:
```bash
PORT=8080 REPOS_DIR=/var/git/repos node server.js
```

## Usage

### Web Interface

- **Home** (`/`) - List all repositories
- **Repository** (`/:repo`) - View branches, tags, recent commits
- **Commit** (`/:repo/commit/:hash`) - View commit details and diff
- **Tree** (`/:repo/tree/:ref`) - Browse files at a specific ref
- **Blob** (`/:repo/blob/:ref/:path`) - View file contents
- **Compare** (`/:repo/compare/:base...:head`) - Compare two commits

### Git Operations

```bash
# Clone a repository
git clone http://localhost:3000/my-repo.git

# Add as remote and push
git remote add origin http://localhost:3000/my-repo.git
git push -u origin main
```

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/repos` | List all repositories |
| `POST` | `/api/repos` | Create a repository |
| `DELETE` | `/api/repos/:name` | Delete a repository |
| `GET` | `/api/repos/:repo/webhooks` | List webhooks |
| `POST` | `/api/repos/:repo/webhooks` | Create a webhook |
| `DELETE` | `/api/repos/:repo/webhooks/:id` | Delete a webhook |

### Creating a Repository

```bash
curl -X POST http://localhost:3000/api/repos \
  -H "Content-Type: application/json" \
  -d '{"name": "my-repo", "description": "My new repository"}'
```

## Webhooks

Webhooks are triggered on push events and include the following headers:

- `X-Legit-Event` - Event type (e.g., `push`)
- `X-Legit-Delivery` - Unique delivery ID
- `X-Legit-Signature` - HMAC-SHA256 signature (if secret is configured)

Payload includes repository name, ref, commits, and pusher information.

## License

MIT
