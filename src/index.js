const COS = require("./cos");
const CDN = require("./cdn");
const core = require("@actions/core");
const { readConfig, collectLocalFiles } = require("./utils");

async function main() {
  // 读取配置
  const config = await readConfig(
    new Set([
      "clean",
      "local_path",
      "remote_path",
      ...COS.getInput(),
      ...CDN.getInput(),
    ])
  );
  const cosInstance = new COS(config);
  // 读取所有文件
  const localFiles = await collectLocalFiles(config.local_path);
  const changedFiles = await cosInstance.process(localFiles);
  const cdnInstance = new CDN(config);
  const cdnUrls = await cdnInstance.process(changedFiles);
  if (cdnUrls && cdnUrls.length > 0) {
    core.setOutput('urls', cdnUrls.join('\n'));
    core.setOutput('url', cdnUrls[0]);
  }

}

main();
