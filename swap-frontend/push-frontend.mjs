// Temporary push script: delete after running.
// Pushes cfoswap-react/ to Cfoswap/cfoswap-dex as swap-frontend/ via the Git
// Database REST API (api.github.com is reachable where github.com git transport
// is blocked). Token comes from GH_PAT env var and is never written to disk.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep, posix } from 'path';

const TOKEN = process.env.GH_PAT;
if (!TOKEN) { console.error('GH_PAT env var required'); process.exit(1); }
const OWNER = 'Cfoswap';
const REPO = 'cfoswap-dex';
const SRC = 'cfoswap-react';            // local folder
const DEST_PREFIX = 'swap-frontend';   // path prefix inside the repo
const BRANCH = 'main';
const COMMIT_MSG = 'feat: swap frontend';

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.idea', '.vscode']);
const EXCLUDE_FILE_RE = /(^|[\\/])(\.env(\.\w+)?|.*\.log|.*\.orig)$/;

const api = async (method, path, body) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 404) return { __notFound: true, status: 404 };
      if (!res.ok) {
        const text = await res.text();
        if (res.status >= 500 && attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
        throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      }
      return await res.json().catch(() => ({}));
    } catch (e) {
      if (attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw e;
    }
  }
};

// 1. Walk source files
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      walk(full);
    } else if (st.isFile()) {
      if (EXCLUDE_FILE_RE.test(full)) { console.log('skip:', relative(SRC, full)); continue; }
      files.push(full);
    }
  }
};
walk(SRC);
console.log(`Files to push: ${files.length}`);

// 2. Auth + repo check
const me = await api('GET', '/user');
console.log('Authenticated as:', me.login);
if (me.login && me.login.toLowerCase() !== 'cfoswap') {
  console.warn(`WARNING: token account is "${me.login}", expected Cfoswap`);
}
const repoInfo = await api('GET', `/repos/${OWNER}/${REPO}`);
if (repoInfo.__notFound) { console.error('Repo not visible to this token (check access/scopes)'); process.exit(1); }
console.log('Repo:', repoInfo.full_name, 'default branch:', repoInfo.default_branch);

// 3. Current main ref (if any)
let parentSha = null;
let baseTreeSha = null;
const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
if (!ref.__notFound) {
  parentSha = ref.object.sha;
  const commit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
  baseTreeSha = commit.tree.sha;
  console.log('Existing main:', parentSha.slice(0, 7), 'base tree:', baseTreeSha.slice(0, 7));
} else {
  console.log('No main branch yet: creating root commit.');
}

// 4. Create blobs (bounded concurrency)
const CONC = 8;
const treeEntries = new Array(files.length);
let idx = 0;
let done = 0;
const worker = async () => {
  while (idx < files.length) {
    const i = idx++;
    const full = files[i];
    const repoPath = `${DEST_PREFIX}/${relative(SRC, full).split(sep).join(posix.sep)}`;
    const content = readFileSync(full).toString('base64');
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content, encoding: 'base64' });
    treeEntries[i] = { path: repoPath, mode: '100644', type: 'blob', sha: blob.sha };
    done++;
    if (done % 25 === 0) console.log(`blobs: ${done}/${files.length}`);
  }
};
await Promise.all(Array.from({ length: CONC }, worker));
console.log('All blobs created:', treeEntries.length);

// 5. Tree: chunk at 300 entries per call, chaining each chunk onto the previous
// tree so earlier entries are preserved.
let finalTreeSha = baseTreeSha;
const chunks = Math.ceil(treeEntries.length / 300);
for (let c = 0; c < chunks; c++) {
  const chunk = treeEntries.slice(c * 300, (c + 1) * 300);
  const t = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    ...(finalTreeSha ? { base_tree: finalTreeSha } : {}),
    tree: chunk,
  });
  finalTreeSha = t.sha;
  console.log(`tree chunk ${c + 1}/${chunks} -> ${finalTreeSha.slice(0, 7)} (${chunk.length} entries)`);
}

// 6. Commit
const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message: COMMIT_MSG,
  tree: finalTreeSha,
  ...(parentSha ? { parents: [parentSha] } : {}),
});
console.log('Commit:', commit.sha);

// 7. Update/create branch ref
if (parentSha) {
  await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha,
    force: false,
  });
} else {
  await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, {
    ref: `refs/heads/${BRANCH}`,
    sha: commit.sha,
  });
}
console.log(`DONE: https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
