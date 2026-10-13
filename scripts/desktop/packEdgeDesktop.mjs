import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 打包「边缘版」桌面安装包（Metapi Edge）。
 *
 * 这里替 electron-builder 处理两件它自己做不了的事：
 *
 * 1) better-sqlite3 是按 ABI 编译的原生模块，而边缘版服务进程跑在 Electron 自带的 Node 上
 *    （src/desktop/runtime.ts 用 ELECTRON_RUN_AS_NODE 拉起 dist/server/edge/main.js），
 *    所以必须换成 electron ABI 的二进制。electron-builder 的自动重建依赖 node-abi，
 *    而它还不认识 Electron 42 的 ABI 146，会直接判定「无法探测 ABI」中止打包；
 *    这里改为按 ABI 取官方预编译包，临时替换后再打包，结束后还原原二进制，
 *    避免把 node_modules 留在 electron ABI 状态而影响本地 node 开发。
 *
 * 2) 交叉打包：用 --platform / --arch 指定目标平台（例如在 Linux 上出 Windows 安装包），
 *    原生模块与 Electron 运行时都必须换成目标平台那一份 —— 否则打出来的「Windows 包」
 *    里会是 Linux 的 Electron 和 Linux 的 better-sqlite3。Windows 包的图标与版本信息
 *    由 electron-builder 调 rcedit 写入，在 Linux 上需要系统装好 wine
 *    （`sudo yum install -y wine`，实测 wine 4.0.4 + wine64 可用）。
 *
 * 用法：
 *   node scripts/desktop/packEdgeDesktop.mjs                          # 打当前平台
 *   node scripts/desktop/packEdgeDesktop.mjs --platform=win32 --arch=x64
 *   node scripts/desktop/packEdgeDesktop.mjs --platform=win32 --target=portable
 *
 * 关于产物类型（--target）：
 *   zip / portable 在 Linux 上都能打；nsis 不行 —— 它需要 makensis 先生成一个临时
 *   安装器、再在本机把它跑起来导出 uninstaller.exe，而那个临时安装器是 32 位的，
 *   EPEL7 只提供 64 位 wine（没有 wine-core.i686），必然失败。
 *   需要 nsis 安装包请在 Windows 上跑（见 docs/edge-relay-windows-prompt.md）。
 *
 * 国内网络下 GitHub 直连会断流，脚本默认走 npmmirror 镜像；
 * 需要时可用 ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR 覆盖。
 */

// 打包要下三样东西：目标平台的 Electron 运行时、electron-builder 的辅助二进制
// （winCodeSign / nsis）、better-sqlite3 的预编译包。前两个都支持镜像，默认给国内源。
process.env.ELECTRON_MIRROR ??= 'https://registry.npmmirror.com/-/binary/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sqliteDir = join(root, 'node_modules', 'better-sqlite3');
const sqliteBinary = join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');

const cacheDir = join(root, 'node_modules', '.cache', 'metapi-edge-native');
const backupBinary = join(cacheDir, 'better_sqlite3.node.node-abi.bak');

const VALID_PLATFORMS = ['win32', 'darwin', 'linux'];
const VALID_ARCHES = ['x64', 'arm64'];

/** 解析 --platform= / --arch=，缺省就是本机。 */
function parseTarget(argv) {
  let platform = process.platform;
  let arch = process.arch;
  let targetName = null;

  for (const arg of argv) {
    const asPlatform = /^--platform(?:=(.*))?$/.exec(arg);
    if (asPlatform) {
      platform = (asPlatform[1] || '').trim();
      continue;
    }
    const asArch = /^--arch(?:=(.*))?$/.exec(arg);
    if (asArch) {
      arch = (asArch[1] || '').trim();
      continue;
    }
    const asTarget = /^--target(?:=(.*))?$/.exec(arg);
    if (asTarget) {
      targetName = (asTarget[1] || '').trim() || null;
      continue;
    }
    throw new Error(`无法识别的参数：${arg}`);
  }

  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(`不支持的平台：${platform}（可选 ${VALID_PLATFORMS.join(' / ')}）`);
  }
  if (!VALID_ARCHES.includes(arch)) {
    throw new Error(`不支持的架构：${arch}（可选 ${VALID_ARCHES.join(' / ')}）`);
  }
  if (targetName != null && !/^[a-z][a-z0-9-]*$/.test(targetName)) {
    throw new Error(`不支持的产物类型：${targetName}`);
  }

  return { platform, arch, targetName };
}

