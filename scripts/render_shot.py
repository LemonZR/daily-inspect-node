#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
终端原生样式 PNG 渲染器 (供 server.js 自动调用)

复用 daily_inspect.py 的渲染逻辑: pyte 终端仿真 + Pillow 逐字符渲染。
中英混排: ASCII 用等宽字体(Consolas), 中文用系统 CJK 字体(宋体), 解决中文方框问题。
按实际字符宽度累加坐标, 保留 ANSI 颜色与背景色块。

用法:
  python scripts/render_shot.py --jobs <jobs.json>

jobs.json:
{
  "font_size": 14, "theme": "dark", "terminal_cols": 132, "terminal_lines": 80,
  "font_path": "auto", "cjk_font_path": "auto",
  "jobs": [
    {"ansi_file":"...", "png_file":"...", "prompt_line":"root@srv:~# cmd",
     "header":"root@srv  host  |  time  |  cmd", "command":"cmd"}
  ]
}
stdout 输出 JSON: {"ok":N,"failed":N,"results":[...]}
"""

from __future__ import print_function

import argparse
import json
import os
import re
import sys

try:
    import pyte
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:
    sys.stderr.write("缺少 pyte 或 Pillow: %s\n请先安装: pip install pyte==0.8.2 Pillow==9.5.0\n" % exc)
    raise


THEMES = {
    "dark": {
        "bg": (12, 12, 12), "fg": (208, 208, 208),
        "title_bg": (45, 45, 45), "title_fg": (235, 235, 235),
    },
    "light": {
        "bg": (245, 245, 245), "fg": (32, 32, 32),
        "title_bg": (224, 224, 224), "title_fg": (20, 20, 20),
    },
}
ANSI_COLORS = {
    "black": (0, 0, 0), "red": (205, 49, 49), "green": (13, 188, 121),
    "yellow": (229, 229, 16), "blue": (36, 114, 200),
    "magenta": (188, 63, 188), "cyan": (17, 168, 205), "white": (229, 229, 229),
}
BRIGHT_COLORS = {
    "black": (85, 85, 85), "red": (241, 76, 76), "green": (79, 230, 153),
    "yellow": (248, 248, 72), "blue": (99, 157, 246),
    "magenta": (221, 113, 221), "cyan": (90, 214, 241), "white": (255, 255, 255),
}

_probe_img = Image.new("RGB", (8, 8))
_probe_draw = ImageDraw.Draw(_probe_img)

# 随程序自带的字体目录(程序根目录/vendor/linux/fonts), 让 auto 模式在离线、
# 系统未装中文字体时也能找到文泉驿, 真正做到"拷贝整个目录即可运行"。
_BUNDLED_FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor", "linux", "fonts")


def pick_font_path(setting):
    """等宽主字体 (ASCII)"""
    if setting and setting != "auto" and os.path.isfile(setting):
        return setting
    if os.name == "nt":
        candidates = [r"C:\Windows\Fonts\consola.ttf", r"C:\Windows\Fonts\lucon.ttf", r"C:\Windows\Fonts\simsun.ttc"]
    else:
        candidates = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
            # 随包 CJK 字体也含等宽拉丁字形, 作为系统无等宽字体时的兜底
            os.path.join(_BUNDLED_FONT_DIR, "wqy-zenhei.ttc"),
        ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    raise RuntimeError("找不到等宽字体, 请在 settings.shotFontPath 中显式指定字体文件")


def pick_cjk_font_path(setting):
    """中文回退字体"""
    if setting and setting != "auto" and os.path.isfile(setting):
        return setting
    if os.name == "nt":
        candidates = [r"C:\Windows\Fonts\simsun.ttc", r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"]
    else:
        candidates = [
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/arphic/uming.ttc",
            # 随包字体优先于无中文字形的 DejaVu, 避免中文方框
            os.path.join(_BUNDLED_FONT_DIR, "wqy-zenhei.ttc"),
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def is_wide(ch):
    o = ord(ch)
    return ((0x2E80 <= o <= 0x9FFF) or (0xAC00 <= o <= 0xD7AF) or
            (0xF900 <= o <= 0xFAFF) or (0xFF00 <= o <= 0xFF60) or (0x3000 <= o <= 0x303F))


_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def strip_ansi(s):
    return _ANSI_RE.sub("", s)


def display_cols(line):
    """可视宽度: 去掉 ANSI 控制序列后, 中文等宽字符按 2 列计, tab 按 8 列对齐。"""
    col = 0
    for ch in strip_ansi(line):
        if ch == "\t":
            col += 8 - (col % 8)
        elif ch in ("\r", "\n"):
            continue
        else:
            col += 2 if is_wide(ch) else 1
    return col


def measure(text):
    """返回 (最大可视列宽, 行数), 用于按内容自动确定终端尺寸, 避免 pyte 自动折行。"""
    max_cols = 0
    n = 0
    for raw_line in text.split("\n"):
        if raw_line.endswith("\r"):
            raw_line = raw_line[:-1]
        n += 1
        c = display_cols(raw_line)
        if c > max_cols:
            max_cols = c
    return max_cols, n


def text_width(s, font):
    try:
        return _probe_draw.textlength(s, font=font)
    except Exception:
        b = _probe_draw.textbbox((0, 0), s, font=font)
        return b[2] - b[0]


def color_for(spec, theme, bold, default):
    if not spec or spec == "default" or str(spec).startswith("color"):
        return default
    name = str(spec).replace("bright", "")
    table = BRIGHT_COLORS if str(spec).startswith("bright") else ANSI_COLORS
    color = table.get(name, default)
    if bold:
        color = BRIGHT_COLORS.get(name, color)
    return color


def draw_mixed(draw, xy, text, font, cjk_font, fill, cell_w):
    """标题栏混排绘制: CJK 用中文字体但占 2 列宽, 其余按列宽推进, 保证网格对齐。"""
    x, y = xy
    for ch in text:
        if is_wide(ch):
            draw.text((x, y), ch, font=cjk_font, fill=fill)
            x += cell_w * 2
        else:
            draw.text((x, y), ch, font=font, fill=fill)
            x += cell_w
    return x


def render_screen_png(screen, header, font_path, font_size, theme_name, output_path, cjk_font_path=None, notice=""):
    """终端网格渲染: 严格按 pyte 的列坐标定位, 中文占 2 列。
    与 screen.display 导出的 txt 使用同一套列网格, 因此截图排版与 txt 完全一致。"""
    theme = THEMES.get(theme_name, THEMES["dark"])
    font = ImageFont.truetype(font_path, int(font_size))
    cjk_path = cjk_font_path or pick_cjk_font_path(None)
    cjk_font = ImageFont.truetype(cjk_path, int(font_size)) if cjk_path else font

    # 列宽 = 等宽字体单字符宽度; 行高按字体 bbox
    bbox = _probe_draw.textbbox((0, 0), "M", font=font)
    cell_w = max(1, bbox[2] - bbox[0])
    line_h = max(1, bbox[3] - bbox[1]) + 5

    # 用行数 = 最后一个非空行; 宽度 = screen 的终端列数(与 txt 每行等宽一致)
    used_rows = 1
    for y in range(screen.lines):
        row = screen.buffer.get(y, {})
        if any(getattr(cell, "data", "").strip() for cell in row.values()):
            used_rows = y + 1

    pad = 10
    title_h = line_h + 10 if header else 0
    notice_h = line_h + 8 if notice else 0
    grid_w = cell_w * screen.columns

    def text_w(s):
        w = 0
        for ch in s:
            w += cell_w * 2 if is_wide(ch) else cell_w
        return w

    # 标题过长时截断加省略号: 命令全文仍完整出现在终端首行 prompt 里, 不丢信息;
    # 不让标题把图片撑宽。截断提示条是审计信息, 保留全文。
    if text_w(header or "") > grid_w:
        kept, kept_w = "", 0
        for ch in header:
            cw = cell_w * 2 if is_wide(ch) else cell_w
            if kept_w + cw + cell_w * 2 > grid_w:
                break
            kept += ch
            kept_w += cw
        header = kept + "…"
    title_w = max(text_w(header or ""), text_w(notice or ""))
    width = int(pad * 2 + max(grid_w, title_w, 240))
    height = pad * 2 + notice_h + title_h + line_h * used_rows

    image = Image.new("RGB", (width, height), theme["bg"])
    draw = ImageDraw.Draw(image)
    if notice:
        draw.rectangle([0, 0, width - 1, notice_h - 1], fill=theme["title_bg"])
        draw_mixed(draw, (pad, 4), notice, font, cjk_font, (233, 138, 20), cell_w)
    if header:
        draw.rectangle([0, notice_h, width - 1, notice_h + title_h - 1], fill=theme["title_bg"])
        draw_mixed(draw, (pad, notice_h + 5), header, font, cjk_font, theme["title_fg"], cell_w)

    for y in range(used_rows):
        row = screen.buffer.get(y, {})
        top = pad + notice_h + title_h + y * line_h
        for col in sorted(row.keys()):
            cell = row.get(col)
            data = getattr(cell, "data", "") or " "
            # pyte 把宽字符的第二个格子存为空占位符, 跳过由首字符覆盖绘制
            if not data.strip():
                continue
            fg = color_for(getattr(cell, "fg", None), theme, bool(getattr(cell, "bold", False)), theme["fg"])
            bg = color_for(getattr(cell, "bg", None), theme, False, theme["bg"])
            if getattr(cell, "reverse", False):
                fg, bg = bg, fg
            chosen = cjk_font if is_wide(data) else font
            left = pad + col * cell_w
            span = 2 if is_wide(data) else 1
            if bg != theme["bg"]:
                draw.rectangle([left, top, left + cell_w * span, top + line_h - 1], fill=bg)
            draw.text((left, top), data, font=chosen, fill=fg)

    image.save(output_path)


def normalize_newlines(text):
    """把各种换行统一成 CRLF 再喂 pyte。
    终端里 LF(\\n) 只下移一行、不回到行首, 必须 CR(\\r) 才能到第 0 列。
    上游(cleanOutput / demo)可能已把 \\r 去掉, 若直接喂 LF, 每行会从上一行
    末尾列继续, 造成整片右移折行(这是截图错乱的真根因)。"""
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")


def render_job(job, font_path, cjk_font_path, font_size, theme, cols, lines):
    ansi_file = job["ansi_file"]
    with open(ansi_file, "rb") as f:
        text = f.read().decode("utf-8", "replace")

    prompt = job.get("prompt_line") or ""
    full = (prompt.replace("\r", "") + "\r\n" + text) if prompt else text

    # 列宽固定为设定值(真实终端宽度): 超宽的行像真终端一样自动折行,
    # 而不是把图片无限加宽。原始不折行内容仍完整保存在 .txt/.ansi 里。
    cols = max(80, int(cols))
    # 折行后的估算总行数: 每行按 可视列宽/终端宽度 向上取整
    need_lines = 0
    for raw in full.split("\n"):
        need_lines += max(1, -(-display_cols(raw) // cols))
    # 行数是硬上限(真实终端高度): 超长输出像真终端一样只保留末尾若干行,
    # 截图高度可控; 完整内容仍保存在同目录 .txt/.ansi 原始文件里。
    cap = max(1, int(lines))
    truncated = need_lines - cap if need_lines > cap else 0

    screen = pyte.Screen(cols, cap)
    stream = pyte.Stream(screen)
    if prompt:
        stream.feed(prompt.replace("\r", "") + "\r\n")
    try:
        stream.feed(normalize_newlines(text))
    except Exception:
        pass

    out_dir = os.path.dirname(job["png_file"])
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    notice = ""
    if truncated > 0:
        notice = ("输出共 %d 行, 超出截图行数上限 %d, 仅保留末尾内容; "
                  "完整输出见同目录 .txt/.ansi 原始文件" % (need_lines, cap))
    render_screen_png(screen, job.get("header", ""), font_path, font_size, theme, job["png_file"], cjk_font_path, notice)
    return {"png_file": job["png_file"], "ok": True, "truncated": truncated}


def abs_from(base, p):
    """相对路径基于 base(jobs 文件所在目录)解析; auto/空 保留。"""
    if not p or p == "auto":
        return p
    return p if os.path.isabs(p) else os.path.normpath(os.path.join(base, p))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True)
    args = ap.parse_args()

    jobs_path = os.path.abspath(args.jobs)
    base_dir = os.path.dirname(jobs_path)
    with open(jobs_path, "r", encoding="utf-8") as f:
        spec = json.load(f)

    font_size = int(spec.get("font_size", 14))
    theme = spec.get("theme", "dark")
    cols = int(spec.get("terminal_cols", 132))
    lines = int(spec.get("terminal_lines", 80))
    font_path = pick_font_path(abs_from(base_dir, spec.get("font_path")))
    cjk_font_path = pick_cjk_font_path(abs_from(base_dir, spec.get("cjk_font_path")))

    results = []
    ok = failed = 0
    for job in spec.get("jobs", []):
        try:
            job = dict(job)
            job["ansi_file"] = abs_from(base_dir, job.get("ansi_file"))
            job["png_file"] = abs_from(base_dir, job.get("png_file"))
            results.append(render_job(job, font_path, cjk_font_path, font_size, theme, cols, lines))
            ok += 1
        except Exception as exc:
            results.append({"png_file": job.get("png_file", ""), "ok": False, "error": str(exc)})
            failed += 1
    print(json.dumps({"ok": ok, "failed": failed, "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
