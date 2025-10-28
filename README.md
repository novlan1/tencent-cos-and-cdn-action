# Tencent Cloud COS and CDN action

[English](https://github.com/sylingd/tencent-cos-and-cdn-action/blob/master/README.en-US.md)

该 Action 可以将文件上传到腾讯云 COS，并同时刷新腾讯云 CDN 缓存（支持普通 CDN 或 EdgeOne CDN）。

## 输入

> 以下所有配置项均可通过配置文件或 with 字段传入

- `secret_id`(**必填**): 腾讯云 secret id，请使用加密环境变量
- `secret_key`(**必填**): 腾讯云 secret key，请使用加密环境变量
- `session_token`: 腾讯云临时密钥的 session token，可通过其他 actions 获取后传入
- `cos_bucket`(**必填**): COS 存储桶名称
- `cos_region`(**必填**): COS 存储桶区域
- `cos_accelerate`: 设为`true`以使用加速域名进行上传（此选项与 CDN 无关）。默认为`false`
- `cos_init_options`: 将会原样传给`new COS`的选项，JSON格式。[官方文档](https://cloud.tencent.com/document/product/436/8629)
- `cos_put_options`: 将会原样传给`uploadFile`的选项，JSON格式。[官方文档](https://cloud.tencent.com/document/product/436/64980)
- `cos_replace_file`: 是否替换同名文件，默认为`true`
  - `true` 全部替换（适合每次文件变更非常多的场景）
  - `false` 全部不替换（适合每次文件变更较少且名称中带有 hash 的场景）
  - `size` 替换大小不一致的文件
  - `crc64ecma` 通过crc64ecma对比，替换有变更的文件（适合文件数量较多的场景）
  - `false`、`size`、`crc64ecma`可以在一定程度上减少写请求。
- `cos_replace_rules`: 为不同文件设置不同的替换规则。
- `cos_file_check_concurrent`: 当`cos_replace_file`不为`true`时，检查文件是否需要上传的并发量。默认为CPU核心数*2
- `cdn_type`: CDN 类型，可选普通CDN（`cdn`）或 EdgeOne CDN（`eo`）。默认为`cdn`
- `cdn_prefix`: 若你使用腾讯云 CDN 或 EdgeOne，此处填写 CDN 的 URL 前缀。若为空，则不刷新 CDN 缓存
- `cdn_wait_flush`: 是否等待 CDN 刷新完成。默认为`false`
- `eo_zone`: 若你使用腾讯云 EdgeOne，此处填写 EdgeOne 的 Zone ID。若为空，则不刷新 CDN 缓存
- `local_path`(**必填**): 将要上传到 COS 的本地路径。可为文件夹或单个文件
- `remote_path`: 将文件上传到 COS 的指定路径。默认为`(空字符串)`
- `clean`: 设为`true`将会清除 COS 上不存在于本地的文件，会增加少量读请求和相应的删除（写）请求。默认为`false`
  - 该功能仅会清空`remote_path`下的文件。

> 如果`cos_replace_file`不为`true`，或开启`clean`，增加读请求次数为：Bucket 下 Object 数 / 1000次，例如 Bucket 下前缀为`remote_path`的文件有 3100 个，则增加读请求次数 4 次。
>
> 如果`cos_replace_file`为`crc64ecma`，对每个已经存在且大小相同的文件都会增加一次读请求，腾讯云可能会收取相应费用。

## Demo

例如，当文件结构为：

```
+ upload_folder
  - a.js
```

下列命令将会上传文件`upload_folder/a.js`至`bucket-12345678/scripts/a.js`，并刷新 CDN 缓存`https://cdn.example.com/demo/scripts/a.js`

```yaml
- name: Tencent COS and CDN
  uses: sylingd/tencent-cos-and-cdn-action@v1
  with:
    secret_id: YOUR_SECRET_ID
    secret_key: YOUR_SECRET_KEY
    session_token: YOUR_TOKEN
    cos_bucket: bucket-12345678
    cos_region: ap-shanghai
    cos_accelerate: false
    cos_init_options: '{"CopyChunkParallelLimit":10}'
    cos_put_options: '{"StorageClass":"MAZ_STANDARD"}'
    cos_replace_file: true
    cdn_wait_flush: false
    cdn_type: eo
    cdn_prefix: https://cdn.example.com/demo/
    eo_zone: zone-123456789
    local_path: upload_folder
    remote_path: scripts
    clean: false
```

更多示例可参考[test分支](https://github.com/sylingd/tencent-cos-and-cdn-action/tree/test)

## 使用配置文件

配置文件格式为JSON，默认路径为代码仓库下的 `.github/cos.json`；可以通过 `config_file` 输入参数指定配置文件路径。

配置读取优先级为：`with`参数 > 配置文件 > 默认参数

例如：

```yaml
- name: Tencent COS and CDN
  uses: sylingd/tencent-cos-and-cdn-action@latest
  with:
    secret_id: YOUR_SECRET_ID
    secret_key: YOUR_SECRET_KEY
    session_token: YOUR_TOKEN
    config_file: ${{ github.workspace }}/example.json
```

配置文件`example.json`示例：
```json
{
  "cos_bucket": "bucket-12345678",
  "cos_init_options": {
    "FileParallelLimit": 3
  }
}
```

## 功能说明

### 文件重复检查

当`cos_replace_file`使用`crc64ecma`时，将会获取服务端计算的 CRC64 值，并与本地文件对比；若相同，则跳过上传。（存在极少数 Hash 碰撞的可能性）

[服务端计算说明](https://cloud.tencent.com/document/product/436/40334)

### 为不同文件设置不同的替换规则

可以为不同文件设置不同的替换规则，支持正则表达式匹配或完全名称匹配。如有多个规则匹配，将会生效第一个。如果没有匹配规则，则使用`cos_replace_file`的配置。

```json
{
  "cos_replace_rules": [
    {
      "name": "index.html",
      "policy": "true"
    },
    {
      "match": "^.*\\.js$",
      "policy": "false"
    },
    {
      "match": "^.*\\.png$",
      "policy": "size"
    }
  ]
}
```

### 分片上传

默认情况下，将对大文件（>1m）进行分片上传。可以通过`SliceSize`设置分片上传阈值，通过`AsyncLimit`设置分片并发上传量；如：

```
cos_put_options: '{"SliceSize":1048576,"AsyncLimit":3}'
```

### 并发上传

可以通过`cos_init_options`设置`FileParallelLimit`打开并发上传功能。例如：

```
cos_init_options: '{"FileParallelLimit":3}'
```

### 使用临时密钥

当[使用临时密钥](https://cloud.tencent.com/document/product/1312/48195)时，需要授权**所有**你要用到的功能权限：

| 功能 | 权限 |
| --- | --- |
| 基础功能 | `cos:PutObject` `cos:DeleteObject` `cos:GetBucket` `cos:HeadObject` |
| 普通 CDN | `cdn:PurgePathCache` `cdn:PurgeUrlsCache` `cdn:DescribePurgeTasks` |
| EdgeOne CDN | `teo:CreatePurgeTask` `teo:DescribePurgeTasks` |
| 分块上传（有大文件的时候需要） | `cos:InitiateMultipartUpload` `cos:ListMultipartUploads` `cos:ListParts` `cos:UploadPart` `cos:CompleteMultipartUpload` |
