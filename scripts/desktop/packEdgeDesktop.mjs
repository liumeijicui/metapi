import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 打包「边缘版」桌面安装包（Metapi Edge）。
 *
 * better-sqlite3 是按 ABI 编译的原生模块，而边缘版服务进程跑在 Electron 自带的 Node 上
 * （src/desktop/runtime.ts 用 ELECTRON_RUN_AS_NODE 拉起 dist/server/edge/main.js），
 * 所以必须换成 electron ABI 的二进制。electron-builder 的自动重建依赖 node-abi，
 * 而它还不认识 Electron 42 的 ABI 146，会直接判定「无法探测 ABI」中止打包；
 * 这里改为按 ABI 取官方预编译包，临时替换后再打包，结束后还原原二进制，
 * 避免把 node_modules 留在 electron ABI 状态而影响本地 node 开发。
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const electronDist = join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const sqliteDir = join(root, 'node_modules', 'better-sqlite3');
const sqliteBinary = join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');

const cacheDir = join(root, 'node_modules', '.cache', 'metapi-edge-native');
const backupBinary = join(cacheDir, 'better_sqlite3.node.node-abi.bak');

/** 跑一段脚本时用 Electron 自带的 Node，避免额外依赖 node 可执行文件。 */
function runInElectron(script) {
  return execFileSync(electronDist, ['-e', script], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  }).trim();
}

function readPackageVersion(name) {
  return JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
}

/** 当前 node_modules 里的二进制是否是给普通 node 用的（本地开发要靠它）。 */
function sqliteLoadsUnderNode() {
  try {
    execFileSync(process.execPath, ['-e', 'require("better-sqlite3")'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 取回（并缓存）与本机 Electron ABI 匹配的 better-sqlite3 预编译二进制。 */
async function ensureElectronBinary(abi) {
  const version = readPackageVersion('better-sqlite3');
  const asset = `better-sqlite3-v${version}-electron-v${abi}-${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}.tar.gz`;
  const cached = join(cacheDir, 'better_sqlite3.node');
  if (existsSync(cached)) return cached;

  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${asset}`;
  console.log(`[edge-pack] 下载 ${asset}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载 better-sqlite3 预编译包失败：HTTP ${response.status} ${url}`);

  mkdirSync(cacheDir, { recursive: true });
  const tarball = join(cacheDir, asset);
  writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
  execFileSync('tar', ['-xzf', tarball, '-C', cacheDir], { stdio: 'inherit' });

  const extracted = join(cacheDir, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(extracted)) throw new Error(`预编译包里没有 better_sqlite3.node：${extracted}`);
  copyFileSync(extracted, cached);
  rmSync(join(cacheDir, 'build'), { recursive: true, force: true });
  rmSync(tarball, { force: true });
  return cached;
}

const abi = runInElectron('process.stdout.write(String(process.versions.modules))');
console.log(`[edge-pack] electron ${readPackageVersion('electron')} abi ${abi}`);

// 上一次打包中途失败时，node_modules 里可能还是 electron ABI 的二进制，这里以备份为准先兜底。
if (existsSync(backupBinary)) copyFileSync(backupBinary, sqliteBinary);
// 没有备份可兜底时，先确认真实存在的是 node ABI 二进制，避免把它当成备份存下来。
if (!sqliteLoadsUnderNode()) {
  console.log('[edge-pack] node_modules 里的 better-sqlite3 不是 node ABI，先还原一份 node 版');
  execFileSync(
    process.execPath,
    [join(root, 'node_modules', 'prebuild-install', 'bin.js'), '--runtime=node', `--target=${process.versions.node}`, `--arch=${process.arch}`, `--platform=${process.platform}`, '--force'],
    { cwd: sqliteDir, stdio: 'inherit' },
  );
}
const electronBinary = await ensureElectronBinary(abi);

mkdirSync(dirname(backupBinary), { recursive: true });
copyFileSync(sqliteBinary, backupBinary);
copyFileSync(electronBinary, sqliteBinary);

try {
  const loaded = runInElectron(
    'const D=require("better-sqlite3");const db=new D(":memory:");db.exec("create table t(a)");process.stdout.write("ok");',
  );
  if (loaded !== 'ok') throw new Error('better-sqlite3 在 Electron 下自检失败');
  console.log('[edge-pack] better-sqlite3 已就绪');

  execFileSync(
    process.execPath,
    [join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--config', 'electron-builder.edge.yml', '--publish', 'never'],
    { cwd: root, stdio: 'inherit' },
  );
} finally {
  // 还原 node ABI 的二进制：本地 npm run dev / vitest 都跑在普通 node 上。
  copyFileSync(backupBinary, sqliteBinary);
}
