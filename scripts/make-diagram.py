#!/usr/bin/env python3
"""選択肢ごとの図解を、設計（JSON）から draw.io の図として組み立てて PNG に書き出す。

見た目をそろえるため、図は手で描かずにこのスクリプトで作る。
出来上がった PNG には draw.io のデータが埋め込まれているので、細かい調整は draw.io で開いて直してよい。

使い方:
    python3 scripts/make-diagram.py <設計.json> [...]
    （content/<分野>/<資格>/diagrams/src/<問題番号>-<選択肢番号>.json を
      content/<分野>/<資格>/diagrams/<問題番号>/<選択肢番号>.drawio.png に書き出す）

設計の形式:
{
  "verdict": "correct" | "incorrect",
  "title": "図のタイトル",
  "groups": [{"id": "dev", "label": "開発アカウント", "x": 0, "y": 0, "w": 300, "h": 240}],
  "nodes": [{"id": "s3", "group": "dev", "icon": "s3", "label": "S3", "sub": "補足（改行は \\n）",
             "x": 40, "y": 60, "ng": false, "labelPos": "bottom" | "top" | "right"}],
  "edges": [{"from": "a", "to": "b", "label": "① 取得", "ng": false, "dashed": false,
             "exit": "right" | [x, y], "entry": "left" | [x, y], "labelAt": 0, "labelOffset": -12}],
  "note": "図の下に出す1行のポイント"
}
x / y は group の中での位置（group が無ければ図全体での位置）。
"""
import html
import json
import os
import subprocess
import sys

DRAWIO = "/Applications/draw.io.app/Contents/MacOS/draw.io"
HERE = os.path.dirname(os.path.abspath(__file__))

INK = "#232F3E"
OK = "#1D8102"
NG = "#D13212"

# アイコン名 → (draw.io のスタイル, 幅, 高さ)
RES = "sketch=0;outlineConnect=0;fontColor=#232F3E;strokeColor=#ffffff;dashed=0;html=1;fontSize=12;aspect=fixed;shape=mxgraph.aws4.resourceIcon;"
ICONS = {
    "codepipeline": (RES + "fillColor=#C925D1;resIcon=mxgraph.aws4.codepipeline;", 48, 48),
    "codebuild": (RES + "fillColor=#C925D1;resIcon=mxgraph.aws4.codebuild;", 48, 48),
    "codedeploy": (RES + "fillColor=#C925D1;resIcon=mxgraph.aws4.codedeploy;", 48, 48),
    "cloudformation": (RES + "fillColor=#E7157B;resIcon=mxgraph.aws4.cloudformation;", 48, 48),
    "s3": (RES + "fillColor=#7AA116;resIcon=mxgraph.aws4.s3;", 48, 48),
    "kms": (RES + "fillColor=#DD344C;resIcon=mxgraph.aws4.key_management_service;", 48, 48),
    "iam": (RES + "fillColor=#DD344C;resIcon=mxgraph.aws4.identity_and_access_management;", 48, 48),
    "ecs": (RES + "fillColor=#ED7100;resIcon=mxgraph.aws4.ecs;", 48, 48),
    "lambda": (RES + "fillColor=#ED7100;resIcon=mxgraph.aws4.lambda;", 48, 48),
    "ec2": (RES + "fillColor=#ED7100;resIcon=mxgraph.aws4.ec2;", 48, 48),
    "ssm": (RES + "fillColor=#E7157B;resIcon=mxgraph.aws4.systems_manager;", 48, 48),
    "cloudwatch": (RES + "fillColor=#E7157B;resIcon=mxgraph.aws4.cloudwatch_2;", 48, 48),
    "eventbridge": (RES + "fillColor=#E7157B;resIcon=mxgraph.aws4.eventbridge;", 48, 48),
    "sns": (RES + "fillColor=#E7157B;resIcon=mxgraph.aws4.sns;", 48, 48),
    "vpc_endpoint": ("sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#8C4FFF;strokeColor=none;dashed=0;html=1;fontSize=12;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.endpoints;", 48, 48),
    "role": ("sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#DD344C;strokeColor=none;dashed=0;html=1;fontSize=12;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.role;", 62, 35),
    "policy": ("shape=note;size=12;whiteSpace=wrap;html=1;fillColor=#F2F3F3;strokeColor=#879196;fontColor=#232F3E;fontSize=11;", 48, 48),
    "box": ("rounded=1;whiteSpace=wrap;html=1;fillColor=#F2F3F3;strokeColor=#879196;fontColor=#232F3E;fontSize=12;", 120, 40),
}

