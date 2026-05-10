# Credentials Configuration

> 钉钉日志 skill 完全靠 OS 环境变量读凭据,**不读** `.env` 文件、**不接受** CLI flag 传 appkey/appsecret。

## 必需变量

| env | 用途 | 适用子命令 |
|---|---|---|
| `DINGTALK_APPKEY` | 应用凭证 | 全部 |
| `DINGTALK_APPSECRET` | 应用密钥 | 全部 |
| `DINGTALK_USERID` | 默认 userid(可被 `--userid` 覆盖) | create-report / save-content / get-template / get-user 必需;list-templates 可选 |

## 持久化方式

### macOS 交互式

```bash
cat >> ~/.zshenv <<'EOF'
export DINGTALK_APPKEY="dingxxxxx"
export DINGTALK_APPSECRET="xxxxxxxxxx"
export DINGTALK_USERID="staff_xxx"
EOF
chmod 600 ~/.zshenv
source ~/.zshenv
```

`~/.zshenv` 比 `~/.zshrc` 更全:zsh 启动时所有模式(login / interactive / script)都读。

### Linux bash 交互式

```bash
cat >> ~/.bash_profile <<'EOF'
export DINGTALK_APPKEY="dingxxxxx"
export DINGTALK_APPSECRET="xxxxxxxxxx"
export DINGTALK_USERID="staff_xxx"
EOF
```

### cron(macOS / Linux 通用)

```cron
# crontab -e
DINGTALK_APPKEY=dingxxxxx
DINGTALK_APPSECRET=xxxxxxxxxx
DINGTALK_USERID=staff_xxx

0 18 * * * /usr/local/bin/node /path/to/dingtalk-log.js create-report \
  --template-id tpl_xxx \
  --contents @/tmp/payload.json
```

cron 默认**不**读 shell rc 文件,凭据必须**显式注入**。

### systemd

`/etc/systemd/system/dingtalk-job.service.d/env.conf`:

```
[Service]
Environment="DINGTALK_APPKEY=dingxxxxx"
Environment="DINGTALK_APPSECRET=xxxxxxxxxx"
Environment="DINGTALK_USERID=staff_xxx"
```

### 容器(Docker / Kubernetes)

```bash
docker run \
  -e DINGTALK_APPKEY=dingxxxxx \
  -e DINGTALK_APPSECRET=xxxxxxxxxx \
  -e DINGTALK_USERID=staff_xxx \
  my-image
```

Kubernetes:用 Secret 挂载为 env,详见 https://kubernetes.io/docs/concepts/configuration/secret/。

## 验证

```bash
# 验证 1: env 已加载
echo "$DINGTALK_APPKEY" | head -c 10  # 显示前 10 字符即可

# 验证 2: 调一次只读接口
node /path/to/dingtalk-log.js list-templates --size 5
```

期望输出:`{"errcode":0,"result":{"template_list":[...]}}`。

## 安全注意

- ✅ token 缓存路径 `~/.cache/dingtalk/token.json`,文件权限 600,目录 700
- ✅ stderr 自动脱敏 access_token / appkey / appsecret(query / JSON / Bearer 三形态)
- ❌ **不要**把凭据写到代码、git 仓库、Slack 消息
- ❌ **不要**通过 CLI flag 传 appkey/appsecret(会进 shell history、`ps aux` 可见)
