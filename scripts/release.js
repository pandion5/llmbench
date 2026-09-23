'use strict';
// 릴리스 묶음 생성. 사용: node scripts/release.js <버전> [--notes "내용"] [--publish]
//  - package.json version 갱신
//  - dist/llmbench-update-<버전>.zip (src, package.json, README.md, CONTRACT.md, start.bat)
//  - dist/llmbench-portable-<버전>.zip (@electron/packager로 만든 llmbench.exe 폴더. 처음 설치용)
//  - dist/update.json (version, zipUrl, sha256, notes, date)
//  - --publish: gh release create v<버전> 로 GitHub Release에 올린다. 저장소는 REPO.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = 'pandion5/llmbench';
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
// git-bash의 GNU tar는 E:\ 경로를 원격 호스트로 오해하고 zip도 못 만든다. 윈도우 내장 bsdtar를 쓴다.
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

const args = process.argv.slice(2);
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
if (!version) {
  console.error('버전을 준다. 예: node scripts/release.js 0.2.1 --notes "튜닝 모드 추가" --publish');
  process.exit(1);
}
const notesIdx = args.indexOf('--notes');
const notes = notesIdx >= 0 ? args[notesIdx + 1] || '' : '';
const publish = args.includes('--publish');

function sh(file, argv, opts = {}) {
  const r = spawnSync(file, argv, { cwd: ROOT, stdio: 'inherit', shell: false, ...opts });
  if (r.status !== 0) {
    console.error(`${file} ${argv.join(' ')} 실패 (종료코드 ${r.status})`);
    process.exit(r.status || 1);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// package.json 버전 갱신
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`package.json version = ${version}`);

// dist 폴더 자체는 탐색기가 열고 있으면 못 지운다. 안에 든 것만 치운다.
// 이 스크립트가 만드는 것만 지운다. 클라이언트를 dist 안에 풀어 쓰던 PC에서 앱과 workspace가 같이 지워진 적이 있다.
fs.mkdirSync(DIST, { recursive: true });
for (const name of fs.readdirSync(DIST)) {
  if (!/^llmbench-.+\.zip$|^update\.json$|^pack$/.test(name)) continue;
  try {
    fs.rmSync(path.join(DIST, name), { recursive: true, force: true });
  } catch (e) {
    console.log(`남겨 둔다(쓰는 중): ${name}`);
  }
}

// 업데이트 zip. Windows 내장 tar(bsdtar)는 -a로 확장자에 맞춰 zip을 만든다.
const updateZip = path.join(DIST, `llmbench-update-${version}.zip`);
sh(TAR, ['-a', '-cf', updateZip, 'src', 'package.json', 'README.md', 'CONTRACT.md', 'start.bat', 'llmbench.vbs']);
const sum = sha256(updateZip);
console.log(`${path.basename(updateZip)} ${(fs.statSync(updateZip).size / 1024).toFixed(0)}KB sha256 ${sum}`);

// 처음 설치용. @electron/packager로 llmbench.exe 폴더를 만든다. asar를 끄면 앱 파일이
// resources/app 아래 그대로 놓여 업데이트 배치가 src를 덮어쓸 수 있다.
const packOut = path.join(DIST, 'pack');
sh('cmd', ['/c', 'npx', '@electron/packager', '.', 'llmbench',
  '--platform=win32', '--arch=x64', `--out=${packOut}`, '--asar=false', '--overwrite',
  // node_modules는 넣는다. node-pty가 네이티브라 빠지면 앱 안 터미널이 안 돈다.
  // packager가 devDependencies는 알아서 걷어낸다.
  '--ignore=^/dist', '--ignore=^/logs', '--ignore=^/test', '--ignore=^/scripts', '--ignore=^/\\.git', '--ignore=^/build',
  '--ignore=^/start\\.bat', '--ignore=^/llmbench\\.vbs',
  '--win32metadata.requested-execution-level=requireAdministrator',
  '--win32metadata.ProductName=llmbench', '--win32metadata.FileDescription=llmbench']);
// 클라이언트 exe. 같은 코드에서 실행 파일 이름만 바꿔 뽑는다. entry.js가 이름으로 갈라 띄운다.
sh('cmd', ['/c', 'npx', '@electron/packager', '.', 'llmbench-client',
  '--platform=win32', '--arch=x64', `--out=${packOut}`, '--asar=false', '--overwrite',
  '--ignore=^/dist', '--ignore=^/logs', '--ignore=^/test', '--ignore=^/scripts', '--ignore=^/\\.git', '--ignore=^/build',
  '--ignore=^/start\\.bat', '--ignore=^/llmbench\\.vbs',
  // 터널을 올리려면 관리자 권한이 필요하다. 서버 exe와 같게 매니페스트를 넣는다.
  '--win32metadata.requested-execution-level=requireAdministrator',
  '--win32metadata.ProductName=llmbench client', '--win32metadata.FileDescription=llmbench client']);
const clientZip = path.join(DIST, `llmbench-client-${version}.zip`);
sh(TAR, ['-a', '-cf', clientZip, '-C', packOut, 'llmbench-client-win32-x64']);
console.log(`${path.basename(clientZip)} ${(fs.statSync(clientZip).size / 1048576).toFixed(0)}MB (llmbench-client-win32-x64/llmbench-client.exe)`);

const portableZip = path.join(DIST, `llmbench-portable-${version}.zip`);
sh(TAR, ['-a', '-cf', portableZip, '-C', packOut, 'llmbench-win32-x64']);
// 네이티브 모듈이 실제로 들어갔는지 본다. 빠지면 앱 안 터미널이 안 돈다.
for (const name of ['llmbench-win32-x64', 'llmbench-client-win32-x64']) {
  const ptyDir = path.join(packOut, name, 'resources', 'app', 'node_modules', '@lydell');
  if (!fs.existsSync(ptyDir)) {
    throw new Error(`패키지에 node-pty가 없다: ${ptyDir}`);
  }
}
fs.rmSync(packOut, { recursive: true, force: true });
console.log(`${path.basename(portableZip)} ${(fs.statSync(portableZip).size / 1048576).toFixed(0)}MB (llmbench-win32-x64/llmbench.exe)`);

const manifest = {
  version,
  zipUrl: `https://github.com/${REPO}/releases/download/v${version}/${path.basename(updateZip)}`,
  sha256: sum,
  notes,
  date: new Date().toISOString().slice(0, 10)
};
fs.writeFileSync(path.join(DIST, 'update.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('update.json 작성');

if (publish) {
  sh('gh', ['release', 'create', `v${version}`, updateZip, portableZip, clientZip, path.join(DIST, 'update.json'),
    '--repo', REPO, '--title', `llmbench v${version}`, '--notes', notes || `v${version}`]);
  console.log(`GitHub Release v${version} 게시`);
} else {
  console.log('게시하려면 --publish 를 붙인다.');
}
