import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const PORT = process.env.PORT || 3000;
const REPOS_DIR = process.env.REPOS_DIR || './repos';

// Initialize SQLite database
const db = new DatabaseSync('./guthib.db');
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
          'X-GutHib-Event': event,
          'X-GutHib-Delivery': Date.now().toString()
        }
      };

      if (webhook.secret) {
        const { createHmac } = await import('node:crypto');
        const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
        options.headers['X-GutHib-Signature'] = `sha256=${signature}`;
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

// Get detailed commit information
function getCommitDetails(repoPath, hash) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['show', '--format=%H%n%h%n%an%n%ae%n%at%n%s%n%b%n---BODY_END---', '--stat', hash], { cwd: repoPath });
    let output = '';
    let stderr = '';
    proc.stdout.on('data', (d) => output += d);
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || 'Commit not found'));
        return;
      }
      const lines = output.split('\n');
      const bodyEndIndex = lines.findIndex(l => l === '---BODY_END---');
      const commit = {
        hash: lines[0],
        shortHash: lines[1],
        author: lines[2],
        email: lines[3],
        date: new Date(parseInt(lines[4]) * 1000).toISOString(),
        subject: lines[5],
        body: lines.slice(6, bodyEndIndex).join('\n').trim(),
        stats: lines.slice(bodyEndIndex + 2).filter(l => l.trim()).join('\n')
      };
      resolve(commit);
    });
  });
}

// Get commit diff (the actual file changes)
function getCommitDiff(repoPath, hash) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['show', '--format=', '-p', hash], { cwd: repoPath });
    let output = '';
    let stderr = '';
    proc.stdout.on('data', (d) => output += d);
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || 'Commit not found'));
        return;
      }
      resolve(output);
    });
  });
}

// Get list of files changed in a commit
function getCommitFiles(repoPath, hash) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['show', '--name-status', '--format=', hash], { cwd: repoPath });
    let output = '';
    let stderr = '';
    proc.stdout.on('data', (d) => output += d);
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || 'Commit not found'));
        return;
      }
      const files = output.split('\n')
        .filter(l => l.trim())
        .map(line => {
          const [status, ...pathParts] = line.split('\t');
          return { status, path: pathParts.join('\t') };
        });
      resolve(files);
    });
  });
}

// Get file tree at a specific ref
function getFileTree(repoPath, ref) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['ls-tree', '-r', '--name-only', ref], { cwd: repoPath });
    let output = '';
    let stderr = '';
    proc.stdout.on('data', (d) => output += d);
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || 'Ref not found'));
        return;
      }
      const files = output.split('\n').filter(f => f.trim());
      resolve(files);
    });
  });
}

// Get file content at a specific ref
function getFileContent(repoPath, ref, filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['show', `${ref}:${filePath}`], { cwd: repoPath });
    let output = '';
    let stderr = '';
    proc.stdout.on('data', (d) => output += d);
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || 'File not found'));
        return;
      }
      resolve(output);
    });
  });
}