GROUP_STYLE = (
    "points=[];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=13;fontStyle=1;"
    "container=1;pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;"
    "grIcon=mxgraph.aws4.group_account;strokeColor=#CD2264;fillColor=none;verticalAlign=top;"
    "align=left;spacingLeft=30;fontColor=#CD2264;dashed=0;"
)

SIDES = {"right": (1, 0.5), "left": (0, 0.5), "top": (0.5, 0), "bottom": (0.5, 1)}


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def label_html(node: dict) -> str:
    text = html.escape(node["label"])
    if node.get("sub"):
        sub = "<br>".join(html.escape(line) for line in node["sub"].split("\n"))
        text += f'<br><font style="font-size:10px" color="#545B64">{sub}</font>'
    if node.get("ng"):
        text = f'<font color="{NG}"><b>✕</b></font> ' + text
    return text


def build(spec: dict) -> str:
    cells = []
    width = spec.get("width", 640)
    verdict_ok = spec["verdict"] == "correct"
    color = OK if verdict_ok else NG
    badge = "✓ 正解の構成" if verdict_ok else "✕ 不正解"

    cells.append(
        f'<mxCell id="badge" value="{esc(badge)}" style="rounded=1;arcSize=30;html=1;fontSize=12;fontStyle=1;'
        f'fillColor={color};strokeColor=none;fontColor=#ffffff;align=center;verticalAlign=middle;" vertex="1" parent="1">'
        f'<mxGeometry x="0" y="0" width="{110 if verdict_ok else 80}" height="26" as="geometry"/></mxCell>'
    )
    cells.append(
        f'<mxCell id="title" value="{esc(spec["title"])}" style="text;html=1;fontSize=14;fontStyle=1;align=left;'
        f'verticalAlign=middle;fontColor={INK};" vertex="1" parent="1">'
        f'<mxGeometry x="{124 if verdict_ok else 94}" y="0" width="{width - 124}" height="26" as="geometry"/></mxCell>'
    )

    top = 40
    bottom = top
    for g in spec.get("groups", []):
        cells.append(
            f'<mxCell id="{g["id"]}" value="{esc(g["label"])}" style="{GROUP_STYLE}" vertex="1" parent="1">'
            f'<mxGeometry x="{g["x"]}" y="{g["y"] + top}" width="{g["w"]}" height="{g["h"]}" as="geometry"/></mxCell>'
        )
        bottom = max(bottom, g["y"] + top + g["h"])

    for n in spec["nodes"]:
        style, w, h = ICONS[n["icon"]]
        pos = n.get("labelPos", "bottom")
        if n["icon"] == "box":
            if n.get("ng"):
                style = style.replace("strokeColor=#879196", f"strokeColor={NG}").replace("fillColor=#F2F3F3", "fillColor=#FDEFEE")
            value = esc(label_html(n))
            w, h = n.get("w", w), n.get("h", h)
        else:
            if pos == "bottom":
                style += "verticalLabelPosition=bottom;verticalAlign=top;align=center;"
            elif pos == "top":
                style += "verticalLabelPosition=top;verticalAlign=bottom;align=center;"
            elif pos == "right":
                style += "labelPosition=right;verticalLabelPosition=middle;verticalAlign=middle;align=left;spacingLeft=4;"
            value = esc(label_html(n))
        parent = n.get("group", "1")
        y = n["y"] + (0 if n.get("group") else top)
        cells.append(
            f'<mxCell id="{n["id"]}" value="{value}" style="{style}" vertex="1" parent="{parent}">'
            f'<mxGeometry x="{n["x"]}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>'
        )
        if not n.get("group"):
            bottom = max(bottom, y + h + 40)

    for i, e in enumerate(spec.get("edges", [])):
        ng = e.get("ng", False)
        stroke = NG if ng else INK
        style = (
            f"edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;strokeWidth=2;strokeColor={stroke};"
            f"fontSize=11;fontColor={stroke};labelBackgroundColor=#ffffff;"
        )
        if ng or e.get("dashed"):
            style += "dashed=1;"
        if "exit" in e:
            x, y = SIDES[e["exit"]] if isinstance(e["exit"], str) else e["exit"]
            style += f"exitX={x};exitY={y};exitDx=0;exitDy=0;"
        if "entry" in e:
            x, y = SIDES[e["entry"]] if isinstance(e["entry"], str) else e["entry"]
            style += f"entryX={x};entryY={y};entryDx=0;entryDy=0;"
        label = e.get("label", "")
        if ng and label and not label.startswith("✕"):
            label = "✕ " + label
        parent = e.get("parent", "1")
        cells.append(
            f'<mxCell id="e{i}" value="{esc(label)}" style="{style}" edge="1" parent="{parent}" '
            f'source="{e["from"]}" target="{e["to"]}">'
            f'<mxGeometry x="{e.get("labelAt", 0)}" relative="1" as="geometry">'
            f'<mxPoint y="{e.get("labelOffset", -12)}" as="offset"/></mxGeometry></mxCell>'
        )

    note_y = bottom + 12
    cells.append(
        f'<mxCell id="note" value="{esc(spec["note"])}" style="rounded=1;whiteSpace=wrap;html=1;fontSize=11;'
        f'align=left;spacingLeft=10;spacingRight=10;fillColor={"#EFF8EC" if verdict_ok else "#FDEFEE"};'
        f'strokeColor={color};fontColor={INK};" vertex="1" parent="1">'
        f'<mxGeometry x="0" y="{note_y}" width="{width}" height="{spec.get("noteHeight", 36)}" as="geometry"/></mxCell>'
    )

    body = "\n".join(cells)
    return (
        '<mxfile host="drawio"><diagram id="d" name="図解">'
        '<mxGraphModel grid="0" page="0" adaptiveColors="auto"><root>'
        '<mxCell id="0"/><mxCell id="1" parent="0"/>\n'
        f"{body}\n"
        "</root></mxGraphModel></diagram></mxfile>\n"
    )


def output_path(spec_path: str) -> str:
    src_dir = os.path.dirname(os.path.abspath(spec_path))
    diagrams_dir = os.path.dirname(src_dir)
    name = os.path.splitext(os.path.basename(spec_path))[0]
    question_id, choice = name.rsplit("-", 1)
    out_dir = os.path.join(diagrams_dir, question_id)
    os.makedirs(out_dir, exist_ok=True)
    return os.path.join(out_dir, f"{choice}.drawio.png")


def main(paths: list[str]) -> None:
    for spec_path in paths:
        spec = json.load(open(spec_path, encoding="utf-8"))
        out = output_path(spec_path)
        tmp = out.replace(".drawio.png", ".drawio")
        open(tmp, "w", encoding="utf-8").write(build(spec))
        subprocess.run([DRAWIO, "-x", "-f", "png", "-e", "-s", "2", "-b", "12", "-o", out, tmp],
                       check=True, capture_output=True)
        os.remove(tmp)
        subprocess.run([sys.executable, os.path.join(HERE, "drawio-png-compat.py"), out], check=True,
                       capture_output=True)
        print(f"{spec_path} -> {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
