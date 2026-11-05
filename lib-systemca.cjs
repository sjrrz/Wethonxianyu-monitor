/* 让 Node 的 fetch 信任 Windows 系统证书库
 *
 * 背景：程序里所有出网请求（Bark 推送、GitHub 公告）都走 Node 全局 fetch，
 * 它默认只认 Node 自带的 Mozilla 根证书。一旦用户机器上装了任何「加速器」
 * （Steam++ / 各种 VPN 客户端）或企业代理，它们会给 HTTPS 换成自签根证书并
 * 塞进 Windows 证书库 —— curl / 浏览器 / PowerShell 都信，只有 Node 不信，
 * 报 "unable to verify the first certificate"，推送全部失败。
 *
 * Node 24 提供 tls.getCACertificates('system') / tls.setDefaultCACertificates()，
 * 可以在运行时把系统证书库合并进默认 CA 列表。必须在任何 fetch 之前调用。
 *
 * 这里只在「能读到系统证书库」时合并，读不到就静默跳过（老版本 Node / 非 Windows）。
 */
'use strict';
const tls = require('tls');

let patched = false;
try {
  if (typeof tls.getCACertificates === 'function' && typeof tls.setDefaultCACertificates === 'function') {
    const sys = tls.getCACertificates('system');
    if (Array.isArray(sys) && sys.length) {
      // 系统证书 + Node 自带的一起用：只用系统的会漏掉某些公共根证书
      let bundled = [];
      try { bundled = tls.getCACertificates('bundled') || []; } catch (e) { bundled = []; }
      const merged = Array.from(new Set(bundled.concat(sys)));
      tls.setDefaultCACertificates(merged);
      patched = true;
    }
  }
} catch (e) {
  patched = false;
}

module.exports = { patched: patched };
