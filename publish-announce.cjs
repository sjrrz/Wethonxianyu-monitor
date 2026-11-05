#!/usr/bin/env node
/* 闲鱼扫货监控 · 发布公告脚本（开发者专用）
 * 由托盘「📢 发公告」调用，把一句话推到 GitHub 仓库根的 STATUS.json。
 * 用户端程序会定时拉这个文件，读到 status=notice 就在面板顶部显示横幅。
 *
 * 用法：
 *   node publish-announce.cjs --file <含公告内容的UTF8文件路径>
 *   或 echo "公告内容" | node publish-announce.cjs --stdin
 *
 * 内容规则：第一行当标题，其余行当正文；只填一行就标题=正文=这一行。
 *
 * 依赖 config.json 里的开发者字段（只存在于开发者本机，gitignored，不打包）：
 *   "developerMode": true,
 *   "githubToken": "ghp_xxx",
 *   "githubRepo": "用户名/仓库名",
 *   "githubBranch": "main"
 */
'use strict';
const fs = require('fs');
const path = require('path');

function readConfig() {
  const cf = path.join(__dirname, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(cf, 'utf8'));
  } catch (e) {
    return {};
  }
}

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

function ok(msg) {
  console.log(JSON.stringify({ ok: true, msg: msg }));
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf('--file');
  const stdinIdx = argv.indexOf('--stdin');
  let text = '';

  if (fileIdx >= 0 && argv[fileIdx + 1]) {
    try {
      text = fs.readFileSync(argv[fileIdx + 1], 'utf8');
    } catch (e) {
      return fail('读取公告内容失败：' + e.message);
    }
  } else if (stdinIdx >= 0) {
    text = fs.readFileSync(0, 'utf8');
  } else {
    return fail('没有收到公告内容');
  }

  text = String(text || '').replace(/\uFEFF/g, '').trim();
  if (!text) return fail('公告内容为空');

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
  const title = lines[0] || '';
  const detail = lines.slice(1).join('\n');
  if (!title) return fail('公告标题为空');

  const cfg = readConfig();
  const token = String(cfg.githubToken || '').trim();
  const repo = String(cfg.githubRepo || '').trim();
  const branch = String(cfg.githubBranch || 'main').trim();

  if (!token) return fail('未配置 githubToken（在 config.json 里填你的 GitHub Token）');
  if (!repo) return fail('未配置 githubRepo（格式：用户名/仓库名）');

  const payload = {
    status: 'notice',
    title: title,
    detail: detail,
    updatedAt: new Date().toISOString(),
  };
  const contentB64 = Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8').toString('base64');
  const pathEncoded = 'STATUS.json';

  const apiBase = 'https://api.github.com/repos/' + repo + '/contents/' + pathEncoded;
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'xianyu-monitor-announce',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let sha = null;
  // 先读旧文件拿 sha（不存在则 404，当新文件处理）
  try {
    const r = await fetch(apiBase + '?ref=' + encodeURIComponent(branch), {
      method: 'GET', headers: headers, signal: AbortSignal.timeout(15000),
    });
    if (r.status === 200) {
      const j = await r.json();
      if (j && j.sha) sha = j.sha;
    } else if (r.status !== 404) {
      return fail('读取现有 STATUS.json 失败：HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    }
  } catch (e) {
    return fail('连接 GitHub 失败：' + e.message);
  }

  const body = {
    message: '📢 公告：' + title,
    content: contentB64,
    branch: branch,
  };
  if (sha) body.sha = sha;

  let putRes;
  try {
    putRes = await fetch(apiBase, {
      method: 'PUT', headers: headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return fail('提交到 GitHub 失败：' + e.message);
  }
  const putText = await putRes.text();
  if (putRes.status !== 200 && putRes.status !== 201) {
    return fail('GitHub 提交失败：HTTP ' + putRes.status + ' ' + putText.slice(0, 300));
  }

  ok('已发布到 ' + repo + '@' + branch + '（STATUS.json）');
}

main().catch(e => {
  console.log(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
  process.exit(1);
});
