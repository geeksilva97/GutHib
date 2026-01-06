import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const PORT = process.env.PORT || 3000;
const REPOS_DIR = process.env.REPOS_DIR || './repos';

// Initialize SQLite database
const db = new DatabaseSync('./legit.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT DEFAULT '',
    events TEXT DEFAULT 'push',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repo_name) REFERENCES repositories(name) ON DELETE CASCADE
  )
`);

// Ensure repos directory exists
if (!fs.existsSync(REPOS_DIR)) {
  fs.mkdirSync(REPOS_DIR, { recursive: true });
}

// Helper to encode git packet line
function packetLine(line) {
  const len = (line.length + 4).toString(16).padStart(4, '0');
  return len + line;
}

// Helper to flush packet
function flushPkt() {
  return '0000';
}

// Parse URL path
function parsePath(url) {
  const urlObj = new URL(url, 'http://localhost');
  const pathname = urlObj.pathname;

  // Match: /:repo.git/info/refs
  // Match: /:repo.git/git-upload-pack
  // Match: /:repo.git/git-receive-pack
  const match = pathname.match(/^\/([^/]+\.git)(\/.*)?$/);
  if (match) {
    return {
      repo: match[1],
      path: match[2] || '/',
      query: urlObj.searchParams
    };
  }
  return { repo: null, path: pathname, query: urlObj.searchParams };
}

// Get full path to repository
function getRepoPath(repoName) {
  return path.join(REPOS_DIR, repoName);
}

// Handle git info/refs request (discovery)
async function handleInfoRefs(req, res, repoName, service) {
  const repoPath = getRepoPath(repoName);

  if (!fs.existsSync(repoPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Repository not found');
    return;
  }

  const serviceName = service.replace('git-', '');
  res.writeHead(200, {
    'Content-Type': `application/x-git-${serviceName}-advertisement`,
    'Cache-Control': 'no-cache'
  });

  // Write service announcement
  res.write(packetLine(`# service=${service}\n`));
  res.write(flushPkt());

  // Spawn git process
  const git = spawn('git', [service.replace('git-', ''), '--stateless-rpc', '--advertise-refs', repoPath]);

  git.stdout.pipe(res);
  git.stderr.on('data', (data) => console.error(`git stderr: ${data}`));
}

// Handle git-upload-pack (fetch/clone)
async function handleUploadPack(req, res, repoName) {
  const repoPath = getRepoPath(repoName);

  if (!fs.existsSync(repoPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Repository not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-git-upload-pack-result',
    'Cache-Control': 'no-cache'
  });

  const git = spawn('git', ['upload-pack', '--stateless-rpc', repoPath]);

  req.pipe(git.stdin);
  git.stdout.pipe(res);
  git.stderr.on('data', (data) => console.error(`git stderr: ${data}`));
}

// Handle git-receive-pack (push)
async function handleReceivePack(req, res, repoName) {
  const repoPath = getRepoPath(repoName);

  if (!fs.existsSync(repoPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Repository not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-git-receive-pack-result',
    'Cache-Control': 'no-cache'
  });

  const git = spawn('git', ['receive-pack', '--stateless-rpc', repoPath]);

  req.pipe(git.stdin);
  git.stdout.pipe(res);
  git.stderr.on('data', (data) => console.error(`git stderr: ${data}`));

  // Trigger webhooks after push completes
  git.on('close', (code) => {
    if (code === 0) {
      triggerWebhooks(repoName, 'push', {
        ref: 'refs/heads/main' // simplified - real impl would parse the pack
      });
    }
  });
}

// Create a new repository
function createRepository(name, description = '') {
  const repoName = name.endsWith('.git') ? name : `${name}.git`;
  const repoPath = getRepoPath(repoName);

  if (fs.existsSync(repoPath)) {
    return { error: 'Repository already exists' };
  }

  // Create bare repository
  fs.mkdirSync(repoPath, { recursive: true });
  const result = spawn('git', ['init', '--bare', repoPath], { stdio: 'inherit' });

  // Insert into database
  const stmt = db.prepare('INSERT INTO repositories (name, description) VALUES (?, ?)');
  stmt.run(repoName, description);

  return { success: true, name: repoName };
}

