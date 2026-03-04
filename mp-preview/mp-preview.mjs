/**
 * 小程序 CI 脚本（预览 & 上传）— 公共复用版本
 *
 * 环境变量：
 * - MINI_APP_ID: 小程序 AppID
 * - MINI_APP_PRIVATE_KEY: 小程序上传密钥（Base64 编码或 PEM 内容）
 * - PR_AUTHOR: PR 发起者 / push 触发者
 * - PR_NUMBER: PR 编号（push 场景可为空）
 * - PR_TITLE: PR 标题 / commit message
 * - COMMIT_SHA: 当前 commit SHA
 * - IS_PR: 是否为 PR 场景（'true' / 'false'）
 * - MP_PROJECT_PATH: 小程序产物目录（相对于项目根目录）
 * - MP_ALLOWED_USERS: 用户白名单 JSON（如 {"novlan1":1,"yao":2}）
 * - MP_DESC_PREFIX: description 前缀（如 starter, starter-apply）
 */

import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT_DIR = process.cwd();

// dotenv 仅用于本地开发，CI 环境中通过 env 注入变量，找不到包时跳过
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: resolve(ROOT_DIR, '.env.local') });
} catch {
  // dotenv not available, skip
}

// ===================== 配置 =====================

const DEFAULT_ROBOT = 10;
const PROJECT_PATH = resolve(ROOT_DIR, process.env.MP_PROJECT_PATH || 'dist/build/mp-weixin');
const QRCODE_OUTPUT = resolve(ROOT_DIR, 'wx-mp-preview-qrcode.png');

function getUserRobotMap() {
  const raw = process.env.MP_ALLOWED_USERS;
  if (raw) {
    try { return JSON.parse(raw); } catch { /* ignore */ }
  }
  return {};
}

const CI_SETTING = {
  es6: true,
  es7: true,
  minify: true,
  autoPrefixWXSS: true,
  minifyWXML: true,
};

function getMode() {
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : 'all';
  if (!['preview', 'upload', 'all'].includes(mode)) {
    throw new Error(`不支持的模式: ${mode}，可选值: preview, upload, all`);
  }
  return mode;
}

// ===================== 工具函数 =====================

function log(msg) {
  console.log(`[mp-ci] ${msg}`);
}

function error(msg) {
  console.error(`[mp-ci] ❌ ${msg}`);
}

function getEnv(name, required = true) {
  const value = process.env[name];
  if (required && !value) {
    throw new Error(`缺少必要的环境变量: ${name}`);
  }
  return value || '';
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    writeFileSync(outputFile, `${name}=${value}\n`, { flag: 'a' });
  }
  log(`输出: ${name}=${value}`);
}

// ===================== 核心逻辑 =====================

function validateAuthor(author, userRobotMap) {
  const allowedUsers = Object.keys(userRobotMap);
  if (!allowedUsers.includes(author)) {
    error(`用户 "${author}" 不在白名单中，允许的用户: ${allowedUsers.join(', ')}`);
    setOutput('allowed', 'false');
    return false;
  }
  log(`✅ 用户 "${author}" 已通过白名单校验`);
  setOutput('allowed', 'true');
  return true;
}

function getRobot(author, userRobotMap) {
  const robot = userRobotMap[author] || DEFAULT_ROBOT;
  log(`用户 "${author}" 使用机器人号: ${robot}`);
  return robot;
}

function writePrivateKey() {
  const privateKeyRaw = getEnv('MINI_APP_PRIVATE_KEY');
  const keyPath = resolve(ROOT_DIR, 'wx-mp-private.key');

  let keyContent = privateKeyRaw;
  if (!privateKeyRaw.includes('BEGIN')) {
    keyContent = Buffer.from(privateKeyRaw, 'base64').toString('utf-8');
  }
  keyContent = keyContent.replace(/\\n/g, '\n');
  if (!keyContent.endsWith('\n')) {
    keyContent += '\n';
  }

  writeFileSync(keyPath, keyContent);
  log(`密钥文件已写入: ${keyPath}`);
  return keyPath;
}

