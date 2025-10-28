const core = require("@actions/core");
const fs = require("fs/promises");
const path = require("path");

async function walk(parentPath, walkFn) {
  stats = await fs.lstat(parentPath);
  if (!stats.isDirectory()) {
    return await walkFn(parentPath);
  }

  const dir = await fs.opendir(parentPath);
  for await (const dirent of dir) {
    await walk(path.join(parentPath, dirent.name), walkFn);
  }
}

async function collectLocalFiles(root) {
  const absRoot = path.join(root);
  const files = new Set();
  await walk(absRoot, (path) => {
    let p = path.substring(absRoot.length);
    while (p[0] === "/") {
      p = p.substring(1);
    }
    files.add(p);
  });
  return files;
}

function normalizeObjectKey(path) {
  let p = path.replace(/[\\\/]+/g, '/');
  if (p[0] === "/") {
    p = p.substr(1);
  }
  return p;
}

function sleep(time) {
  return new Promise(resolve => {
    setTimeout(() => resolve(), time);
  });
}

async function fileExists(fullPath) {
  try {
    await fs.access(fullPath, fs.constants.R_OK);
    return true;
  } catch (e) {
    return false;
  }
}

async function readConfig(fields) {
  const result = {};
  const readConfigFromFile = async (file) => {
    try {
      const content = await fs.readFile(file, "utf-8");
      const config = JSON.parse(content);
      Object.keys(config).forEach((k) => {
        result[k] = config[k];
      });
    } catch (e) {
      console.log(`[core] read config file ${file} failed:`, e.message);
    }
  }
  // 从文件读取
  const configFile = core.getInput("config_file");
  if (configFile) {
    await readConfigFromFile(configFile);
  }
  if (!configFile && typeof process.env.GITHUB_WORKSPACE !== 'undefined') {
    const p = path.join(process.env.GITHUB_WORKSPACE, '.github/cos.json');
    if (await fileExists(p)) {
      await readConfigFromFile(p);
    }
  }
  // 合并数组项
  fields.forEach((k) => {
    if (typeof result[k] === "undefined") {
      result[k] = core.getInput(k);
    }
  });
  return result;
}

module.exports = {
  sleep,
  readConfig,
  collectLocalFiles,
  normalizeObjectKey,
};
