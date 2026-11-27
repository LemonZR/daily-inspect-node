#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
证据目录 SQLite 索引 (供 server.js 在每次巡检归档后调用)。

设计原则:
  - 原始文件(manifest.csv / SHA256SUMS / <服务器名称>/*.png|txt|ansi)是权威留证, 永不修改。
  - 本索引只是"可重建的目录", 用于长期每日运行后的快速检索与统计;
    索引损坏或丢失时, 用 --rebuild 从文件重建即可, 不影响留证完整性。
  - 归档按「每天一个目录 + 服务器名称子目录」组织, manifest.csv 用中文表头;
    --rebuild 同时兼容早期「日期/批次/服务器id/raw|shots」布局, 只读不改。

只用 Python 标准库 sqlite3 (离线可用, 零新依赖)。

子命令:
  --init                      建库建表
  --upsert-run <run.json>     写入/更新一个批次(Node 归档后调用)
  --rebuild <evidenceDir>     扫描 evidence 目录, 从文件全量重建索引
  --stats                     打印统计

run.json 结构(由 server.js 生成):
{
  "run_id","date","ts","trigger","servers","commands","ok","failed","shots","duration_ms","dir",
  "rows":[{"seq","server_id","server_name","host","command_id","command_name",
           "command","status","bytes","png","file","ts"}]
}
"""
from __future__ import print_function

import argparse
import json
import os
import sqlite3
import sys

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  date        TEXT,
  ts          INTEGER,
  trigger     TEXT,
  servers     INTEGER,
  commands    INTEGER,
  ok          INTEGER,
  failed      INTEGER,
  shots       INTEGER,
  duration_ms INTEGER,
  dir         TEXT
);
CREATE TABLE IF NOT EXISTS cmds (
  run_id       TEXT,
  seq          TEXT,
  server_id    TEXT,
  server_name  TEXT,
  host         TEXT,
  command_id   TEXT,
  command_name TEXT,
  command      TEXT,
  status       TEXT,
  bytes        INTEGER,
  png          TEXT,
  file         TEXT,
  ts           INTEGER,
  PRIMARY KEY (run_id, server_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_cmds_server  ON cmds(server_id);
CREATE INDEX IF NOT EXISTS idx_cmds_status  ON cmds(status);
CREATE INDEX IF NOT EXISTS idx_runs_date    ON runs(date);
"""


def connect(db_path):
    d = os.path.dirname(os.path.abspath(db_path))
    if d and not os.path.isdir(d):
        os.makedirs(d)
    conn = sqlite3.connect(db_path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.executescript(SCHEMA)
    return conn


def upsert_run(conn, spec):
    run = spec.get("run") or spec
    cur = conn.cursor()
    cur.execute(
        "INSERT OR REPLACE INTO runs(run_id,date,ts,trigger,servers,commands,ok,failed,shots,duration_ms,dir)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (run.get("run_id"), run.get("date"), run.get("ts"), run.get("trigger"),
         run.get("servers"), run.get("commands"), run.get("ok"), run.get("failed"),
         run.get("shots"), run.get("duration_ms"), run.get("dir")))
    # 先删本批次旧明细, 再插入, 保证幂等
    cur.execute("DELETE FROM cmds WHERE run_id=?", (run.get("run_id"),))
    for r in spec.get("rows", []):
        cur.execute(
            "INSERT OR REPLACE INTO cmds(run_id,seq,server_id,server_name,host,command_id,command_name,"
            "command,status,bytes,png,file,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run.get("run_id"), r.get("seq"), r.get("server_id"), r.get("server_name"),
             r.get("host"), r.get("command_id"), r.get("command_name"), r.get("command"),
             r.get("status"), r.get("bytes"), r.get("png"), r.get("file"), r.get("ts")))
    conn.commit()


def _csv_line(line):
    """最小 CSV 行解析(支持引号/逗号/转义双引号), 与前端 parseCsv 等价。"""
    out, cur, inq, i = [], "", False, 0
    while i < len(line):
        c = line[i]
        if c == '"':
            if inq and i + 1 < len(line) and line[i + 1] == '"':
                cur += '"'
                i += 2
                continue
            inq = not inq
            i += 1
            continue
        if c == "," and not inq:
            out.append(cur)
            cur = ""
            i += 1
            continue
        cur += c
        i += 1
    out.append(cur)
    return out


def _manifest_rows(path):
    """从 manifest.csv 读取明细。新旧表头列位一致(见 server.js):
       0 批次/seq, 1 序号/server_id, 2 服务器名称, 3 主机, 4 命令ID,
       5 命令名称, 6 命令, 7 时间, 8 状态, 9 字节数, 10 截图文件,
       11 截图字节数, 12 原始文件
       server_id 取「截图文件」首段目录名(新布局是服务器名称, 旧布局是服务器id)。
    """
    rows = []
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
    except Exception:
        return rows
    for line in lines[1:]:
        c = _csv_line(line)
        if len(c) < 13:
            continue
        ref = c[10] or c[12] or ""
        try:
            seqn = int(c[1])
        except Exception:
            seqn = 0
        rows.append({
            "batch": c[0], "seq": c[1], "seqn": seqn,
            "server_id": ref.split("/")[0], "server_name": c[2], "host": c[3],
            "command_id": c[4], "command_name": c[5], "command": c[6],
            "status": c[8], "bytes": c[9], "png": c[10], "file": c[12],
        })
    return rows


def _spec_from_rows(rows, run, base_ts):
    out = []
    for r in rows:
        out.append({
            "seq": r["seq"], "server_id": r["server_id"],
            "server_name": r["server_name"], "host": r["host"],
            "command_id": r["command_id"], "command_name": r["command_name"],
            "command": r["command"], "status": r["status"], "bytes": r["bytes"],
            "png": r["png"], "file": r["file"],
            "ts": (base_ts or 0) + r.get("seqn", 0),
        })
    return {"run": run, "rows": out}


def rebuild(conn, evidence_dir):
    """扫描 evidence 重建全部索引, 同时支持两种布局(只读, 不改原始留证):
       新: evidence/YYYY-MM-DD/{00_summary.json, manifest.csv, <服务器名称>/...}
           —— 每天一个目录, 多个批次共用一份 manifest, 按「批次」列分组。
       旧: evidence/YYYY-MM-DD/<runId>/{00_summary.json, manifest.csv, <服务器id>/...}
    """
    if not os.path.isdir(evidence_dir):
        return 0
    n = 0
    for date in sorted(os.listdir(evidence_dir)):
        day_dir = os.path.join(evidence_dir, date)
        if not os.path.isdir(day_dir) or len(date) != 10 or date[4] != "-":
            continue
        flat = os.path.join(day_dir, "00_summary.json")
        mf = os.path.join(day_dir, "manifest.csv")
        if os.path.isfile(flat):
            # ---- 新布局 ----
            try:
                with open(flat, "r", encoding="utf-8") as f:
                    s = json.load(f)
            except Exception:
                s = {}
            rows = _manifest_rows(mf)
            batches = s.get("batches") or []
            if not batches:
                batches = [{
                    "tag": None, "runId": s.get("runId", date.replace("-", "")),
                    "ts": s.get("ts"), "trigger": s.get("trigger"),
                    "servers": s.get("servers"), "commands": s.get("commands"),
                    "ok": s.get("ok"), "failed": s.get("failed"), "shots": s.get("shots"),
                    "durationMs": s.get("durationMs"),
                }]
            for b in batches:
                tag = b.get("tag")
                br = [r for r in rows if tag is None or r["batch"] == tag]
                run = {
                    "run_id": b.get("runId"), "date": date, "ts": b.get("ts"),
                    "trigger": b.get("trigger"), "servers": b.get("servers"),
                    "commands": b.get("commands"), "ok": b.get("ok"),
                    "failed": b.get("failed"), "shots": b.get("shots"),
                    "duration_ms": b.get("durationMs"), "dir": date,
                }
                upsert_run(conn, _spec_from_rows(br, run, b.get("ts")))
                n += 1
        else:
            # ---- 旧布局: 日期下每个子目录是一个批次 ----
            for rid in sorted(os.listdir(day_dir)):
                run_dir = os.path.join(day_dir, rid)
                if not os.path.isdir(run_dir):
                    continue
                try:
                    with open(os.path.join(run_dir, "00_summary.json"), "r", encoding="utf-8") as f:
                        s = json.load(f)
                except Exception:
                    s = {}
                rows = _manifest_rows(os.path.join(run_dir, "manifest.csv"))
                # 极早期归档若无 manifest, 回退读各服务器 shots.json
                if not rows:
                    for sv in sorted(os.listdir(run_dir)):
                        sp = os.path.join(run_dir, sv, "shots.json")
                        if not os.path.isfile(sp):
                            continue
                        try:
                            with open(sp, "r", encoding="utf-8") as f:
                                for r in json.load(f):
                                    rows.append({
                                        "seq": r.get("seq"), "seqn": 0,
                                        "server_id": r.get("serverId"), "server_name": r.get("serverName"),
                                        "host": r.get("host"), "command_id": r.get("commandId"),
                                        "command_name": r.get("commandName"), "command": r.get("command"),
                                        "status": r.get("status"), "bytes": r.get("bytes"),
                                        "png": r.get("png"), "file": r.get("file"),
                                    })
                        except Exception:
                            pass
                run = {
                    "run_id": s.get("runId", rid), "date": s.get("date", date),
                    "ts": s.get("ts"), "trigger": s.get("trigger"),
                    "servers": s.get("servers"), "commands": s.get("commands"),
                    "ok": s.get("ok"), "failed": s.get("failed"), "shots": s.get("shots"),
                    "duration_ms": s.get("durationMs"), "dir": date + "/" + rid,
                }
                upsert_run(conn, _spec_from_rows(rows, run, s.get("ts")))
                n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--init", action="store_true")
    ap.add_argument("--upsert-run")
    ap.add_argument("--rebuild")
    ap.add_argument("--stats", action="store_true")
    args = ap.parse_args()

    conn = connect(args.db)
    if args.upsert_run:
        with open(args.upsert_run, "r", encoding="utf-8") as f:
            spec = json.load(f)
        upsert_run(conn, spec)
        print(json.dumps({"ok": True, "action": "upsert"}))
    elif args.rebuild:
        n = rebuild(conn, args.rebuild)
        print(json.dumps({"ok": True, "action": "rebuild", "runs": n}))
    elif args.stats:
        cur = conn.cursor()
        runs = cur.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
        cmds = cur.execute("SELECT COUNT(*) FROM cmds").fetchone()[0]
        bad = cur.execute("SELECT COUNT(*) FROM cmds WHERE status!='ok'").fetchone()[0]
        print(json.dumps({"runs": runs, "commands": cmds, "failed": bad}))
    else:
        print(json.dumps({"ok": True, "action": "init"}))
    conn.close()


if __name__ == "__main__":
    main()
