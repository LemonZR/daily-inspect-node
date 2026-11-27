#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一批归档文件打成标准 zip。
由 server.js 通过 --jobs <json> 调用, 不依赖任何第三方库(只用标准库 zipfile)。
jobs 结构:
  {
    "out":   "压缩包输出绝对路径",
    "files": [ {"src": "源文件绝对路径", "arc": "zip 内相对路径(可含中文)"} ],
    "texts": [ {"arc": "zip 内相对路径", "text": "文本内容(UTF-8)"} ]
  }
中文文件名: Python3 的 zipfile 会自动为非 ASCII 文件名设置 UTF-8 标记(bit 11),
Linux `unzip` 与 Windows 资源管理器均能正确还原, 不会出现乱码。
输出纯 ASCII JSON(ensure_ascii 默认), 规避各平台 stdout 编码差异。
"""
import json
import os
import sys
import zipfile


def main():
    if '--jobs' not in sys.argv:
        print(json.dumps({'ok': False, 'error': 'missing --jobs'}))
        return 1
    spec_path = sys.argv[sys.argv.index('--jobs') + 1]
    with open(spec_path, encoding='utf-8') as fh:
        jobs = json.load(fh)

    out = jobs['out']
    out_dir = os.path.dirname(out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    tmp = out + '.tmp'
    if os.path.exists(tmp):
        os.remove(tmp)

    n_files = 0
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for item in jobs.get('files', []):
            src, arc = item.get('src'), item.get('arc')
            if not src or not arc or not os.path.isfile(src):
                continue
            zf.write(src, arc)
            n_files += 1
        for item in jobs.get('texts', []):
            arc, text = item.get('arc'), item.get('text')
            if not arc or text is None:
                continue
            zf.writestr(arc, text.encode('utf-8'))
            n_files += 1

    if n_files == 0:
        # 空包没有意义, 交给调用方按「无可下载文件」处理
        os.remove(tmp)
        print(json.dumps({'ok': False, 'error': 'no files'}))
        return 2

    os.replace(tmp, out)
    print(json.dumps({'ok': True, 'bytes': os.path.getsize(out), 'files': n_files}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