// Compare two commits
function getCommitComparison(repoPath, base, head) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['diff', base, head], { cwd: repoPath });
    let output = '';
    let stderr = '';
    proc.stdout.on('data', (d) => output += d);
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || 'Comparison failed'));
        return;
      }
      resolve(output);
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
    ? gitInfo.commits.map(c => {
        const [hash, ...msgParts] = c.split(' ');
        const msg = msgParts.join(' ');
        return `<li><a href="/${repoName}/commit/${hash}" class="commit-link"><code class="commit-hash">${hash}</code> <span class="commit-msg">${msg}</span></a></li>`;
      }).join('')
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
  <title>${repoName} - GutHib</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 50px auto; padding: 20px; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    .back { margin-bottom: 20px; }
    .back a { color: #0066cc; text-decoration: none; }
    .clone-box { background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0; }
    .clone-box code { background: #e0e0e0; padding: 8px 12px; border-radius: 4px; display: block; margin-top: 10px; }
    .browse-box { margin: 15px 0; }
    .browse-link { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; color: #0066cc; text-decoration: none; font-size: 14px; }
    .browse-link:hover { background: #f0f6fc; border-color: #0066cc; }
    .description { color: #666; font-size: 14px; }
    ul { list-style: none; padding: 0; }
    li { padding: 8px 12px; background: #f9f9f9; margin: 4px 0; border-radius: 4px; }
    li.empty { color: #999; font-style: italic; background: transparent; }
    code { font-family: 'SF Mono', Monaco, monospace; font-size: 13px; }
    .commit-link { display: flex; align-items: center; gap: 10px; text-decoration: none; color: inherit; }
    .commit-link:hover { background: #f0f6fc; margin: -8px -12px; padding: 8px 12px; border-radius: 4px; }
    .commit-link .commit-hash { color: #0066cc; }
    .commit-link .commit-msg { color: #333; }
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
    .compare-box { background: #f6f8fa; padding: 15px 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e1e4e8; }
    .compare-box h3 { margin: 0 0 12px 0; font-size: 14px; color: #333; }
    .compare-box form { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .compare-box select { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; font-family: 'SF Mono', Monaco, monospace; max-width: 280px; }
    .compare-box .arrow { color: #666; font-size: 16px; }
    .compare-box button { padding: 8px 16px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; }
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

  ${gitInfo.commits.length > 0 ? `
  <div class="browse-box">
    <a href="/${repoName}/tree/${gitInfo.commits[0].split(' ')[0]}" class="browse-link">Browse files at latest commit</a>
  </div>
  ` : ''}

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

  ${gitInfo.commits.length >= 2 ? `
  <div class="compare-box">
    <h3>Compare commits</h3>
    <form action="/${repoName}/compare/" method="GET" onsubmit="return handleCompare(this)">
      <select name="base" id="compare-base">
        ${gitInfo.commits.map(c => {
          const [hash, ...msg] = c.split(' ');
          return `<option value="${hash}">${hash} - ${msg.join(' ').substring(0, 40)}</option>`;
        }).join('')}
      </select>
      <span class="arrow">&rarr;</span>
      <select name="head" id="compare-head">
        ${gitInfo.commits.map(c => {
          const [hash, ...msg] = c.split(' ');
          return `<option value="${hash}">${hash} - ${msg.join(' ').substring(0, 40)}</option>`;
        }).join('')}
      </select>
      <button type="submit">Compare</button>
    </form>
  </div>
  <script>
    function handleCompare(form) {
      const base = form.base.value;
      const head = form.head.value;
      if (base === head) {
        alert('Please select different commits to compare');
        return false;
      }
      window.location.href = '/${repoName}/compare/' + base + '...' + head;
      return false;
    }
  </script>
  ` : ''}

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

    async function deleteRepository() {
      if (!confirm('Are you sure you want to delete this repository? This action cannot be undone.')) return;
      const res = await fetch('/api/repos/${repoName}', { method: 'DELETE' });
      if (res.ok) {
        window.location.href = '/';
      } else {
        alert('Failed to delete repository');
      }
    }
  </script>

  <h2 style="color: #c00; margin-top: 40px;">Danger Zone</h2>
  <div style="border: 1px solid #c00; border-radius: 4px; padding: 15px;">
    <p style="margin: 0 0 10px 0;">Once you delete a repository, there is no going back.</p>
    <button onclick="deleteRepository()" style="background: #c00; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Delete Repository</button>
  </div>
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
  <title>GutHib - Simple Git Server</title>
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
  <h1>GutHib - Simple Git Server</h1>

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

// Escape HTML to prevent XSS
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Format diff with syntax highlighting
function formatDiff(diff) {
  if (!diff) return '<p class="empty">No changes</p>';

  const lines = diff.split('\n');
  let html = '';
  let inFile = false;
  let currentFile = '';

  for (const line of lines) {
    const escaped = escapeHtml(line);

    if (line.startsWith('diff --git')) {
      if (inFile) html += '</pre></div>';
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : '';
      html += `<div class="diff-file"><div class="diff-file-header">${escapeHtml(currentFile)}</div><pre class="diff-content">`;
      inFile = true;
    } else if (line.startsWith('@@')) {
      html += `<span class="diff-hunk">${escaped}</span>\n`;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      html += `<span class="diff-add">${escaped}</span>\n`;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      html += `<span class="diff-del">${escaped}</span>\n`;
    } else if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      html += `<span class="diff-meta">${escaped}</span>\n`;
    } else if (inFile) {
      html += escaped + '\n';
    }
  }

  if (inFile) html += '</pre></div>';
  return html || '<p class="empty">No changes</p>';
}

// Get status label for file changes
function getStatusLabel(status) {
  const labels = {
    'A': { text: 'Added', class: 'status-added' },
    'M': { text: 'Modified', class: 'status-modified' },
    'D': { text: 'Deleted', class: 'status-deleted' },
    'R': { text: 'Renamed', class: 'status-renamed' },
    'C': { text: 'Copied', class: 'status-copied' }
  };
  return labels[status] || { text: status, class: 'status-unknown' };
}

// Render commit detail page
async function renderCommitPage(repoName, hash) {
  const repo = getRepository(repoName);
  if (!repo) return null;

  const repoPath = getRepoPath(repoName);
  if (!fs.existsSync(repoPath)) return null;

  try {
    const [commit, files, diff] = await Promise.all([
      getCommitDetails(repoPath, hash),
      getCommitFiles(repoPath, hash),
      getCommitDiff(repoPath, hash)
    ]);

    const filesList = files.map(f => {
      const status = getStatusLabel(f.status);
      return `<li class="file-item">
        <span class="file-status ${status.class}">${status.text}</span>
        <span class="file-path">${escapeHtml(f.path)}</span>
      </li>`;
    }).join('');

    const formattedDiff = formatDiff(diff);
    const formattedDate = new Date(commit.date).toLocaleString();

    return `<!DOCTYPE html>
<html>
<head>
  <title>${commit.shortHash} - ${repoName} - GutHib</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1100px; margin: 50px auto; padding: 20px; background: #fafafa; }
    h1 { color: #333; font-size: 20px; margin-bottom: 5px; }
    .back { margin-bottom: 20px; }
    .back a { color: #0066cc; text-decoration: none; }
    .commit-info { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e1e4e8; }
    .commit-hash { font-family: 'SF Mono', Monaco, monospace; color: #666; font-size: 14px; }
    .commit-subject { font-size: 18px; font-weight: 600; margin: 10px 0; }
    .commit-body { color: #555; white-space: pre-wrap; margin: 15px 0; padding: 15px; background: #f6f8fa; border-radius: 6px; }
    .commit-meta { color: #666; font-size: 14px; }
    .commit-meta strong { color: #333; }
    .files-section { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e1e4e8; }
    .files-section h2 { margin-top: 0; font-size: 16px; color: #333; }
    .file-list { list-style: none; padding: 0; margin: 0; }
    .file-item { padding: 8px 12px; border-bottom: 1px solid #eee; display: flex; align-items: center; gap: 12px; }
    .file-item:last-child { border-bottom: none; }
    .file-status { font-size: 12px; padding: 2px 8px; border-radius: 4px; font-weight: 500; min-width: 70px; text-align: center; }
    .status-added { background: #d4edda; color: #155724; }
    .status-modified { background: #fff3cd; color: #856404; }
    .status-deleted { background: #f8d7da; color: #721c24; }
    .status-renamed { background: #cce5ff; color: #004085; }
    .status-copied { background: #e2e3e5; color: #383d41; }
    .file-path { font-family: 'SF Mono', Monaco, monospace; font-size: 13px; }
    .diff-section { background: white; border-radius: 8px; border: 1px solid #e1e4e8; overflow: hidden; }
    .diff-section h2 { margin: 0; padding: 15px 20px; font-size: 16px; color: #333; border-bottom: 1px solid #e1e4e8; background: #f6f8fa; }
    .diff-file { border-bottom: 1px solid #e1e4e8; }
    .diff-file:last-child { border-bottom: none; }
    .diff-file-header { background: #f1f8ff; padding: 10px 15px; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; font-weight: 600; color: #0366d6; border-bottom: 1px solid #e1e4e8; }
    .diff-content { margin: 0; padding: 0; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; line-height: 1.5; overflow-x: auto; background: #fff; }
    .diff-content span { display: block; padding: 0 15px; white-space: pre; }
    .diff-add { background: #e6ffec; color: #22863a; }
    .diff-del { background: #ffebe9; color: #cb2431; }
    .diff-hunk { background: #f1f8ff; color: #0366d6; padding: 8px 15px !important; }
    .diff-meta { color: #6a737d; }
    .empty { color: #666; font-style: italic; padding: 20px; text-align: center; }
    .nav-links { display: flex; gap: 15px; margin-top: 15px; }
    .nav-links a { color: #0066cc; text-decoration: none; font-size: 14px; }
  </style>
</head>
<body>
  <div class="back">
    <a href="/${repoName}">&larr; Back to ${repoName}</a>
  </div>

  <div class="commit-info">
    <span class="commit-hash">${commit.hash}</span>
    <h1 class="commit-subject">${escapeHtml(commit.subject)}</h1>
    ${commit.body ? `<div class="commit-body">${escapeHtml(commit.body)}</div>` : ''}
    <div class="commit-meta">
      <strong>${escapeHtml(commit.author)}</strong> &lt;${escapeHtml(commit.email)}&gt; committed on ${formattedDate}
    </div>
    <div class="nav-links">
      <a href="/${repoName}/tree/${commit.hash}">Browse files at this commit</a>
    </div>
  </div>

  <div class="files-section">
    <h2>Files changed (${files.length})</h2>
    <ul class="file-list">${filesList || '<li class="empty">No files changed</li>'}</ul>
  </div>

  <div class="diff-section">
    <h2>Diff</h2>
    ${formattedDiff}
  </div>
</body>
</html>`;
  } catch (err) {
    return null;
  }
}

// Render file tree page
async function renderTreePage(repoName, ref) {
  const repo = getRepository(repoName);
  if (!repo) return null;

  const repoPath = getRepoPath(repoName);
  if (!fs.existsSync(repoPath)) return null;

  try {
    const files = await getFileTree(repoPath, ref);

    // Organize files into directory structure
    const tree = {};
    for (const file of files) {
      const parts = file.split('/');
      let current = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
          current[part] = { type: 'file', path: file };
        } else {
          if (!current[part]) current[part] = { type: 'dir', children: {} };
          current = current[part].children;
        }
      }
    }

    // Render tree recursively
    function renderTree(node, depth = 0) {
      let html = '';
      const entries = Object.entries(node).sort((a, b) => {
        if (a[1].type !== b[1].type) return a[1].type === 'dir' ? -1 : 1;
        return a[0].localeCompare(b[0]);
      });

      for (const [name, item] of entries) {
        const indent = '  '.repeat(depth);
        if (item.type === 'dir') {
          html += `<li class="tree-dir">${indent}<span class="dir-icon">+</span> ${escapeHtml(name)}</li>`;
          html += renderTree(item.children, depth + 1);
        } else {
          html += `<li class="tree-file">${indent}<a href="/${repoName}/blob/${ref}/${item.path}">${escapeHtml(name)}</a></li>`;
        }
      }
      return html;
    }

    const treeHtml = renderTree(tree);

    return `<!DOCTYPE html>
<html>
<head>
  <title>Files at ${ref.substring(0, 7)} - ${repoName} - GutHib</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 50px auto; padding: 20px; background: #fafafa; }
    h1 { color: #333; font-size: 18px; }
    .back { margin-bottom: 20px; }
    .back a { color: #0066cc; text-decoration: none; }
    .ref-badge { background: #f1f8ff; color: #0366d6; padding: 4px 10px; border-radius: 4px; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; }
    .tree-container { background: white; border: 1px solid #e1e4e8; border-radius: 8px; overflow: hidden; }
    .tree-header { background: #f6f8fa; padding: 12px 16px; border-bottom: 1px solid #e1e4e8; font-size: 14px; }
    .tree-list { list-style: none; padding: 0; margin: 0; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; }
    .tree-list li { padding: 8px 16px; border-bottom: 1px solid #eee; }
    .tree-list li:last-child { border-bottom: none; }
    .tree-dir { color: #0366d6; font-weight: 500; }
    .tree-file a { color: #24292e; text-decoration: none; }
    .tree-file a:hover { color: #0366d6; text-decoration: underline; }
    .dir-icon { color: #6a737d; margin-right: 4px; }
    .empty { color: #666; font-style: italic; padding: 20px; text-align: center; }
  </style>
</head>
<body>
  <div class="back">
    <a href="/${repoName}">&larr; Back to ${repoName}</a>
  </div>

  <h1>Files <span class="ref-badge">${escapeHtml(ref.substring(0, 12))}</span></h1>

  <div class="tree-container">
    <div class="tree-header">${files.length} files</div>
    <ul class="tree-list">
      ${treeHtml || '<li class="empty">No files in this commit</li>'}
    </ul>
  </div>
</body>
</html>`;
  } catch (err) {
    return null;
  }
}

// Render file content page
async function renderBlobPage(repoName, ref, filePath) {
  const repo = getRepository(repoName);
  if (!repo) return null;

  const repoPath = getRepoPath(repoName);
  if (!fs.existsSync(repoPath)) return null;

  try {
    const content = await getFileContent(repoPath, ref, filePath);
    const lines = content.split('\n');
    const lineNumbers = lines.map((_, i) => i + 1).join('\n');

    return `<!DOCTYPE html>
<html>
<head>
  <title>${filePath} - ${repoName} - GutHib</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1100px; margin: 50px auto; padding: 20px; background: #fafafa; }
    h1 { color: #333; font-size: 16px; font-weight: normal; }
    h1 code { background: #f1f8ff; padding: 4px 8px; border-radius: 4px; }
    .back { margin-bottom: 20px; }
    .back a { color: #0066cc; text-decoration: none; }
    .ref-badge { background: #f1f8ff; color: #0366d6; padding: 4px 10px; border-radius: 4px; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; margin-left: 10px; }
    .file-container { background: white; border: 1px solid #e1e4e8; border-radius: 8px; overflow: hidden; }
    .file-header { background: #f6f8fa; padding: 12px 16px; border-bottom: 1px solid #e1e4e8; font-size: 14px; display: flex; justify-content: space-between; }
    .file-content { display: flex; overflow-x: auto; }
    .line-numbers { padding: 12px 10px; background: #f6f8fa; text-align: right; user-select: none; border-right: 1px solid #e1e4e8; color: #6a737d; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; line-height: 1.5; white-space: pre; }
    .code { padding: 12px 16px; margin: 0; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; line-height: 1.5; white-space: pre; flex: 1; }
  </style>
</head>
<body>
  <div class="back">
    <a href="/${repoName}/tree/${ref}">&larr; Back to file tree</a>
  </div>

  <h1><code>${escapeHtml(filePath)}</code> <span class="ref-badge">${escapeHtml(ref.substring(0, 12))}</span></h1>

  <div class="file-container">
    <div class="file-header">
      <span>${lines.length} lines</span>
    </div>
    <div class="file-content">
      <div class="line-numbers">${lineNumbers}</div>
      <pre class="code">${escapeHtml(content)}</pre>
    </div>
  </div>
</body>
</html>`;
  } catch (err) {
    return null;
  }
}

// Render commit comparison page
async function renderComparePage(repoName, base, head) {
  const repo = getRepository(repoName);
  if (!repo) return null;

  const repoPath = getRepoPath(repoName);
  if (!fs.existsSync(repoPath)) return null;

  try {
    const diff = await getCommitComparison(repoPath, base, head);
    const formattedDiff = formatDiff(diff);

    return `<!DOCTYPE html>
<html>
<head>
  <title>Comparing ${base.substring(0, 7)}...${head.substring(0, 7)} - ${repoName} - GutHib</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1100px; margin: 50px auto; padding: 20px; background: #fafafa; }
    h1 { color: #333; font-size: 18px; }
    .back { margin-bottom: 20px; }
    .back a { color: #0066cc; text-decoration: none; }
    .compare-header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e1e4e8; }
    .compare-refs { display: flex; align-items: center; gap: 10px; }
    .ref-badge { background: #f1f8ff; color: #0366d6; padding: 6px 12px; border-radius: 4px; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; }
    .arrow { color: #6a737d; font-size: 18px; }
    .diff-section { background: white; border-radius: 8px; border: 1px solid #e1e4e8; overflow: hidden; }
    .diff-section h2 { margin: 0; padding: 15px 20px; font-size: 16px; color: #333; border-bottom: 1px solid #e1e4e8; background: #f6f8fa; }
    .diff-file { border-bottom: 1px solid #e1e4e8; }
    .diff-file:last-child { border-bottom: none; }
    .diff-file-header { background: #f1f8ff; padding: 10px 15px; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; font-weight: 600; color: #0366d6; border-bottom: 1px solid #e1e4e8; }
    .diff-content { margin: 0; padding: 0; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; line-height: 1.5; overflow-x: auto; background: #fff; }
    .diff-content span { display: block; padding: 0 15px; white-space: pre; }
    .diff-add { background: #e6ffec; color: #22863a; }
    .diff-del { background: #ffebe9; color: #cb2431; }
    .diff-hunk { background: #f1f8ff; color: #0366d6; padding: 8px 15px !important; }
    .diff-meta { color: #6a737d; }
    .empty { color: #666; font-style: italic; padding: 20px; text-align: center; }
  </style>
</head>
<body>
  <div class="back">
    <a href="/${repoName}">&larr; Back to ${repoName}</a>
  </div>

  <div class="compare-header">
    <h1>Comparing changes</h1>
    <div class="compare-refs">
      <span class="ref-badge">${escapeHtml(base.substring(0, 12))}</span>
      <span class="arrow">&rarr;</span>
      <span class="ref-badge">${escapeHtml(head.substring(0, 12))}</span>
    </div>
  </div>

  <div class="diff-section">
    <h2>Diff</h2>
    ${formattedDiff}
  </div>
</body>
</html>`;
  } catch (err) {
    return null;
  }
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

    // Webhook API routes (must be before repo DELETE route)
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

    // DELETE /api/repos/:repo - delete repository
    if (req.url.startsWith('/api/repos/') && req.method === 'DELETE') {
      const repoName = req.url.replace('/api/repos/', '');
      const result = deleteRepository(repoName);
      res.writeHead(result.error ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
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

      // Commit detail page
      const commitMatch = urlPath.match(/^\/commit\/([a-f0-9]+)$/i);
      if (commitMatch && req.method === 'GET') {
        const html = await renderCommitPage(repo, commitMatch[1]);
        if (html) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
          return;
        }
      }

      // File tree page
      const treeMatch = urlPath.match(/^\/tree\/([a-f0-9]+|[^/]+)$/i);
      if (treeMatch && req.method === 'GET') {
        const html = await renderTreePage(repo, treeMatch[1]);
        if (html) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
          return;
        }
      }

      // File content page
      const blobMatch = urlPath.match(/^\/blob\/([a-f0-9]+|[^/]+)\/(.+)$/i);
      if (blobMatch && req.method === 'GET') {
        const html = await renderBlobPage(repo, blobMatch[1], blobMatch[2]);
        if (html) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
          return;
        }
      }

      // Commit comparison page
      const compareMatch = urlPath.match(/^\/compare\/([a-f0-9]+)\.\.\.([a-f0-9]+)$/i);
      if (compareMatch && req.method === 'GET') {
        const html = await renderComparePage(repo, compareMatch[1], compareMatch[2]);
        if (html) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
          return;
        }
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
  console.log(`GutHib Git server running at http://localhost:${PORT}`);
  console.log(`Repositories stored in: ${path.resolve(REPOS_DIR)}`);
});