// List all repositories
function listRepositories() {
  const stmt = db.prepare('SELECT * FROM repositories ORDER BY created_at DESC');
  return stmt.all();
}

// Delete a repository
function deleteRepository(name) {
  const repoName = name.endsWith('.git') ? name : `${name}.git`;
  const repoPath = getRepoPath(repoName);

  if (!fs.existsSync(repoPath)) {
    return { error: 'Repository not found' };
  }

  fs.rmSync(repoPath, { recursive: true });
  const stmt = db.prepare('DELETE FROM repositories WHERE name = ?');
  stmt.run(repoName);

  return { success: true };
}

// Get repository info from database
function getRepository(name) {
  const stmt = db.prepare('SELECT * FROM repositories WHERE name = ?');
  return stmt.get(name);
}

// Webhook CRUD operations
function createWebhook(repoName, url, secret = '') {
  const stmt = db.prepare('INSERT INTO webhooks (repo_name, url, secret) VALUES (?, ?, ?)');
  stmt.run(repoName, url, secret);
  return { success: true };
}

function listWebhooks(repoName) {
  const stmt = db.prepare('SELECT * FROM webhooks WHERE repo_name = ? ORDER BY created_at DESC');
  return stmt.all(repoName);
}

function deleteWebhook(id) {
  const stmt = db.prepare('DELETE FROM webhooks WHERE id = ?');
  stmt.run(id);
  return { success: true };
}

// Trigger webhooks for a repository
async function triggerWebhooks(repoName, event, payload) {
  const webhooks = listWebhooks(repoName);

  for (const webhook of webhooks) {
    if (!webhook.events.includes(event)) continue;

    const body = JSON.stringify({
      event,
      repository: repoName,
      timestamp: new Date().toISOString(),
      ...payload
    });

    try {
      const url = new URL(webhook.url);
      const options = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Legit-Event': event,
          'X-Legit-Delivery': Date.now().toString()
        }
      };

      if (webhook.secret) {
        const { createHmac } = await import('node:crypto');
        const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
        options.headers['X-Legit-Signature'] = `sha256=${signature}`;
      }

      const proto = url.protocol === 'https:' ? await import('node:https') : await import('node:http');

      const req = proto.request(options, (res) => {
        console.log(`Webhook ${webhook.url} responded with ${res.statusCode}`);
      });

      req.on('error', (err) => {
        console.error(`Webhook ${webhook.url} failed:`, err.message);
      });

      req.write(body);
      req.end();
    } catch (err) {
      console.error(`Webhook ${webhook.url} error:`, err.message);
    }
  }
}

// Get git info (branches, tags, commits) using spawn
function getGitInfo(repoPath) {
  return new Promise((resolve) => {
    const info = { branches: [], tags: [], commits: [] };

    // Get branches
    const branchProc = spawn('git', ['branch', '-a'], { cwd: repoPath });
    let branchOutput = '';
    branchProc.stdout.on('data', (d) => branchOutput += d);
    branchProc.on('close', () => {
      info.branches = branchOutput.split('\n')
        .map(b => b.trim().replace(/^\* /, ''))
        .filter(b => b && !b.includes('->'));

      // Get tags
      const tagProc = spawn('git', ['tag', '-l'], { cwd: repoPath });
      let tagOutput = '';
      tagProc.stdout.on('data', (d) => tagOutput += d);
      tagProc.on('close', () => {
        info.tags = tagOutput.split('\n').filter(t => t.trim());

        // Get recent commits
        const logProc = spawn('git', ['log', '--all', '--oneline', '-20'], { cwd: repoPath });
        let logOutput = '';
        logProc.stdout.on('data', (d) => logOutput += d);
        logProc.on('close', () => {
          info.commits = logOutput.split('\n').filter(c => c.trim());
          resolve(info);
        });
      });
    });
  });
}

