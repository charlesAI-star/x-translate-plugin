#!/usr/bin/env bash
#
# 把 Agent 运行时代码部署到独立目录，数据与配置不参与同步。
#
# 开发源：当前仓库的 agent/
# 运行目录：例如 /Users/programs/x-knowledge
#
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

usage() {
  cat <<'USAGE'
用法: scripts/deploy.sh --target <目录> [选项]

选项:
  --target <目录>   运行目录，例如 /Users/programs/x-knowledge
  --dry-run         只打印将要执行的操作，不修改任何文件
  --allow-dirty     允许从有未提交改动的源码部署
  --skip-tests      跳过部署前的 Agent 测试
  -h, --help        显示帮助

部署后的目录:
  <target>/app/          代码（每次同步）
  <target>/config.json   配置（首次创建，之后保留）
  <target>/data/         知识库数据（不参与同步）
  <target>/logs/         日志目录（不参与同步）
  <target>/backups/      代码备份

示例:
  scripts/deploy.sh --target /Users/programs/x-knowledge --dry-run
  scripts/deploy.sh --target /Users/programs/x-knowledge
USAGE
}

TARGET=""
DRY_RUN=0
ALLOW_DIRTY=0
SKIP_TESTS=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      if [ "$#" -lt 2 ]; then
        echo "缺少 --target 的值" >&2
        exit 2
      fi
      TARGET="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "必须指定 --target" >&2
  usage >&2
  exit 2
fi

TARGET="${TARGET%/}"
TARGET_PARENT="$(dirname "$TARGET")"
if [ ! -d "$TARGET_PARENT" ]; then
  echo "目标目录的父目录不存在: $TARGET_PARENT" >&2
  exit 1
fi
if [ ! -d "$TARGET" ]; then
  echo "目标目录不存在: $TARGET" >&2
  echo "请先创建它；部署脚本不会自动创建目标根目录。" >&2
  exit 1
fi
TARGET="$(cd "$TARGET" && pwd -P)"

case "$TARGET/" in
  "$SOURCE_DIR/"*)
    echo "目标目录不能位于源码目录内部: $TARGET" >&2
    exit 1
    ;;
esac
if [ "$TARGET" = "$SOURCE_DIR" ]; then
  echo "目标目录不能是源码目录本身" >&2
  exit 1
fi

if [ ! -f "$SOURCE_DIR/server.js" ] || [ ! -f "$SOURCE_DIR/config.example.json" ]; then
  echo "源码目录不完整: $SOURCE_DIR" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "找不到 Node.js: $NODE_BIN" >&2
  exit 1
fi
if ! "$NODE_BIN" --input-type=module -e 'import "node:sqlite";' >/dev/null 2>&1; then
  echo "当前 Node.js 不支持 node:sqlite，请使用 >= 22.13: $("$NODE_BIN" -v 2>/dev/null || echo unknown)" >&2
  exit 1
fi

COMMIT="unknown"
if command -v git >/dev/null 2>&1 && git -C "$SOURCE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  COMMIT="$(git -C "$SOURCE_DIR" rev-parse --short HEAD)"
  if [ "$ALLOW_DIRTY" -ne 1 ] && [ -n "$(git -C "$SOURCE_DIR" status --porcelain)" ]; then
    echo "源码存在未提交改动；请先提交，或加 --allow-dirty。" >&2
    exit 1
  fi
fi

if [ "$SKIP_TESTS" -ne 1 ]; then
  echo "==> 运行 Agent 测试"
  ( cd "$SOURCE_DIR" && "$NODE_BIN" --test test/*.test.js )
fi

APP_DIR="$TARGET/app"
DATA_DIR="$TARGET/data"
LOG_DIR="$TARGET/logs"
BACKUP_DIR="$TARGET/backups"
CONFIG_FILE="$TARGET/config.json"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] 将准备目录: $APP_DIR, $DATA_DIR, $LOG_DIR, $BACKUP_DIR"
else
  mkdir -p "$APP_DIR" "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR"
fi

if [ ! -f "$CONFIG_FILE" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] 将创建配置: $CONFIG_FILE"
  else
    cp "$SOURCE_DIR/config.example.json" "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    echo "已创建配置: ${CONFIG_FILE}（请按需填写 token；不要提交）"
  fi
else
  echo "保留现有配置: $CONFIG_FILE"
fi

if [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null || true)" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] 将备份代码到: $BACKUP_DIR/app-$STAMP.tgz"
  else
    tar -czf "$BACKUP_DIR/app-$STAMP.tgz" -C "$TARGET" app
    echo "已备份代码: $BACKUP_DIR/app-$STAMP.tgz"
  fi
fi

RSYNC_ARGS=(
  -a
  --delete
  --exclude '.DS_Store'
  --exclude 'data/'
  --exclude 'config.json'
  --exclude 'config.example.json'
  --exclude 'test/'
  --exclude 'scripts/'
  --exclude 'CLAUDE.md'
  --exclude 'node_modules/'
)
if [ "$DRY_RUN" -eq 1 ]; then
  RSYNC_ARGS+=(-n -v)
fi

echo "==> 同步代码: $SOURCE_DIR/ -> $APP_DIR/"
rsync "${RSYNC_ARGS[@]}" "$SOURCE_DIR/" "$APP_DIR/"

echo
if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry-run 完成，未修改任何文件。"
else
  echo "部署完成。"
fi
echo "源码版本: $COMMIT"
echo "配置: ${CONFIG_FILE}（不会覆盖已有文件）"
echo "数据: ${DATA_DIR}（不参与同步）"
echo "启动: KB_CONFIG=\"$CONFIG_FILE\" KB_DATA_DIR=\"$DATA_DIR\" node \"$APP_DIR/server.js\""
echo "检查: curl http://127.0.0.1:8787/health（端口以 config.json 为准）"
