const os = require("os");
const core = require("@actions/core");
const COS_SDK = require("cos-nodejs-sdk-v5");
const fastq = require("fastq");
const fs = require("fs/promises");
const path = require("path");
const crc64 = require("crc64-ecma182.js");
const { normalizeObjectKey } = require("./utils");

const FILE_EXISTS = Symbol("file_exists");
const HEAD_FAILED = Symbol("head_failed");

function getThreadCount() {
  try {
    return 2 * os.cpus().length;
  } catch (e) {
    // ignore
  }
  return 3;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    crc64.crc64File(filePath, (err, ret) => {
      if (ret) {
        resolve(String(ret));
      } else {
        reject(err);
      }
    });
  });
}

class COS {
  static getInput() {
    return [
      "secret_id",
      "secret_key",
      "session_token",
      "cos_accelerate",
      "cos_init_options",
      "cos_put_options",
      "cos_replace_file",
      "cos_replace_rules",
      "cos_file_check_concurrent",
      "cos_bucket",
      "cos_region",
      "local_path",
      "remote_path",
      "clean",
    ];
  }

  putOptions = {};
  remoteFiles = undefined;
  checkConcurrent = 3;

  constructor(inputs) {
    const opt = {
      UseAccelerate: inputs.cos_accelerate === "true",
      FileParallelLimit: 1, // 默认不使用并发上传
    };

    const getJSONInput = (content, defaultValue = {}) => {
      if (
        typeof content === "undefined" ||
        content === null ||
        content === ""
      ) {
        return defaultValue;
      }
      if (typeof content === "object") {
        return content;
      }
      try {
        return JSON.parse(content);
      } catch (e) {
        console.log("[cos] parse options failed:", e.message, content);
      }
      return defaultValue;
    };

    // Read other options
    const initOptions = getJSONInput(inputs.cos_init_options);
    Object.keys(initOptions).forEach((k) => {
      opt[k] = initOptions[k];
    });

    if (inputs.session_token) {
      opt.getAuthorization = (options, callback) => {
        const time = Math.floor(Date.now() / 1000);
        callback({
          TmpSecretId: inputs.secret_id,
          TmpSecretKey: inputs.secret_key,
          SecurityToken: inputs.session_token,
          StartTime: time,
          // Simulation expiration time
          ExpiredTime: time + 24 * 3600,
        });
      };
    } else {
      opt.SecretId = inputs.secret_id;
      opt.SecretKey = inputs.secret_key;
    }

    this.cos = new COS_SDK(opt);
    this.bucket = inputs.cos_bucket;
    this.region = inputs.cos_region;
    this.localPath = inputs.local_path;
    this.remotePath = normalizeObjectKey(inputs.remote_path || "");
    this.replace = inputs.cos_replace_file || "true";
    this.replaceRules = getJSONInput(inputs.cos_replace_rules, []);
    this.clean = inputs.clean === "true" || inputs.clean === true;
    this.checkConcurrent = Number(inputs.cos_file_check_concurrent);
    if (Number.isNaN(this.checkConcurrent) || this.checkConcurrent <= 0) {
      this.checkConcurrent = getThreadCount();
    }
    this.putOptions = getJSONInput(inputs.cos_put_options);
    console.log("[cos] Put options:", this.putOptions);
  }

  uploadFile(key, file) {
    return new Promise((resolve, reject) => {
      this.cos.uploadFile(
        {
          StorageClass: "STANDARD",
          ...this.putOptions,
          Bucket: this.bucket,
          Region: this.region,
          Key: key,
          FilePath: file,
        },
        function (err, data) {
          if (err) {
            return reject(err);
          } else {
            return resolve(data);
          }
        }
      );
    });
  }