// Render repository detail page
async function renderRepoPage(repoName) {
  const repo = getRepository(repoName);
  if (!repo) return null;

  const repoPath = getRepoPath(repoName);
  if (!fs.existsSync(repoPath)) return null;

  const gitInfo = await getGitInfo(repoPath);
  const webhooks = listWebhooks(repoName);

  const branchesList = gitInfo.branches.length
    ? gitInfo.branches.map(b => `<li>${b}</li>`).join('')
    : '<li class="empty">No branches yet</li>';

  const tagsList = gitInfo.tags.length
    ? gitInfo.tags.map(t => `<li>${t}</li>`).join('')
    : '<li class="empty">No tags yet</li>';

  const commitsList = gitInfo.commits.length
    ? gitInfo.commits.map(c => `<li><code>${c}</code></li>`).join('')
    : '<li class="empty">No commits yet</li>';

  const webhooksList = webhooks.length
    ? webhooks.map(w => `
        <li class="webhook-item">
          <code>${w.url}</code>
          <span class="webhook-meta">${w.secret ? '(with secret)' : ''} - ${w.created_at}</span>
          <button onclick="deleteWebhook(${w.id})" class="delete-btn">Delete</button>
        </li>
      `).join('')
    : '<li class="empty">No webhooks configured</li>';

  return `<!DOCTYPE html>
<html>
<head>
  <title>${repoName} - Legit</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 50px auto; padding: 20px; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    .back { margin-bottom: 20px; }
    .back a { color: #0066cc; text-decoration: none; }
    .clone-box { background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0; }
    .clone-box code { background: #e0e0e0; padding: 8px 12px; border-radius: 4px; display: block; margin-top: 10px; }
    .description { color: #666; font-size: 14px; }
    ul { list-style: none; padding: 0; }
    li { padding: 8px 12px; background: #f9f9f9; margin: 4px 0; border-radius: 4px; }
    li.empty { color: #999; font-style: italic; background: transparent; }
    code { font-family: 'SF Mono', Monaco, monospace; font-size: 13px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .webhook-form { background: #f9f9f9; padding: 15px; border-radius: 8px; margin: 15px 0; }
    .webhook-form input { padding: 8px; margin-right: 10px; border: 1px solid #ddd; border-radius: 4px; }
    .webhook-form input[type="url"] { width: 300px; }
    .webhook-form input[type="text"] { width: 150px; }
    .webhook-form button { padding: 8px 16px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; }
    .webhook-item { display: flex; align-items: center; gap: 10px; }
    .webhook-item code { flex: 1; }
    .webhook-meta { color: #888; font-size: 12px; }
    .delete-btn { padding: 4px 8px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  </style>
</head>
<body>
  <div class="back"><a href="/">&larr; Back to repositories</a></div>
  <h1>${repoName}</h1>
  <p class="description">${repo.description || 'No description'}</p>
  <p class="description">Created: ${repo.created_at}</p>

  <div class="clone-box">
    <strong>Clone this repository:</strong>
    <code>git clone http://localhost:${PORT}/${repoName}</code>
  </div>

  <div class="grid">
    <div>
      <h2>Branches</h2>
      <ul>${branchesList}</ul>
    </div>
    <div>
      <h2>Tags</h2>
      <ul>${tagsList}</ul>
    </div>
  </div>

  <h2>Recent Commits</h2>
  <ul>${commitsList}</ul>

  <h2>Webhooks</h2>
  <p class="description">Webhooks are triggered on every push to this repository.</p>
  <form class="webhook-form" method="POST" action="/api/repos/${repoName}/webhooks">
    <input type="url" name="url" placeholder="https://ci.example.com/webhook" required>
    <input type="text" name="secret" placeholder="Secret (optional)">
    <button type="submit">Add Webhook</button>
  </form>
  <ul>${webhooksList}</ul>

  <script>
    async function deleteWebhook(id) {
      if (!confirm('Delete this webhook?')) return;
      await fetch('/api/repos/${repoName}/webhooks/' + id, { method: 'DELETE' });
      location.reload();
    }
  </script>
</body>
</html>`;
}