const target = parseTarget(process.argv.slice(2));
/** 目标平台的标签，也是预编译包命名里用的那一段（win32-x64 / linux-x64 …）。 */
const targetTag = `${target.platform}-${target.arch}`;
const crossBuild = target.platform !== process.platform || target.arch !== process.arch;

/**
 * 本机 Electron 自带的 Node，用来跑原生模块自检。
 * CI 里设了 ELECTRON_SKIP_BINARY_DOWNLOAD=1，dist/ 可能压根不存在，
 * 所以除了这里显式用到自检，其它地方都不应该依赖它。
 */
function localElectronBinary() {
  const binary = join(
    root,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  if (!existsSync(binary)) {
    throw new Error(`找不到本机 Electron 可执行文件：${binary}（安装依赖时被跳过？）`);
  }
  return binary;
}

/** 本机 Electron 二进制可不可用（决定要不要跑加载自检）。 */
function hasLocalElectronBinary() {
  try {
    localElectronBinary();
    return true;
  } catch {
    return false;
  }
}

/**
 * Electron 的内置 Node ABI（node_modules/electron/abi_version）。
 * ABI 只跟 Electron 版本相关，交叉打包时读到的值对目标平台同样成立，
 * 所以这里优先读文件，读不到再退回启动 Electron 去问。
 */
function resolveAbi() {
  const abiFile = join(root, 'node_modules', 'electron', 'abi_version');
  if (existsSync(abiFile)) {
    const raw = readFileSync(abiFile, 'utf8').trim();
    if (/^\d+$/.test(raw)) return raw;
  }
  if (hasLocalElectronBinary()) {
    return runInElectron('process.stdout.write(String(process.versions.modules))');
  }
  throw new Error('无法确定 Electron 的 ABI：既没有 node_modules/electron/abi_version，也没有本机 Electron 可执行文件');
}

/** 跑一段脚本时用 Electron 自带的 Node，避免额外依赖 node 可执行文件。 */
function runInElectron(script) {
  return execFileSync(localElectronBinary(), ['-e', script], {
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

async function download(url, filePath, label) {
  console.log(`[edge-pack] 下载 ${label}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载 ${label} 失败：HTTP ${response.status} ${url}`);
  writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
}

/** 取回（并缓存）与目标平台 + Electron ABI 匹配的 better-sqlite3 预编译二进制。 */
async function ensureElectronBinary(abi) {
  const version = readPackageVersion('better-sqlite3');
  const cached = join(cacheDir, `better_sqlite3.node.electron-v${abi}-${targetTag}`);
  if (existsSync(cached)) return cached;

  const asset = `better-sqlite3-v${version}-electron-v${abi}-${targetTag}.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${asset}`;

  mkdirSync(cacheDir, { recursive: true });
  const tarball = join(cacheDir, asset);
  await download(url, tarball, asset);
  execFileSync('tar', ['-xzf', tarball, '-C', cacheDir], { stdio: 'inherit' });

  const extracted = join(cacheDir, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(extracted)) throw new Error(`预编译包里没有 better_sqlite3.node：${extracted}`);
  copyFileSync(extracted, cached);
  rmSync(join(cacheDir, 'build'), { recursive: true, force: true });
  rmSync(tarball, { force: true });
  return cached;
}

/**
 * 目标平台的 Electron 发行包（zip 路径）。
 * 交叉打包必须显式给这个，否则 electron-builder 会拿 package.json 里配的
 * `electronDist: node_modules/electron/dist`（本机平台那份）去装包。
 * 镜像取 ELECTRON_MIRROR（文件顶部已默认指向 npmmirror）。
 */
async function ensureElectronDistZip() {
  const version = readPackageVersion('electron');
  const cached = join(cacheDir, `electron-v${version}-${targetTag}.zip`);
  if (existsSync(cached)) return cached;

  mkdirSync(cacheDir, { recursive: true });
  const mirror = process.env.ELECTRON_MIRROR.replace(/\/+$/, '');
  const asset = `electron-v${version}-${targetTag}.zip`;
  await download(`${mirror}/v${version}/${asset}`, cached, asset);
  return cached;
}

/**
 * electron-builder 在非 Windows 上会调用 wine 跑 rcedit 给 exe 写图标和版本信息，
 * 它是「32 位 rcedit 优先」的：只要传了 --ia32 就用 rcedit-ia32.exe。
 * 但 CentOS 7 的 EPEL 只提供 64 位 wine（没有 wine-core.i686），跑 32 位 PE 会直接
 * 报 `wine: Bad EXE format`。rcedit 本身改的是 PE 资源、与自身位数无关，所以这里
 * 用 64 位的 rcedit 顶掉两个入口，交给 ELECTRON_BUILDER_RCEDIT_PATH 生效。
 */
async function ensureRceditOverride() {
  const overrideDir = join(cacheDir, 'rcedit');
  const x64Target = join(overrideDir, 'rcedit-x64.exe');
  const x86Target = join(overrideDir, 'rcedit-x86.exe');
  if (existsSync(x64Target) && existsSync(x86Target)) return overrideDir;

  // 复用 electron-builder 自己的下载逻辑（含镜像环境变量与校验），避免另写一份。
  const require = createRequire(import.meta.url);
  const { getRceditBundle } = require('app-builder-lib/out/toolsets/windows.js');
  const bundle = await getRceditBundle(null);

  mkdirSync(overrideDir, { recursive: true });
  copyFileSync(bundle.x64, x64Target);
  copyFileSync(bundle.x64, x86Target);
  console.log('[edge-pack] 已准备 64 位 rcedit（本机 wine 无 32 位支持）');
  return overrideDir;
}

/**
 * 交叉打包时没法在本机 require 目标平台的原生模块，退一步校验文件头：
 * Windows PE 是 `MZ`，Linux ELF 是 `\x7fELF`。下错平台的文件会在这里直接暴露。
 */
function assertNativeBinaryMatchesTarget(filePath) {
  const head = readFileSync(filePath).subarray(0, 2);
  const expected = target.platform === 'win32' ? [0x4d, 0x5a] : [0x7f, 0x45];
  const matched = head.length === 2 && head[0] === expected[0] && head[1] === expected[1];
  if (!matched) {
    throw new Error(`better-sqlite3 二进制与目标平台 ${targetTag} 不匹配：${filePath}`);
  }
}

/** 系统 libstdc++ 偏旧时可以顶上的几处常见位置（devtoolset / 自备工具链）。 */
const LIBSTDCXX_CANDIDATE_DIRS = [
  '/opt/metapi-build-tools/cc/lib',
  '/opt/rh/devtoolset-11/root/usr/lib64',
  '/opt/rh/devtoolset-10/root/usr/lib64',
  '/opt/rh/devtoolset-9/root/usr/lib64',
  '/opt/rh/devtoolset-8/root/usr/lib64',
  '/opt/rh/gcc-toolset-11/root/usr/lib64',
  '/usr/local/lib64',
  '/usr/local/lib',
];

/** 找一份带 GLIBCXX_3.4.21 及以上符号的 libstdc++（比 CentOS 7 自带的 3.4.19 新）。 */
function findNewerLibstdcxxDir() {
  const marker = Buffer.from('GLIBCXX_3.4.21');
  for (const dir of LIBSTDCXX_CANDIDATE_DIRS) {
    const file = join(dir, 'libstdc++.so.6');
    if (!existsSync(file)) continue;
    try {
      if (readFileSync(file).includes(marker)) return dir;
    } catch {
      // 读不到（权限等）就当这个候选不可用，继续试下一个
    }
  }
  return null;
}

/**
 * electron-builder 自带的 Linux 版 makensis 要 GLIBCXX_3.4.21，而 CentOS 7 的
 * /usr/lib64/libstdc++.so.6 只到 3.4.19：makensis 会直接退出，外层只看到一句
 * `Error: write EPIPE`，极难定位。这里提前把可用的 libstdc++ 通过 LD_LIBRARY_PATH
 * 递出去（app-builder 自身是 Go 静态编译，不受影响）。
 */
function ensureNsisRuntimeEnv() {
  const explicit = (process.env.METAPI_EDGE_LIBSTDCXX_DIR || '').trim();
  const dir = explicit || findNewerLibstdcxxDir();
  if (dir == null) {
    console.warn(
      '[edge-pack] 没找到比系统更新的 libstdc++。'
      + '若打包在 makensis 阶段报 write EPIPE，请设置 METAPI_EDGE_LIBSTDCXX_DIR 指向带 GLIBCXX_3.4.21 的目录。',
    );
    return;
  }
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${dir}:${process.env.LD_LIBRARY_PATH}`
    : dir;
  console.log(`[edge-pack] makensis 改用更新的 libstdc++：${dir}`);
}

const abi = resolveAbi();
console.log(
  `[edge-pack] 目标 ${targetTag}${crossBuild ? '（交叉打包）' : ''}，`
  + `electron ${readPackageVersion('electron')} abi ${abi}`,
);

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
assertNativeBinaryMatchesTarget(sqliteBinary);

try {
  if (crossBuild) {
    // 目标平台的原生模块在本机加载不了，只能靠上面的文件头校验兜着。
    console.log('[edge-pack] better-sqlite3 已就绪（交叉打包，跳过本机加载自检）');
  } else if (!hasLocalElectronBinary()) {
    console.log('[edge-pack] 没有本机 Electron 可执行文件，跳过 better-sqlite3 加载自检');
  } else {
    const loaded = runInElectron(
      'const D=require("better-sqlite3");const db=new D(":memory:");db.exec("create table t(a)");process.stdout.write("ok");',
    );
    if (loaded !== 'ok') throw new Error('better-sqlite3 在 Electron 下自检失败');
    console.log('[edge-pack] better-sqlite3 已就绪');
  }

  const builderArgs = ['--config', 'electron-builder.edge.yml', '--publish', 'never'];
  if (target.platform === 'win32') builderArgs.push('--win');
  else if (target.platform === 'darwin') builderArgs.push('--mac');
  else builderArgs.push('--linux');
  // 指定产物类型时覆盖配置里的 target 列表，例如 Linux 上只打 portable
  // （nsis 需要在本机运行 32 位卸载器生成程序，64 位 wine 做不到）。
  if (target.targetName != null) builderArgs.push(target.targetName);
  builderArgs.push(`--${target.arch}`);
  if (crossBuild) builderArgs.push(`-c.electronDist=${await ensureElectronDistZip()}`);

  if (target.platform === 'win32' && process.platform !== 'win32') {
    process.env.ELECTRON_BUILDER_RCEDIT_PATH = await ensureRceditOverride();
    ensureNsisRuntimeEnv();
  }

  execFileSync(
    process.execPath,
    [join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), ...builderArgs],
    { cwd: root, stdio: 'inherit' },
  );
} finally {
  // 还原 node ABI 的二进制：本地 npm run dev / vitest 都跑在普通 node 上。
  copyFileSync(backupBinary, sqliteBinary);
}
