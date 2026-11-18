const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function normalizePath(file) {
  return String(file).replaceAll('\\', '/').replace(/^\.\//, '');
}

function add(findings, file, rule, line = null) {
  findings.push({ file: normalizePath(file), rule, ...(line ? { line } : {}) });
}

function isBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function isSafeEndpoint(value) {
  const normalized = value.trim().replace(/^['"]|['";,]$/g, '').toLowerCase();
  const separator = normalized.lastIndexOf(':');
  const host = separator >= 0 ? normalized.slice(0, separator) : normalized;
  return !normalized
    || host === 'localhost'
    || host === '127.0.0.1'
    || host === '0.0.0.0'
    || host === 'example.com'
    || host.endsWith('.example.com')
    || host.endsWith('.invalid')
    || normalized.includes('<')
    || normalized.includes('${');
}

function isSafePersonalName(value) {
  const normalized = value.trim().replace(/^['"]|['";,]$/g, '');
  if (!normalized || normalized.includes('<') || normalized.includes('${')) return true;
  if (/[.()[\]{}]/.test(normalized)) return true;
  return new Set(['assistant', 'minebot', 'samplebot', 'sampleplayer', 'exampleplayer', 'player', 'world', '示例伙伴', '示例用户', '示例世界']).has(normalized.toLowerCase());
}

function scanPath(findings, file) {
  const lower = file.toLowerCase();
  if (/(^|\/)(?:world|world_nether|world_the_end|saves|playerdata|server-workspace)(\/|$)/.test(lower)
    || /(^|\/)(?:level\.dat|usercache\.json|ops\.json|whitelist\.json)$/.test(lower)) {
    add(findings, file, 'world-data');
  }
  if (/(^|\/)(?:skins?\/.*|[^/]*(?:skin|avatar|portrait|companion|character)[^/]*)\.(?:png|jpe?g|webp)$/i.test(file)) {
    add(findings, file, 'personal-skin-asset');
  }
  if (/(^|\/)(?:logs?|cache|crash-reports?)(\/|$)/.test(lower) || /\.log$/i.test(file)) {
    add(findings, file, 'runtime-artifact');
  }
  if (/(^|\/)(?:\.env(?:\..+)?|credentials?\.json|secrets?\.json|keys?\.json)$/.test(lower)
    || /\.(?:pem|pfx|p12|jks|keystore)$/i.test(file)) {
    add(findings, file, 'credential-file');
  }
}

function scanContent(findings, file, content) {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const pathCheckLine = line
      .replace(/[A-Za-z]:[\\/]Users[\\/]<[^>]+>[\\/][^\s`"']*/gi, '')
      .replace(/[A-Za-z]:[\\/]<[^>]+>[\\/][^\s`"']*/gi, '');

    if (/(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?:[^\\/\s<>]+[\\/])+[^\s`"']*/.test(pathCheckLine)
      || /\/(?:Users|home)\/(?!<[^>]+>)[^/\s]+\//.test(pathCheckLine)) {
      add(findings, file, 'absolute-user-path', lineNumber);
    }

    const endpointPattern = /\b(?:voice_host|gameAddress|voiceAddress|publicAddress|publicHost|serverAddress|frpAddress|frpHost|tunnelAddress|tunnelHost)["']?\s*[:=]\s*["']?([A-Za-z0-9.-]+:\d{2,5})/gi;
    for (const endpoint of line.matchAll(endpointPattern)) {
      if (!isSafeEndpoint(endpoint[1])) add(findings, file, 'filled-network-endpoint', lineNumber);
    }

    const quotedNamePattern = /\b(?:nickname|playerName|worldName|botName|personaName)["']?\s*[:=]\s*(["'])([^"']+)\1/gi;
    for (const name of line.matchAll(quotedNamePattern)) {
      if (!isSafePersonalName(name[2])) add(findings, file, 'filled-personal-name', lineNumber);
    }
    const bareName = line.match(/^\s*(?:nickname|playerName|worldName|botName|personaName)\s*=\s*([^\s#;]+)\s*$/i);
    if (bareName && !isSafePersonalName(bareName[1])) {
      add(findings, file, 'filled-personal-name', lineNumber);
    }
  }
}

function scanBuffer(findings, file, buffer) {
  scanPath(findings, file);
  if (!isBinary(buffer)) scanContent(findings, file, buffer.toString('utf8'));
}

function deduplicate(findings) {
  const unique = new Map();
  for (const finding of findings) unique.set(`${finding.rule}\0${finding.file}\0${finding.line || 0}`, finding);
  return [...unique.values()].sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || (a.line || 0) - (b.line || 0));
}

function scanFiles(root, files) {
  const findings = [];
  const resolvedRoot = path.resolve(root);
  for (const originalFile of files) {
    const file = normalizePath(originalFile);
    const target = path.resolve(root, file);
    if (!target.startsWith(`${resolvedRoot}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) continue;
    scanBuffer(findings, file, fs.readFileSync(target));
  }
  return deduplicate(findings);
}

function git(root, args, options = {}) {
  const encoding = Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8';
  return execFileSync('git', ['-C', root, ...args], { encoding, maxBuffer: 256 * 1024 * 1024 });
}

function trackedFiles(root) {
  return git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
}

function scanHistory(root) {
  const findings = [];
  const seen = new Set();
  const commits = git(root, ['rev-list', '--all']).split(/\r?\n/).filter(Boolean);

  for (const commit of commits) {
    const records = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]).split('\0').filter(Boolean);
    for (const record of records) {
      const parsed = record.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/s);
      if (!parsed) continue;
      const [, objectId, file] = parsed;
      const identity = `${objectId}\0${file}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const buffer = git(root, ['cat-file', 'blob', objectId], { encoding: null });
      scanBuffer(findings, file, buffer);
    }
  }
  return deduplicate(findings);
}

function scanRepository(root) {
  return deduplicate([...scanHistory(root), ...scanFiles(root, trackedFiles(root))]);
}

function formatFinding(finding, index) {
  const locationId = crypto.createHash('sha256').update(finding.file).digest('hex').slice(0, 12);
  return `- ${finding.rule}: item-${index + 1}-${locationId}${finding.line ? ` line-${finding.line}` : ''}`;
}

function runCli(root = process.cwd()) {
  const findings = scanRepository(root);
  if (!findings.length) {
    console.log('privacy-scan: clean');
    return 0;
  }
  console.error(`privacy-scan: blocked (${findings.length} finding${findings.length === 1 ? '' : 's'})`);
  findings.forEach((finding, index) => console.error(formatFinding(finding, index)));
  console.error('Run locally with the scanner API to inspect exact paths; public logs intentionally redact them.');
  return 1;
}

if (require.main === module) process.exitCode = runCli();

module.exports = { formatFinding, scanFiles, scanHistory, scanRepository, trackedFiles, runCli };