async function createProject({ appId, keyPath }) {
  const ci = await import('miniprogram-ci');
  const project = new ci.default.Project({
    appid: appId,
    type: 'miniProgram',
    projectPath: PROJECT_PATH,
    privateKeyPath: keyPath,
    ignores: ['node_modules/**/*'],
  });
  return { ci, project };
}

async function preview({ appId, keyPath, robot, version, description }) {
  log('📱 开始上传小程序预览...');
  const { ci, project } = await createProject({ appId, keyPath });
  const result = await ci.default.preview({
    project,
    desc: description,
    version,
    robot,
    qrcodeFormat: 'image',
    qrcodeOutputDest: QRCODE_OUTPUT,
    setting: CI_SETTING,
    onProgressUpdate: (info) => { if (info._msg) log(info._msg); },
  });
  log('✅ 预览上传成功');
  log(`预览二维码已保存至: ${QRCODE_OUTPUT}`);
  return result;
}

async function upload({ appId, keyPath, robot, version, description }) {
  log('📦 开始上传小程序到微信后台...');
  const { ci, project } = await createProject({ appId, keyPath });
  const result = await ci.default.upload({
    project,
    desc: description,
    version,
    robot,
    setting: CI_SETTING,
    onProgressUpdate: (info) => { if (info._msg) log(info._msg); },
  });
  log(`✅ 上传成功，版本号: ${version}`);
  return result;
}

function cleanup(keyPath) {
  try {
    if (existsSync(keyPath)) {
      unlinkSync(keyPath);
      log('已清理密钥文件');
    }
  } catch { /* ignore */ }
}

// ===================== 主流程 =====================

async function main() {
  const mode = getMode();
  const author = getEnv('PR_AUTHOR', false) || 'unknown';
  const prNumber = getEnv('PR_NUMBER', false);
  const prTitle = getEnv('PR_TITLE', false);
  const commitSha = getEnv('COMMIT_SHA', false);
  const appId = getEnv('MINI_APP_ID');
  const isPR = getEnv('IS_PR', false) !== 'false';
  const userRobotMap = getUserRobotMap();

  const modeLabel = { preview: '仅预览', upload: '仅上传', all: '预览+上传' };

  log('========================================');
  log(`模式: ${modeLabel[mode]}`);
  if (prNumber) {
    log(`PR #${prNumber}: ${prTitle}`);
  } else {
    log(`Push: ${prTitle || 'branch push'}`);
  }
  log(`发起者: ${author}`);
  log(`Commit: ${commitSha?.slice(0, 7)}`);
  log(`产物目录: ${PROJECT_PATH}`);
  log('========================================');

  // 校验用户白名单（仅 PR 场景校验，push 场景跳过）
  if (isPR && !validateAuthor(author, userRobotMap)) {
    process.exit(0);
  }

  const robot = getRobot(author, userRobotMap);
  const keyPath = writePrivateKey();

  try {
    const version = prNumber
      ? `PR#${prNumber}-${commitSha?.slice(0, 7) || 'unknown'}`
      : `dev-${commitSha?.slice(0, 7) || 'unknown'}`;
    const descPrefix = getEnv('MP_DESC_PREFIX', false);
    const rawDesc = prNumber
      ? `PR #${prNumber}: ${prTitle || '预览版本'}`
      : prTitle || 'branch push';
    const description = descPrefix ? `[${descPrefix}] ${rawDesc}` : rawDesc;

    const ciParams = { appId, keyPath, robot, version, description };

    if (mode === 'preview' || mode === 'all') {
      await preview(ciParams);
      setOutput('qrcode-path', QRCODE_OUTPUT);
    }

    if (mode === 'upload' || mode === 'all') {
      await upload(ciParams);
    }

    setOutput('robot', String(robot));
    setOutput('version', version);

    log('🎉 全部完成！');
  } catch (err) {
    error(`流程执行失败: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    cleanup(keyPath);
  }
}

main();