// Simple HTML page for web UI
function renderHomePage() {
  const repos = listRepositories();
  const reposList = repos.map(r => `
    <tr>
      <td><a href="/${r.name}">${r.name}</a></td>
      <td>${r.description || '-'}</td>
      <td>${r.created_at}</td>
      <td><code>git clone http://localhost:${PORT}/${r.name}</code></td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Legit - Simple Git Server</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 50px auto; padding: 20px; }
    h1 { color: #333; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
    form { background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0; }
    input, button { padding: 10px; margin: 5px 0; font-size: 14px; }
    input[type="text"] { width: 300px; border: 1px solid #ddd; border-radius: 4px; }
    button { background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background: #0055aa; }
    .empty { color: #666; font-style: italic; }
  </style>
</head>
<body>
  <h1>Legit - Simple Git Server</h1>

  <h2>Create Repository</h2>
  <form method="POST" action="/api/repos">
    <input type="text" name="name" placeholder="repository-name" required>
    <input type="text" name="description" placeholder="Description (optional)">
    <button type="submit">Create</button>
  </form>

  <h2>Repositories</h2>
  ${repos.length === 0 ? '<p class="empty">No repositories yet. Create one above!</p>' : `
  <table>
    <tr><th>Name</th><th>Description</th><th>Created</th><th>Clone URL</th></tr>
    ${reposList}
  </table>
  `}
</body>
</html>`;
}

// Parse form data
async function parseFormData(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      resolve(Object.fromEntries(params));
    });
  });
}

// Parse JSON body
async function parseJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Main request handler
const server = http.createServer(async (req, res) => {
  const { repo, path: urlPath, query } = parsePath(req.url);

  console.log(`${req.method} ${req.url}`);

  try {
    // API routes
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderHomePage());
      return;
    }

    if (req.url === '/api/repos' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listRepositories()));
      return;
    }

    if (req.url === '/api/repos' && req.method === 'POST') {
      const contentType = req.headers['content-type'] || '';
      let data;

      if (contentType.includes('application/json')) {
        data = await parseJSON(req);
      } else {
        data = await parseFormData(req);
      }

      const result = createRepository(data.name, data.description);

      if (result.error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else {
        // Redirect to home for form submissions
        if (!contentType.includes('application/json')) {
          res.writeHead(302, { 'Location': '/' });
          res.end();
        } else {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
      }
      return;
    }

    if (req.url.startsWith('/api/repos/') && req.method === 'DELETE') {
      const repoName = req.url.replace('/api/repos/', '');
      const result = deleteRepository(repoName);
      res.writeHead(result.error ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Webhook API routes
    const webhookMatch = req.url.match(/^\/api\/repos\/([^/]+\.git)\/webhooks(\/(\d+))?$/);
    if (webhookMatch) {
      const repoName = webhookMatch[1];
      const webhookId = webhookMatch[3];

      // GET /api/repos/:repo/webhooks - list webhooks
      if (req.method === 'GET' && !webhookId) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(listWebhooks(repoName)));
        return;
      }

      // POST /api/repos/:repo/webhooks - create webhook
      if (req.method === 'POST' && !webhookId) {
        const contentType = req.headers['content-type'] || '';
        let data;
        if (contentType.includes('application/json')) {
          data = await parseJSON(req);
        } else {
          data = await parseFormData(req);
        }

        if (!data.url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'URL is required' }));
          return;
        }

        createWebhook(repoName, data.url, data.secret || '');

        if (!contentType.includes('application/json')) {
          res.writeHead(302, { 'Location': `/${repoName}` });
          res.end();
        } else {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        return;
      }

      // DELETE /api/repos/:repo/webhooks/:id - delete webhook
      if (req.method === 'DELETE' && webhookId) {
        deleteWebhook(parseInt(webhookId));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
    }

    // Git protocol routes
    if (repo) {
      // Info/refs discovery
      if (urlPath === '/info/refs') {
        const service = query.get('service');
        if (service === 'git-upload-pack' || service === 'git-receive-pack') {
          await handleInfoRefs(req, res, repo, service);
          return;
        }
      }

      // git-upload-pack (fetch/clone)
      if (urlPath === '/git-upload-pack' && req.method === 'POST') {
        await handleUploadPack(req, res, repo);
        return;
      }

      // git-receive-pack (push)
      if (urlPath === '/git-receive-pack' && req.method === 'POST') {
        await handleReceivePack(req, res, repo);
        return;
      }

      // Repository detail page (web UI)
      if (urlPath === '/' && req.method === 'GET') {
        const html = await renderRepoPage(repo);
        if (html) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
          return;
        }
      }
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (err) {
    console.error('Error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`Legit Git server running at http://localhost:${PORT}`);
  console.log(`Repositories stored in: ${path.resolve(REPOS_DIR)}`);
});
