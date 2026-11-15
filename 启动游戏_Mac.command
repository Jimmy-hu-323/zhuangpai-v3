#!/bin/bash
# 双击启动撞牌游戏（macOS）
# 用默认浏览器打开本文件夹里的 index.html，不需要联网，也不需要安装任何东西。
cd "$(dirname "$0")" || exit 1
open "index.html"
exit 0
