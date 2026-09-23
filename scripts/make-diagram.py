#!/usr/bin/env python3
"""選択肢ごとの図解を、設計（JSON）から draw.io の図として組み立てて PNG に書き出す。

見た目をそろえるため、図は手で描かずにこのスクリプトで作る。
出来上がった PNG には draw.io のデータが埋め込まれているので、細かい調整は draw.io で開いて直してよい。

使い方:
    python3 scripts/make-diagram.py <設計.json> [...]
    （content/<分野>/<資格>/diagrams/src/<問題番号>_選択肢<番号>.json を
      content/<分野>/<資格>/diagrams/<問題番号>/<問題番号>_選択肢<番号>_<正解|不正解>.drawio.png に書き出す）
    選択肢の番号は md の元の番号（画面の A, B, C とは別）。

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
SHAPE = "sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;strokeColor=none;dashed=0;html=1;fontSize=12;aspect=fixed;pointerEvents=1;"

# サービスアイコン（色付きの四角）: 名前 → (resIcon, 色)
SERVICES = {
    # 開発者ツール
    "codepipeline": ("codepipeline", "#C925D1"), "codebuild": ("codebuild", "#C925D1"),
    "codedeploy": ("codedeploy", "#C925D1"), "codecommit": ("codecommit", "#C925D1"),
    "codestar": ("codestar", "#C925D1"), "cloud9": ("cloud9", "#C925D1"), "xray": ("xray", "#C925D1"),
    # 管理・ガバナンス
    "cloudformation": ("cloudformation", "#E7157B"), "cloudwatch": ("cloudwatch_2", "#E7157B"),
    "cloudtrail": ("cloudtrail", "#E7157B"), "config": ("config", "#E7157B"),
    "ssm": ("systems_manager", "#E7157B"), "organizations": ("organizations", "#E7157B"),
    "control_tower": ("control_tower", "#E7157B"), "service_catalog": ("service_catalog", "#E7157B"),
    "trusted_advisor": ("trusted_advisor", "#E7157B"), "opsworks": ("opsworks", "#E7157B"),
    "health": ("personal_health_dashboard", "#E7157B"),
    # アプリケーション統合
    "eventbridge": ("eventbridge", "#E7157B"), "sns": ("sns", "#E7157B"), "sqs": ("sqs", "#E7157B"),
    "step_functions": ("step_functions", "#E7157B"), "api_gateway": ("api_gateway", "#E7157B"),
    # コンピューティング・コンテナ
    "ec2": ("ec2", "#ED7100"), "lambda": ("lambda", "#ED7100"), "ecs": ("ecs", "#ED7100"),
    "eks": ("eks", "#ED7100"), "fargate": ("fargate", "#ED7100"), "ecr": ("ecr", "#ED7100"),
    "elastic_beanstalk": ("elastic_beanstalk", "#ED7100"), "auto_scaling": ("auto_scaling2", "#ED7100"),
    "serverless_app_repo": ("serverless_application_repository", "#ED7100"),
    # ストレージ・データベース
    "s3": ("s3", "#7AA116"), "efs": ("elastic_file_system", "#7AA116"), "backup": ("backup", "#7AA116"),
    "dynamodb": ("dynamodb", "#C925D1"), "rds": ("rds", "#C925D1"), "aurora": ("aurora", "#C925D1"),
    # ネットワーク
    "elb": ("elastic_load_balancing", "#8C4FFF"), "route53": ("route_53", "#8C4FFF"),
    "cloudfront": ("cloudfront", "#8C4FFF"),
    # セキュリティ
    "kms": ("key_management_service", "#DD344C"), "iam": ("identity_and_access_management", "#DD344C"),
    "secrets_manager": ("secrets_manager", "#DD344C"), "inspector": ("inspector", "#DD344C"),
    "guardduty": ("guardduty", "#DD344C"), "security_hub": ("security_hub", "#DD344C"),
    "sso": ("single_sign_on", "#DD344C"), "acm": ("certificate_manager", "#DD344C"),
    "waf": ("waf", "#DD344C"), "macie": ("macie", "#DD344C"),
    "ram": ("resource_access_manager", "#DD344C"),
    # 分析
    "kinesis": ("kinesis", "#8C4FFF"), "kinesis_streams": ("kinesis_data_streams", "#8C4FFF"),
    "firehose": ("kinesis_data_firehose", "#8C4FFF"), "athena": ("athena", "#8C4FFF"),
    "glue": ("glue", "#8C4FFF"), "opensearch": ("elasticsearch_service", "#8C4FFF"),
    "quicksight": ("quicksight", "#8C4FFF"),
}

# リソースアイコン（背景なし）: 名前 → (shape, 色, 幅, 高さ)
RESOURCES = {
    "role": ("role", "#DD344C", 62, 35),
    "user": ("user", "#232F3E", 40, 40),
    "users": ("users", "#232F3E", 48, 48),
    "client": ("client", "#232F3E", 48, 48),
    "server": ("traditional_server", "#232F3E", 36, 48),
    "datacenter": ("corporate_data_center", "#232F3E", 48, 48),
    "instances": ("instances", "#ED7100", 48, 48),
    "ecs_service": ("ecs_service", "#ED7100", 48, 48),
    "lambda_function": ("lambda_function", "#ED7100", 48, 48),
    "ami": ("ami", "#ED7100", 48, 48),
    "alarm": ("alarm", "#E7157B", 48, 48),
    "parameter_store": ("parameter_store", "#E7157B", 44, 48),
    "run_command": ("run_command", "#E7157B", 48, 48),
    "patch_manager": ("patch_manager", "#E7157B", 48, 48),
    "state_manager": ("state_manager", "#E7157B", 48, 48),
    "automation": ("automation", "#E7157B", 48, 48),
    "stack": ("stack", "#E7157B", 48, 48),
    "template": ("template", "#E7157B", 40, 48),
    "change_set": ("change_set", "#E7157B", 40, 48),
    "event_rule": ("rule", "#E7157B", 48, 48),
    "topic": ("topic", "#E7157B", 48, 48),
    "queue": ("queue", "#E7157B", 48, 30),
    "bucket": ("bucket", "#7AA116", 48, 48),
    "object": ("object", "#7AA116", 48, 48),
    "alb": ("application_load_balancer", "#8C4FFF", 48, 48),
    "vpc_endpoint": ("endpoints", "#8C4FFF", 48, 48),
    "internet": ("internet_alt1", "#232F3E", 48, 48),
    "data_key": ("data_encryption_key", "#DD344C", 48, 48),
    "artifact": ("artifact", "#C925D1", 48, 48),
}

ICONS = {name: (RES + f"fillColor={color};resIcon=mxgraph.aws4.{res};", 48, 48) for name, (res, color) in SERVICES.items()}
ICONS.update({name: (SHAPE + f"fillColor={color};shape=mxgraph.aws4.{shape};", w, h) for name, (shape, color, w, h) in RESOURCES.items()})
ICONS.update({
    "policy": ("shape=note;size=12;whiteSpace=wrap;html=1;fillColor=#F2F3F3;strokeColor=#879196;fontColor=#232F3E;fontSize=11;", 40, 48),
    "box": ("rounded=1;whiteSpace=wrap;html=1;fillColor=#F2F3F3;strokeColor=#879196;fontColor=#232F3E;fontSize=12;", 120, 40),
})

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
            # 下に付くラベルの高さ（名前 1 行 + 補足の行数）だけ余白を取る。箱や上・右のラベルは余白を小さく
            if n["icon"] == "box" or pos in ("top", "right"):
                margin = 8
            else:
                margin = 24 + 15 * (len(n["sub"].split("\n")) if n.get("sub") else 0)
            bottom = max(bottom, y + h + margin)

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


def output_path(spec_path: str, spec: dict) -> str:
    src_dir = os.path.dirname(os.path.abspath(spec_path))
    diagrams_dir = os.path.dirname(src_dir)
    name = os.path.splitext(os.path.basename(spec_path))[0]
    question_id, sep, choice = name.rpartition("_選択肢")
    if not sep or not choice.isdigit():
        raise SystemExit(f"{spec_path}: ファイル名は <問題番号>_選択肢<番号>.json にしてください")
    verdict = "正解" if spec["verdict"] == "correct" else "不正解"
    out_dir = os.path.join(diagrams_dir, question_id)
    os.makedirs(out_dir, exist_ok=True)
    # 正解/不正解が変わったときに古い名前のファイルが残らないようにする
    for old in ("正解", "不正解"):
        stale = os.path.join(out_dir, f"{question_id}_選択肢{choice}_{old}.drawio.png")
        if old != verdict and os.path.exists(stale):
            os.remove(stale)
    return os.path.join(out_dir, f"{question_id}_選択肢{choice}_{verdict}.drawio.png")


def main(paths: list[str]) -> None:
    for spec_path in paths:
        spec = json.load(open(spec_path, encoding="utf-8"))
        out = output_path(spec_path, spec)
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
