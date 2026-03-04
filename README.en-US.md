# Tencent Cloud COS and CDN action

[中文](https://github.com/sylingd/tencent-cos-and-cdn-action/blob/master/README.md)

This action can upload files to tencent cloud COS, and flush CDN cache (support regular CDN and EdgeOne CDN).

## Inputs

> All inputs can be passed in through configuration file or `with` field

- `secret_id`(**Required**): Tencent Cloud secret id. Should be referred to a encrypted environment variable
- `secret_key`(**Required**): Tencent Cloud secret key. Should be referred to a encrypted environment variable
- `session_token`: Tencent Cloud session token for temporary key, may get from other actions
- `cos_bucket`(**Required**): COS bucket name
- `cos_region`(**Required**): COS bucket region
- `local_path`(**Required**): Local path to be uploaded to COS. Directory or file is allowed
- `cos_accelerate`: Set to `true` for using accelerate domain to upload files (this input is not independent of the CDN). Default is false
- `cos_init_options`: The options that will be passed to `new COS` as is, in JSON format.[official documentation](https://www.tencentcloud.com/document/product/436/7749)
- `cos_put_options`: The options that will be passed to `uploadFile` as is, in JSON format. [official documentation](https://www.tencentcloud.com/document/product/436/43871)
- `cdn_type`: CDN type, you can choose regular CDN (`cdn`) or EdgeOne CDN (`eo`). Default is `cdn`
- `cdn_prefix`: CDN url prefix if you are using Tencent Cloud CDN or Tencent Cloud EdgeOne. If is empty, this action will not flush CDN cache.
- `cos_replace_file`: Whether to replace files with the same name. Default is `true`
  - `true` Replace
  - `false` Do not replace all
  - `size` Replace files with inconsistent sizes
  - `crc64ecma` Replace changed files through crc64ecma comparison
- `cos_replace_rules`: Set different replacement rules for different files, see the following instructions for detailed settings
- `cos_file_check_concurrent`: When `cos_replace_file` is not `true`, check whether the file needs to be uploaded concurrently. Default is CPU cores * 2
- `cdn_wait_flush`: Whether to wait for CDN refresh to complete. Default is `false`
- `eo_zone`: The Zone ID if you are using Tencent Cloud EdgeOne. If is empty, this action will not flush CDN cache.
- `remote_path`: COS path to put the local files in on COS. Default is `(empty string)`
- `clean`: Set to `true` for cleaning files on COS path which are not existed in local path. Default is `false`
  - This function will only clear the files under `remote_path`.

> If `cos_replace_file` is not `true`, or `clean` is turned on, the number of read requests is increased by: number of objects in the bucket / 1000 times. For example, if there are 3100 files with the prefix `remote_path` in the bucket, the number of read requests is increased by 4 times.
>
> If `cos_replace_file` is `crc64ecma`, a read request will be added for each existing file of the same size.
>
> Tencent Cloud may charge corresponding fees.

## Outputs

- `urls`: CDN URLs of all changed files, separated by newline. Only available when `cdn_prefix` is configured
- `url`: CDN URL of the first changed file. Only available when `cdn_prefix` is configured

## Demo

For example, when the file structure is:

```
+ upload_folder
  - a.js
```

The following command will upload the file `upload_folder/a.js` to `bucket-12345678/scripts/a.js` and refresh the CDN cache `https://cdn.example.com/demo/scripts/a.js`

```yaml
- name: Tencent COS and CDN
  id: deploy
  uses: sylingd/tencent-cos-and-cdn-action@latest
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

- name: Print CDN URLs
  run: |
    echo "First URL: ${{ steps.deploy.outputs.url }}"
    echo "All URLs:"
    echo "${{ steps.deploy.outputs.urls }}"
```

> Note: To use outputs, you need to add an `id` to the upload step (e.g. `id: deploy` as shown above), then reference via `steps.<id>.outputs.url` / `steps.<id>.outputs.urls`.

For more examples, please refer to the [test branch](https://github.com/sylingd/tencent-cos-and-cdn-action/tree/test)

## Use configuration file

The configuration file format is JSON, and the default path is `.github/cos.json` in the code repository. You can specify the configuration file path through the `config_file` input parameter.

Configuration read priority is: `with` parameter > configuration file > default parameters

For example:

```yaml
- name: Tencent COS and CDN
  uses: sylingd/tencent-cos-and-cdn-action@latest
  with:
    secret_id: YOUR_SECRET_ID
    secret_key: YOUR_SECRET_KEY
    session_token: YOUR_TOKEN
    config_file: ${{ github.workspace }}/example.json
```

Example of configuration file:
```json
{
  "cos_bucket": "bucket-12345678",
  "cos_init_options": {
    "FileParallelLimit": 3
  }
}
```

## Feature Description

### File duplication check

When `cos_replace_file` uses `crc64ecma`, the CRC64 value calculated by the server will be obtained and compared with the local file; if they are the same, the upload will be skipped. (There is a very small possibility of hash collision)

[Server calculation instructions](https://www.tencentcloud.com/document/product/436/34078)

### Set Different Replacement Rules for Different Files

You can set different replacement rules for different files, supporting regular expression matching or exact name matching. If multiple rules match, the first one will be used. If no rules match, the `cos_replace_file` configuration will be used.

In the configuration file, `cos_replace_rules` is an array:
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

In the `with` parameter, `cos_replace_rules` is a JSON string:
```yaml
- name: Tencent COS and CDN
  uses: sylingd/tencent-cos-and-cdn-action@v1
  with:
    cos_replace_rules: '[{"name":"index.html","policy":"true"}]'
```

### Multi-part upload

By default, large files (>1M) will be uploaded in multiple parts. You can set the multi-part upload threshold through `SliceSize`, and set the multi-part concurrent upload limit through `AsyncLimit`; for example:

```
cos_put_options: '{"SliceSize":1048576,"AsyncLimit":3}'
```

### Concurrent uploads

You can enable concurrent uploads by setting `FileParallelLimit` in `cos_init_options`. For example:

```
cos_init_options: '{"FileParallelLimit":3}'
```

### Using temporary key

When [using a temporary key](https://www.tencentcloud.com/document/product/1150/49452), you need to authorize **all** the function permissions you want to use:

| Function | Permission |
| --- | --- |
| Basic functions | `cos:PutObject` `cos:DeleteObject` `cos:GetBucket` `cos:HeadObject` |
| Normal CDN | `cdn:PurgePathCache` `cdn:PurgeUrlsCache` `cdn:DescribePurgeTasks` |
| EdgeOne CDN | `teo:CreatePurgeTask` `teo:DescribePurgeTasks` |
| Multi-part upload (required for large files) | `cos:InitiateMultipartUpload` `cos:ListMultipartUploads` `cos:ListParts` `cos:UploadPart` `cos:CompleteMultipartUpload` |