  headObject(key) {
    return new Promise((resolve, reject) => {
      this.cos.headObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: key,
        },
        function (err, data) {
          if (err) {
            return reject(err);
          } else {
            return resolve(data);
          }
        }
      );
    });
  }

  generateFileInfo(p) {
    return {
      objectKey: normalizeObjectKey(this.remotePath + "/" + p),
      localPath: path.join(this.localPath, p),
    };
  }

  getFileCheckPolicy(p) {
    const res = this.replaceRules.find((rule) => {
      if (rule.name) {
        return rule.name === p;
      }
      if (rule.match) {
        try {
          const match = new RegExp(rule.match);
          return match.test(p);
        } catch (e) {
          console.log("[cos] Invalid regexp:", rule.match);
        }
      }
      return false;
    });
    return res ? res.policy : this.replace;
  }

  async shouldUploadFile(basePath, objectKey, localPath) {
    const policy = this.getFileCheckPolicy(basePath);
    core.debug(`[cos] [shouldUploadFile] ${basePath} policy: ${policy}`);
    // do not check
    if (policy === "true") {
      return true;
    }
    // has listed bucket
    if (typeof this.remoteFiles !== "undefined") {
      if (typeof this.remoteFiles[basePath] === "undefined") {
        // new file, skip head operator
        core.debug(`[cos] [shouldUploadFile] ${basePath} is new file`);
        return true;
      }

      if (policy === "size" || policy === "crc64ecma") {
        // check file size is match
        const fileInfo = await fs.stat(localPath);
        core.debug(
          `[cos] [shouldUploadFile] ${basePath} size is: local ${fileInfo.size} remote ${this.remoteFiles[basePath].Size}`
        );
        if (String(fileInfo.size) !== String(this.remoteFiles[basePath].Size)) {
          return true;
        }
      }
    }
    let info = {};
    try {
      info = await this.headObject(objectKey);
    } catch (e) {
      if (e.code === "404") {
        core.debug(`[cos] [shouldUploadFile] ${basePath} head return 404`);
        // file not exists, continue upload
        return true;
      } else {
        // head failed, do not upload
        return HEAD_FAILED;
      }
    }
    // check crc64ecma
    if (policy === "crc64ecma") {
      const exist = info.headers["x-cos-hash-crc64ecma"];
      const cur = await hashFile(localPath);
      core.debug(
        `[cos] [shouldUploadFile] ${basePath} crc64ecma is: local ${cur} remote ${exist}`
      );
      if (exist === cur) {
        return FILE_EXISTS;
      } else {
        return true;
      }
    }
    // file exists, do not upload
    return FILE_EXISTS;
  }

  deleteFile(p) {
    return new Promise((resolve, reject) => {
      this.cos.deleteObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: normalizeObjectKey(this.remotePath + "/" + p),
        },
        function (err, data) {
          if (err) {
            return reject(err);
          } else {
            return resolve(data);
          }
        }
      );
    });
  }

  listFiles(nextMarker) {
    return new Promise((resolve, reject) => {
      this.cos.getBucket(
        {
          Bucket: this.bucket,
          Region: this.region,
          Prefix: normalizeObjectKey(this.remotePath),
          Marker: nextMarker,
        },
        function (err, data) {
          if (err) {
            return reject(err);
          } else {
            return resolve(data);
          }
        }
      );
    });
  }

  uploadFiles(localFiles) {
    return new Promise(async (resolve) => {
      const size = localFiles.size;
      const changedFiles = [];

      // 已经显示过已完成的列表
      const finished = [];

      // 单个文件已完成（含上传完成或被跳过）
      const onFileFinish = (state, key) => {
        finished.push(key);
        const percent = parseInt((finished.length / size) * 100);
        console.log(
          `>> [${finished.length}/${size}, ${percent}%] ${state} ${key}`
        );
        if (finished.length === size) {
          this.cos.off("list-update", handleListUpdate);
          resolve(changedFiles);
        }
      };

      // 队列上传进度改变
      const handleListUpdate = (data) => {
        const notFinished = data.list.filter((x) => !finished.includes(x.Key));

        if (core.isDebug()) {
          core.debug(
            `[cos] [uploadFiles] [handleListUpdate] ${JSON.stringify(
              notFinished.map((x) => [x.state, x.Key])
            )}`
          );
        }

        notFinished.forEach((item) => {
          if (["success", "canceled", "error"].includes(item.state)) {
            onFileFinish(`upload ${item.state}`, item.Key);
          }
        });
      };

      this.cos.on("list-update", handleListUpdate);

      // file like: js/index.js
      const uploadQueue = fastq.promise(async (file) => {
        const { objectKey, localPath } = this.generateFileInfo(file);
        const shouldUpload = await this.shouldUploadFile(
          file,
          objectKey,
          localPath
        );
        core.debug(`[cos] [uploadFiles] [uploadQueue] ${file} ${String(shouldUpload)}`)
        if (shouldUpload === FILE_EXISTS) {
          onFileFinish("skipped(file exists)", objectKey);
        } else if (shouldUpload === HEAD_FAILED) {
          onFileFinish("skipped(head failed)", objectKey);
        } else {
          changedFiles.push(file);
          this.uploadFile(objectKey, localPath);
        }
      }, this.checkConcurrent);

      // 处理所有文件
      localFiles.forEach((file) =>
        uploadQueue
          .push(file)
          .catch((e) =>
            console.log(`[cos] upload ${file} failed: ${e.message}`)
          )
      );
    });
  }

  async collectRemoteFiles() {
    let data = {};
    let nextMarker = null;

    if (typeof this.remoteFiles === "undefined") {
      this.remoteFiles = {};
    }

    do {
      data = await this.listFiles(nextMarker);
      for (const e of data.Contents) {
        const p = normalizeObjectKey(e.Key.substring(this.remotePath.length));
        this.remoteFiles[p] = e;
      }
      nextMarker = data.NextMarker;
      core.debug(
        `[cos] [collectRemoteFiles] IsTruncated: ${data.IsTruncated}, NextMarker: ${nextMarker}`
      );
    } while (data.IsTruncated === "true");

    if (core.isDebug()) {
      core.debug(
        `[cos] [collectRemoteFiles] keys: ${Object.keys(this.remoteFiles).join(
          ","
        )}`
      );
    }

    return this.remoteFiles;
  }

  findDeletedFiles(localFiles) {
    const deletedFiles = new Set();
    if (typeof this.remoteFiles === "undefined") {
      return deletedFiles;
    }
    const remoteFiles = Object.keys(this.remoteFiles);
    for (const file of remoteFiles) {
      if (!localFiles.has(file)) {
        deletedFiles.add(file);
      }
    }
    return deletedFiles;
  }

  async cleanDeleteFiles(deleteFiles) {
    const size = deleteFiles.size;
    let index = 0;
    let percent = 0;
    for (const file of deleteFiles) {
      await this.deleteFile(file);
      index++;
      percent = parseInt((index / size) * 100);
      const displayPath = normalizeObjectKey(this.remotePath + "/" + file);
      console.log(`>> [${index}/${size}, ${percent}%] cleaned ${displayPath}`);
    }
  }

  async process(localFiles) {
    if (
      this.clean ||
      this.replace !== "true" ||
      this.replaceRules.some((x) => x.policy !== "true")
    ) {
      console.log(`[cos] collecting remote files`);
      this.remoteFiles = await this.collectRemoteFiles();
    }
    console.log(`[cos] ${localFiles.size} files to be uploaded`);
    let changedFiles = localFiles;
    try {
      changedFiles = await this.uploadFiles(localFiles);
    } catch (e) {
      console.log("upload failed: ", e);
      process.exit(-1);
    }
    let cleanedFilesCount = 0;
    if (this.clean) {
      const deletedFiles = this.findDeletedFiles(localFiles);
      if (deletedFiles.size > 0) {
        console.log(`[cos] ${deletedFiles.size} files to be cleaned`);
      }
      await this.cleanDeleteFiles(deletedFiles);
      cleanedFilesCount = deletedFiles.size;
    }
    let cleanedFilesMessage = "";
    if (cleanedFilesCount > 0) {
      cleanedFilesMessage = `, cleaned ${cleanedFilesCount} files`;
    }
    console.log(
      `[cos] uploaded ${changedFiles.length} files${cleanedFilesMessage}`
    );
    return changedFiles;
  }
}

module.exports = COS;
