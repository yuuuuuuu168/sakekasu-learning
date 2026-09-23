#!/usr/bin/env python3
"""draw.io CLI で書き出した PNG の埋め込みデータを、VS Code の Draw.io 拡張でも開ける形に直す。

draw.io の CLI（--embed-diagram）は図の XML を zTXt チャンク（キー: mxGraphModel）に入れる。
VS Code の Draw.io 拡張は draw.io の Web 版と同じ tEXt チャンク（キー: mxfile、URL エンコード）を読むため、
そのままだと空の図として開かれる。zTXt を tEXt に置き換える。

使い方: python3 scripts/drawio-png-compat.py <file.drawio.png> [...]
"""
import struct
import sys
import urllib.parse
import zlib


def chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def convert(path: str) -> bool:
    data = open(path, "rb").read()
    out = [data[:8]]
    i = 8
    changed = False
    while i < len(data):
        n = struct.unpack(">I", data[i : i + 4])[0]
        kind = data[i + 4 : i + 8]
        body = data[i + 8 : i + 8 + n]
        raw = data[i : i + 12 + n]
        i += 12 + n
        if kind == b"zTXt" and body.startswith(b"mxGraphModel\0"):
            xml = zlib.decompress(body[len(b"mxGraphModel\0") + 1 :]).decode("latin1")
            xml = urllib.parse.unquote(xml)
            encoded = urllib.parse.quote(xml, safe="~()*!.'")
            out.append(chunk(b"tEXt", b"mxfile\0" + encoded.encode("ascii")))
            changed = True
        elif kind == b"tEXt" and body.startswith(b"mxfile\0"):
            out.append(raw)
        else:
            out.append(raw)
    if changed:
        open(path, "wb").write(b"".join(out))
    return changed


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(f"{p}: {'converted' if convert(p) else 'unchanged'}")
